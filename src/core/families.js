import fs from 'node:fs';
import path from 'node:path';

// Load families config robustly from repo root or env
const root = process.cwd();
const candidates = [
  path.join(root, 'config', 'families.json'),
  path.join(root, 'src', 'config', 'families.json'),
];

let fam = null;
let from = null;
for (const p of candidates) {
  try {
    if (fs.existsSync(p)) {
      fam = JSON.parse(fs.readFileSync(p, 'utf8'));
      from = p;
      try { console.log('[families] loaded', p); } catch {}
      break;
    }
  } catch (e) {
    try { console.warn('[families] parse failed', p, e?.message || e); } catch {}
  }
}
if (!fam && process.env.FAMILIES_JSON) {
  try {
    fam = JSON.parse(process.env.FAMILIES_JSON);
    from = 'env:FAMILIES_JSON';
    try { console.log('[families] loaded from FAMILIES_JSON env'); } catch {}
  } catch (e) {
    try { console.warn('[families] FAMILIES_JSON parse error:', e?.message || e); } catch {}
  }
}
if (!fam) {
  try { console.error('families MISSING config/families.json – bitte Datei im Repo-Root anlegen!'); } catch {}
  throw new Error('Missing config/families.json');
}

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
