// Learn catalog subtree relations from the current configured rules.
// Heuristic: If a brand uses a broad "all" catalog (commonly 2050) and
// there are other rules with the same brand but different catalogs,
// treat those catalogs as descendants of the broad one for matching.

import { parseRuleFilters } from './urlNormalizer.js';

const learned = new Map(); // catalogId -> Set<childCatalogId>

export function clearLearned() { learned.clear(); }

export function getLearnedChildren(cat) {
  const s = learned.get(String(cat));
  return s ? new Set(s) : new Set();
}

export function learnFromRules(searches) {
  try {
    learned.clear();
    const byBrand = new Map(); // brandId -> Set<catalogId>
    for (const r of (searches || [])) {
      try {
        const f = parseRuleFilters(r.url || r.link || '');
        const b = (f.brandIds || [])[0];
        const cats = new Set(f.catalogs || []);
        if (!b || cats.size === 0) continue;
        const key = String(b);
        const set = byBrand.get(key) || new Set();
        for (const c of cats) set.add(String(c));
        byBrand.set(key, set);
      } catch {}
    }
    // For each brand, if it uses 2050 (top-level), add all other brand catalogs as children of 2050
    for (const [, set] of byBrand.entries()) {
      const has2050 = set.has('2050');
      if (!has2050) continue;
      const kids = new Set(Array.from(set).filter(c => c !== '2050'));
      if (!kids.size) continue;
      const cur = learned.get('2050') || new Set();
      for (const k of kids) cur.add(k);
      learned.set('2050', cur);
    }
  } catch {}
}

