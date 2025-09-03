import { buildParentKey, buildFamilyKey, parseRuleFilters } from './urlNormalizer.js';
const FANOUT_DEBUG = String(process.env.FANOUT_DEBUG || process.env.LOG_FANOUT || '0') === '1';
const ll = (...a) => { if (FANOUT_DEBUG) console.log(...a); };

function scoreBroadness(filters) {
  // Lower score = broader rule. Penalize constraints presence, but prefer
  // larger catalog sets (broader coverage) when catalogs exist.
  let s = 0;
  if (typeof filters.priceFrom === 'number') s += 2;
  if (typeof filters.priceTo === 'number') s += 2;
  if (filters.text) s += 1;
  if (filters.brandIds?.length) s += 1;
  if (filters.sizeIds?.length) s += 1;
  if (filters.statusIds?.length) s += 1;
  if (filters.colorIds?.length) s += 0.5;
  if (filters.materialIds?.length) s += 0.5;
  // catalogs present → small penalty, but subtract a tiny tie-breaker favoring more catalogs
  const cLen = (filters.catalogs?.length || 0);
  if (cLen > 0) s += 0.5 - Math.min(0.49, cLen * 0.01);
  return s;
}

export function buildParentGroups(rules) {
  const groupsByKey = new Map();
  for (const r of (rules || [])) {
    try {
      const strat = String(process.env.PARENTING_STRATEGY || 'mapped');
      // Back-compat: allow FANOUT_AUTO_GROUP=0 to force exact_url behavior
      const autoFamily = (strat !== 'exact_url') && (String(process.env.FANOUT_AUTO_GROUP || '1') === '1');
      const raw = r.url || r.channelUrl || r.ruleUrl || r.channel?.url || r.link;
      const parentKey = buildParentKey(raw);
      const key = autoFamily ? buildFamilyKey(raw) : parentKey;
      if (!groupsByKey.has(key)) groupsByKey.set(key, []);
      const filters = parseRuleFilters(r.url || r.channelUrl || r.ruleUrl || r.link);
      groupsByKey.get(key).push({ rule: r, filters });
      ll('[fanout.key]', r.channelName, 'canonical_url=', parentKey, 'familyKey=', key);
    } catch {}
  }

  const families = [];
  for (const [, arr] of groupsByKey.entries()) {
    if (!arr.length) continue;
    // pick broadest as parent by minimal score; tie-breaker: widest price bounds
    let parentIdx = 0;
    let bestScore = Infinity;
    for (let i = 0; i < arr.length; i++) {
      const sc = scoreBroadness(arr[i].filters);
      if (sc < bestScore) { bestScore = sc; parentIdx = i; }
    }
    // normalize parent & children
    const parent = arr[parentIdx];
    const children = arr.filter((_, i) => i !== parentIdx);
    families.push({ parent: parent.rule, parentFilters: parent.filters, children: children.map(c => ({ rule: c.rule, filters: c.filters })) });
    ll('[fanout.pick]', 'parent=', parent.rule.channelName, 'children=', (children.map(c=>c.rule.channelName).join(',')) || '');
  }
  return families;
}

// explicit overrides via env: FANOUT_PARENT_RULE, FANOUT_CHILD_RULES (CSV of names)
export function buildExplicitFamily(rules, parentName, childrenCsv) {
  const byName = new Map();
  for (const r of (rules || [])) byName.set(String(r.channelName || r.name), r);
  const parent = byName.get(String(parentName || ''));
  if (!parent) return null;
  const children = String(childrenCsv || '').split(',').map(s => s.trim()).filter(Boolean).map(n => byName.get(n)).filter(Boolean);
  return [{ parent, parentFilters: parseRuleFilters(parent.url), children: children.map(rule => ({ rule, filters: parseRuleFilters(rule.url) })) }];
}

// Zero-config price-family grouping based on canonical signature excluding price
function normalizeArr(v) { const a = Array.isArray(v) ? v.map(String) : []; return Array.from(new Set(a)).sort(); }
export function canonicalSignature(rule) {
  try {
    const f = parseRuleFilters(rule.url || rule.link || '');
    const sig = {
      brand: normalizeArr(f.brandIds),
      catalog: normalizeArr(f.catalogs),
      size: normalizeArr(f.sizeIds),
      status: normalizeArr(f.statusIds),
      text: String((f.text || '').trim().toLowerCase()),
      cur: String(f.currency || 'EUR').toUpperCase(),
    };
    return `b=${sig.brand.join(',')}|c=${sig.catalog.join(',')}|s=${sig.size.join(',')}|st=${sig.status.join(',')}|q=${sig.text}|cur=${sig.cur}`;
  } catch { return 'sig:invalid'; }
}

function pickLeader(members) {
  // Prefer rule without price_to, else greatest price_to
  let leader = members.find(m => (m.filters?.priceTo == null));
  if (!leader) leader = members.slice().sort((a,b)=> (Number(b.filters?.priceTo||0) - Number(a.filters?.priceTo||0)))[0];
  return leader || members[0];
}

function onlyDiffersInPrice(a, b) {
  const keys = ['brandIds','catalogs','sizeIds','statusIds','text','currency'];
  for (const k of keys) {
    const va = JSON.stringify(normalizeArr(a[k]));
    const vb = JSON.stringify(normalizeArr(b[k]));
    if (va !== vb) return false;
  }
  // Require identical price_from; allow only price_to variation
  const pfA = a.priceFrom ?? null; const pfB = b.priceFrom ?? null;
  if ((pfA ?? null) !== (pfB ?? null)) return false;
  return true;
}

export function buildAutoPriceFamilies(rules) {
  const bySig = new Map();
  for (const r of (rules || [])) {
    const f = parseRuleFilters(r.url || r.link || '');
    // Guard: search_text without brand → never group
    if ((f.text || '').trim() && (!Array.isArray(f.brandIds) || f.brandIds.length === 0)) {
      continue;
    }
    const sig = canonicalSignature(r);
    if (!bySig.has(sig)) bySig.set(sig, []);
    bySig.get(sig).push({ rule: r, filters: f });
  }
  const families = [];
  for (const [sig, arr] of bySig.entries()) {
    if (!arr || arr.length < 2) continue; // need at least 2 to form a price family
    // Validate members differ only by price
    const leadCandidate = pickLeader(arr);
    const baseF = leadCandidate.filters;
    const okMembers = arr.filter(m => onlyDiffersInPrice({ ...m.filters }, { ...baseF }));
    if (okMembers.length < 2) continue;
    const leader = pickLeader(okMembers);
    const children = okMembers.filter(m => m !== leader);
    families.push({ parent: leader.rule, parentFilters: leader.filters, children: children.map(c => ({ rule: c.rule, filters: c.filters })) });
    ll('[fanout.auto]', 'sig=', sig, 'parent=', leader.rule.channelName, 'children=', children.map(c=>c.rule.channelName).join(','));
  }
  return families;
}
