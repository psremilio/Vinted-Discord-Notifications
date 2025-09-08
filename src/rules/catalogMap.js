import fs from 'fs';
import path from 'path';
import { getLearnedChildren } from './catalogLearn.js';

let tree = null; // Map<string, Set<string>> parent -> direct children set
let closureCache = new Map(); // Map<string, Set<string>> base -> closure

function loadTree() {
  if (tree) return tree;
  const file = path.resolve('./config/catalog_map.json');
  let raw = {};
  try {
    if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf-8')) || {};
  } catch {
    raw = {};
  }
  const m = new Map();
  for (const [p, arr] of Object.entries(raw)) {
    const set = new Set();
    if (Array.isArray(arr)) for (const v of arr) set.add(String(v));
    m.set(String(p), set);
  }
  tree = m;
  return tree;
}

function computeClosureFor(id) {
  const t = loadTree();
  const key = String(id);
  if (closureCache.has(key)) return new Set(closureCache.get(key));
  const out = new Set([key]);
  const stack = [key];
  while (stack.length) {
    const cur = stack.pop();
    const kids = t.get(cur);
    if (!kids) continue;
    for (const ch of kids) if (!out.has(ch)) { out.add(ch); stack.push(ch); }
  }
  closureCache.set(key, new Set(out));
  return out;
}

export function expandCatalogs(ids) {
  const strat = String(process.env.CATALOG_MATCH_STRATEGY || 'subtree');
  const list = (ids || []).map(String).filter(Boolean);
  if (strat !== 'subtree') return new Set(list);
  const set = new Set();
  for (const id of list) {
    const clos = computeClosureFor(id);
    for (const v of clos) set.add(String(v));
    // Merge learned children (heuristic) as a fallback to empty static map
    try { for (const v of getLearnedChildren(id)) set.add(String(v)); } catch {}
  }
  return set.size ? set : new Set(list);
}
