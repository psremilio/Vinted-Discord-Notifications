import fs from 'fs';
import path from 'path';

let cache = null; // Map<string, Set<string>> base -> set of aliases (including base)

function load() {
  if (cache) return cache;
  const file = path.resolve('./config/brand_aliases.json');
  let raw = {};
  try {
    if (fs.existsSync(file)) {
      raw = JSON.parse(fs.readFileSync(file, 'utf-8')) || {};
    }
  } catch {
    raw = {};
  }
  const m = new Map();
  for (const [base, arr] of Object.entries(raw)) {
    const set = new Set(String(base) ? [String(base)] : []);
    if (Array.isArray(arr)) for (const v of arr) set.add(String(v));
    m.set(String(base), set);
  }
  cache = m;
  return cache;
}

export function expandBrandIds(ids) {
  const strat = String(process.env.BRAND_MATCH_STRATEGY || 'alias_group');
  const list = (ids || []).map(String).filter(Boolean);
  if (strat !== 'alias_group') return new Set(list);
  const table = load();
  const set = new Set();
  for (const id of list) {
    set.add(String(id));
    const grp = table.get(String(id));
    if (grp) for (const v of grp) set.add(String(v));
  }
  return set;
}

