import fam from '../../config/families.json' assert { type: 'json' };

function mapByName() {
  try { return globalThis.ruleChannelIdMap instanceof Map ? globalThis.ruleChannelIdMap : new Map(); } catch { return new Map(); }
}

export function familyForRule(ruleName) {
  const name = String(ruleName || '');
  // Exact family key match or membership
  for (const key of Object.keys(fam || {})) {
    if (key === name) return key;
    const arr = Array.isArray(fam[key]?.channels) ? fam[key].channels : [];
    if (arr.includes(name)) return key;
  }
  // Heuristic: take prefix up to first '-' if ends with '-all' or contains '-all-'
  if (name.includes('-all')) return name.split('-all')[0] + '-all';
  return name; // fallback: its own family
}

export function channelsForFamily(familyKey) {
  const key = String(familyKey || '');
  const def = fam?.[key]?.channels;
  const list = Array.isArray(def) && def.length ? def : [key];
  return list;
}

export function channelIdsForFamily(familyKey) {
  const byName = mapByName();
  const names = channelsForFamily(familyKey);
  const ids = [];
  for (const n of names) {
    const id = byName.get(String(n));
    if (id) ids.push(String(id));
  }
  return ids;
}

