import fs from 'fs';
import path from 'path';

// Optional explicit families via config/families.json
// Accepts both formats:
// 1) Array form: [ { parent: "ruleName", children: ["childRuleName", ...] } ]
// 2) Object form: { "familyKey": { channels: ["childRuleName", ...] }, ... }
export function loadFamiliesFromConfig(searches) {
  const file = path.resolve('./config/families.json');
  if (!fs.existsSync(file)) return [];
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return []; }
  const byName = new Map();
  for (const r of (searches || [])) byName.set(String(r.channelName), r);

  const makeFamily = (parentName, childNames = []) => {
    const p = byName.get(String(parentName));
    if (!p) return null;
    const kids = [];
    for (const name of (childNames || [])) {
      const c = byName.get(String(name));
      if (c) kids.push({ rule: c });
    }
    return { parent: p, parentFilters: null, children: kids };
  };

  const out = [];
  if (Array.isArray(cfg)) {
    for (const fam of cfg) {
      const f = makeFamily(fam?.parent, fam?.children);
      if (f) out.push(f);
    }
  } else if (cfg && typeof cfg === 'object') {
    for (const [key, def] of Object.entries(cfg)) {
      const f = makeFamily(key, def?.channels);
      if (f) out.push(f);
    }
  }
  return out;
}

