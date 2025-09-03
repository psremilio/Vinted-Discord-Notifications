import { buildParentKey, parseRuleFilters } from './urlNormalizer.js';

function scoreBroadness(filters) {
  // Lower score = broader rule
  let s = 0;
  if (typeof filters.priceFrom === 'number') s += 2;
  if (typeof filters.priceTo === 'number') s += 2;
  if (filters.text) s += 1;
  if (filters.catalogs?.length) s += Math.min(3, filters.catalogs.length);
  if (filters.brandIds?.length) s += Math.min(3, filters.brandIds.length);
  if (filters.sizeIds?.length) s += Math.min(2, filters.sizeIds.length);
  if (filters.statusIds?.length) s += 1;
  if (filters.colorIds?.length) s += 1;
  if (filters.materialIds?.length) s += 1;
  return s;
}

export function buildParentGroups(rules) {
  const groupsByKey = new Map();
  for (const r of (rules || [])) {
    try {
      const key = buildParentKey(r.url || r.channelUrl || r.ruleUrl || r.channel?.url || r.link);
      if (!groupsByKey.has(key)) groupsByKey.set(key, []);
      const filters = parseRuleFilters(r.url || r.channelUrl || r.ruleUrl || r.link);
      groupsByKey.get(key).push({ rule: r, filters });
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

