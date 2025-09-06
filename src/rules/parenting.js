import { buildParentKey, buildFamilyKey, parseRuleFilters, canonicalizeSearchURL, familyDimensionFromCanon, buildFamilyKeyFromURL, getParentURLFromChild, canonicalizeForFamily } from './urlNormalizer.js';
import { loadPriceFamilyPolicy } from './policy.js';
const FANOUT_DEBUG = String(process.env.FANOUT_DEBUG || process.env.LOG_FANOUT || '0') === '1';
const ll = (...a) => { if (FANOUT_DEBUG) console.log(...a); };

function hasPrice(filters) { return Number.isFinite(filters?.priceFrom) || Number.isFinite(filters?.priceTo); }
function hasSize(filters) { return Array.isArray(filters?.sizeIds) && filters.sizeIds.length > 0; }
function hasStatus(filters) { return Array.isArray(filters?.statusIds) && filters.statusIds.length > 0; }
function hasCatalog(filters) { return Array.isArray(filters?.catalogs) && filters.catalogs.length > 0; }
export function familyMode(filters) {
  if (hasPrice(filters)) return 'price';
  if (hasSize(filters)) return 'size';
  if (hasStatus(filters)) return 'status';
  return 'none';
}
export function shouldFanoutByFilters(filters) {
  const needCatalog = String(process.env.FAMILY_REQUIRE_CATALOG || '1') === '1';
  const mode = familyMode(filters);
  const ok = (mode !== 'none') && (!needCatalog || hasCatalog(filters));
  return { ok, mode };
}

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
      // Strict family key: host+path+(brand_ids,catalog,currency), ignoring price/size/status/etc.
      const key = autoFamily ? buildFamilyKeyFromURL(raw, 'auto') : parentKey;
      if (!groupsByKey.has(key)) groupsByKey.set(key, []);
      const filters = parseRuleFilters(r.url || r.channelUrl || r.ruleUrl || r.link);
      // Apply family gating: only group non-price dimensions (size/status) here.
      const gate = shouldFanoutByFilters(filters);
      if (!gate.ok || gate.mode === 'price') continue;
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
    // Strict: children must only differ in the parent's family dimension (size/status)
    const mode = familyMode(parent.filters);
    const children = arr.filter((_, i) => i !== parentIdx)
      .filter(c => (mode === 'size' || mode === 'status') && onlyDiffersByDimension(c.filters, parent.filters, mode));
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
      cur: String(f.currency || 'EUR').toUpperCase(),
    };
    return `b=${sig.brand.join(',')}|c=${sig.catalog.join(',')}|s=${sig.size.join(',')}|st=${sig.status.join(',')}|cur=${sig.cur}`;
  } catch { return 'sig:invalid'; }
}

function pickLeader(members) {
  // Prefer rule without price_to, else greatest price_to
  let leader = members.find(m => (m.filters?.priceTo == null));
  if (!leader) leader = members.slice().sort((a,b)=> (Number(b.filters?.priceTo||0) - Number(a.filters?.priceTo||0)))[0];
  return leader || members[0];
}

function onlyDiffersInPrice(a, b) {
  const keys = ['brandIds','catalogs','sizeIds','statusIds','currency'];
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

function onlyDiffersByDimension(a, b, dim) {
  const eqArr = (x, y) => JSON.stringify(normalizeArr(x)) === JSON.stringify(normalizeArr(y));
  // brand/catalog/currency/text must match
  if (!eqArr(a.brandIds, b.brandIds)) return false;
  if (!eqArr(a.catalogs, b.catalogs)) return false;
  if (String(a.currency||'EUR').toUpperCase() !== String(b.currency||'EUR').toUpperCase()) return false;
  if (String(a.text||'') !== String(b.text||'')) return false;
  // Enforce equality for other filters as requested: color/material must match
  if (!eqArr(a.colorIds, b.colorIds)) return false;
  if (!eqArr(a.materialIds, b.materialIds)) return false;
  if (dim === 'size') {
    if (!eqArr(a.statusIds, b.statusIds)) return false;
    if ((a.priceFrom ?? null) !== (b.priceFrom ?? null) || (a.priceTo ?? null) !== (b.priceTo ?? null)) return false;
    // sizes may differ
    return true;
  }
  if (dim === 'status') {
    if (!eqArr(a.sizeIds, b.sizeIds)) return false;
    if ((a.priceFrom ?? null) !== (b.priceFrom ?? null) || (a.priceTo ?? null) !== (b.priceTo ?? null)) return false;
    return true;
  }
  return false;
}

export function buildAutoPriceFamilies(rules) {
  // Strict URL-based grouping: group by brand+catalog(+currency) ignoring price/size/status
  // Include non-price "anchor" rules as parent candidates so that "all" can be chosen as parent.
  const groups = new Map(); // key -> { parentCanonUrl, members: [{rule, filters, canon}], anchors: [{rule, filters}] }
  const policy = loadPriceFamilyPolicy();
  for (const r of (rules || [])) {
    const url = r.url || r.link || '';
    const canon = canonicalizeSearchURL(url);
    const dim = familyDimensionFromCanon(canon);
    // Always separate families by search_text when present to ensure same search intent
    const baseKey = buildFamilyKeyFromURL(url, 'price');
    const txt = String(canon?.text || '').trim().toLowerCase();
    const key = txt ? `${baseKey}&search_text=${encodeURIComponent(txt)}` : baseKey;
    if (!key) continue;
    const parentUrlCanon = getParentURLFromChild(url, 'price');
    if (!groups.has(key)) groups.set(key, { parentCanonUrl: parentUrlCanon, members: [], anchors: [] });
    const filters = parseRuleFilters(url);
    if (dim === 'price') {
      groups.get(key).members.push({ rule: r, filters, canon });
    } else {
      // Keep as potential parent anchor (same family key, but not price-dimension)
      groups.get(key).anchors.push({ rule: r, filters });
    }
  }
  const families = [];
  for (const [key, g] of groups.entries()) {
    const arr = g.members || [];
    if (arr.length < 2) continue; // need at least 2 price variants
    // Pick parent: prefer a non-price anchor ("all"), regardless of size/status; diffs are enforced later at runtime
    const noPrice = (f) => !(Number.isFinite(f.priceFrom) || Number.isFinite(f.priceTo));
    const countFilters = (f) => (Number.isFinite(f.priceFrom)?1:0) + (Number.isFinite(f.priceTo)?1:0) +
      ((Array.isArray(f.sizeIds)&&f.sizeIds.length)?1:0) + ((Array.isArray(f.statusIds)&&f.statusIds.length)?1:0) +
      ((Array.isArray(f.colorIds)&&f.colorIds.length)?1:0) + ((Array.isArray(f.materialIds)&&f.materialIds.length)?1:0);
    // 1) Any non-price anchor (same family key by construction)
    let leader = (g.anchors || []).find(a => noPrice(a.filters));
    // 2) Fallback: least filtered anchor
    if (!leader && (g.anchors || []).length) {
      leader = g.anchors.slice().sort((a,b)=> countFilters(a.filters)-countFilters(b.filters))[0];
    }
    // 3) Fallback to least filtered member that's not pure price-only (still avoid picking a price child as parent)
    // 4) Fallback: member with fewest filters but not pure price-only
    if (!leader) {
      const cand = arr.slice().sort((a,b)=> countFilters(a.filters)-countFilters(b.filters))[0];
      const purePrice = (f) => (Number.isFinite(f.priceFrom) || Number.isFinite(f.priceTo)) &&
        !(Array.isArray(f.sizeIds)&&f.sizeIds.length) && !(Array.isArray(f.statusIds)&&f.statusIds.length) &&
        !(Array.isArray(f.colorIds)&&f.colorIds.length) && !(Array.isArray(f.materialIds)&&f.materialIds.length);
      if (cand && !purePrice(cand.filters)) leader = cand;
    }
    if (!leader) {
      // No acceptable parent → skip this family (avoid price child as parent)
      continue;
    }
    // Policy gating: only allow whitelisted brand ids; require single-brand families when configured
    try {
      const pf = leader.filters || parseRuleFilters(leader.rule?.url || '');
      const brands = Array.isArray(pf.brandIds) ? pf.brandIds.map(String) : [];
      const single = brands.length === 1;
      // Enforce single brand only when brand ids are present; otherwise allow text-only groupings
      if (policy.requireSingleBrand && brands.length > 0 && !single) { ll('[fanout.auto.url.skip]', 'reason=multi_brand', 'key=', key); continue; }
      if (policy.allowedBrandIds.size > 0) {
        const ok = brands.some(b => policy.allowedBrandIds.has(String(b)));
        if (!ok) { ll('[fanout.auto.url.skip]', 'reason=brand_not_allowed', 'key=', key, 'brands=', brands.join(',')); continue; }
      } else if (policy.defaultDenyWhenNoBrands) {
        // Fallback: allow by channel name whitelist when brand ids are unknown
        const nm = String(leader.rule?.channelName || '');
        if (!policy.nameWhitelistRegex.test(nm)) { ll('[fanout.auto.url.skip]', 'reason=name_not_whitelisted', 'key=', key, 'name=', nm); continue; }
      }
    } catch {}
    // Children are strictly the price members
    let children = arr.filter(m => (m.rule !== leader.rule));
    // Optional: enforce allowed price buckets per brand
    try {
      const pf = leader.filters || parseRuleFilters(leader.rule?.url || '');
      const brands = Array.isArray(pf.brandIds) ? pf.brandIds.map(String) : [];
      const brandKey = brands.length ? brands[0] : null;
      const buckets = brandKey ? (policy.bucketsByBrand.get(String(brandKey)) || policy.defaultBuckets) : policy.defaultBuckets;
      if (buckets && buckets.size) {
        children = children.filter(c => {
          const f = c.filters || parseRuleFilters(c.rule?.url || '');
          // Strict: search text must match parent exactly or no family
          if (String(f.text || '') !== String(pf.text || '')) return false;
          const to = typeof f.priceTo === 'number' ? f.priceTo : NaN;
          return Number.isFinite(to) && buckets.has(Number(to));
        });
      }
    } catch {}
    families.push({ parent: leader.rule, parentFilters: leader.filters, children: children.map(c => ({ rule: c.rule, filters: c.filters })) });
    ll('[fanout.auto.url]', 'key=', key, 'parent=', leader.rule.channelName, 'children=', children.map(c=>c.rule.channelName).join(','));
  }
  return families;
}
