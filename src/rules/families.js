import fs from 'fs';
import path from 'path';

// Optional explicit families via config/families.json
// Format: [ { parent: "ruleName", children: ["childRuleName", ...] } ]
export function loadFamiliesFromConfig(searches) {
  const file = path.resolve('./config/families.json');
  if (!fs.existsSync(file)) return [];
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const byName = new Map();
  for (const r of (searches || [])) byName.set(String(r.channelName), r);
  const out = [];
  for (const fam of raw) {
    const p = byName.get(String(fam?.parent || ''));
    if (!p) continue;
    const kids = [];
    for (const name of (fam.children || [])) {
      const c = byName.get(String(name));
      if (c) kids.push({ rule: c });
    }
    out.push({ parent: p, parentFilters: null, children: kids });
  }
  return out;
}

