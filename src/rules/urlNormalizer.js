// Build a stable parent key from a Vinted search URL by stripping
// volatile params and those intended to vary across children (price, sort, page).
// Also normalizes common aliases and ordering of multi-value params.

const STRIP_KEYS = new Set([
  'price_from', 'price_to', 'order', 'sort', 'page', '_t', 'time', 'cursor', 'ref', 'utm_source', 'utm_medium', 'utm_campaign', 'search_id'
]);
const ARRAY_KEYS = new Set([
  'catalog[]', 'size_ids[]', 'brand_ids[]', 'status_ids[]', 'color_ids[]', 'material_ids[]'
]);

function normalizeArray(values) {
  return Array.from(new Set(values.filter(Boolean).map(String))).sort();
}

export function buildParentKey(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    const params = new URLSearchParams(u.search);
    // collect into ordered object
    const norm = {};
    for (const [k, v] of params.entries()) {
      if (STRIP_KEYS.has(k)) continue;
      if (ARRAY_KEYS.has(k)) {
        norm[k] = norm[k] || [];
        norm[k].push(v);
      } else {
        norm[k] = String(v || '');
      }
    }
    // normalize array keys deterministically
    for (const k of Object.keys(norm)) {
      if (ARRAY_KEYS.has(k)) norm[k] = normalizeArray(norm[k]);
    }
    // construct a canonical string key
    const parts = [];
    const keys = Object.keys(norm).sort();
    for (const k of keys) {
      const v = norm[k];
      if (Array.isArray(v)) parts.push(`${k}=${v.join(',')}`);
      else parts.push(`${k}=${v}`);
    }
    // include host + pathname to avoid cross-site collisions
    return `${u.host}${u.pathname}?${parts.join('&')}`;
  } catch {
    return String(rawUrl || '');
  }
}

// Family key: broader grouping that intentionally ignores catalogs as well,
// so variants like shirts/trackpants can form one family under a single parent.
export function buildFamilyKey(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    const params = new URLSearchParams(u.search);
    const norm = {};
    for (const [k, v] of params.entries()) {
      if (STRIP_KEYS.has(k)) continue;
      if (k === 'catalog[]') continue; // ignore catalogs for family grouping
      if (String(process.env.FANOUT_IGNORE_TEXT || '1') === '1' && k === 'search_text') continue;
      if (String(process.env.FANOUT_IGNORE_CURRENCY || '1') === '1' && k === 'currency') continue;
      // treat detail filters as child-level: ignore in family key
      if (k === 'size_ids[]' || k === 'status_ids[]' || k === 'color_ids[]' || k === 'material_ids[]') continue;
      if (ARRAY_KEYS.has(k)) {
        norm[k] = norm[k] || [];
        norm[k].push(v);
      } else {
        norm[k] = String(v || '');
      }
    }
    for (const k of Object.keys(norm)) {
      if (ARRAY_KEYS.has(k)) norm[k] = normalizeArray(norm[k]);
    }
    const parts = [];
    const keys = Object.keys(norm).sort();
    for (const k of keys) {
      const v = norm[k];
      if (Array.isArray(v)) parts.push(`${k}=${v.join(',')}`);
      else parts.push(`${k}=${v}`);
    }
    return `${u.host}${u.pathname}?${parts.join('&')}`;
  } catch {
    return String(rawUrl || '');
  }
}

// Extract rule filters for fanout matching
export function parseRuleFilters(rawUrl) {
  const u = new URL(String(rawUrl || ''));
  const p = new URLSearchParams(u.search);
  const arr = (k) => p.getAll(k).map(x => String(x || '')).filter(Boolean);
  // accept multiple param spellings
  let catalogs = arr('catalog[]');
  if (!catalogs.length) catalogs = arr('catalog_ids[]');
  if (!catalogs.length) catalogs = (p.get('catalog_ids') || '').split(',').map(s=>s.trim()).filter(Boolean);
  if (!catalogs.length) catalogs = (p.get('catalog') || '').split(',').map(s=>s.trim()).filter(Boolean);
  const one = (k) => (p.get(k) || '').trim();
  return {
    text: one('search_text'),
    catalogs,
    sizeIds: arr('size_ids[]'),
    brandIds: arr('brand_ids[]'),
    statusIds: arr('status_ids[]'),
    colorIds: arr('color_ids[]'),
    materialIds: arr('material_ids[]'),
    currency: one('currency') || undefined,
    priceFrom: one('price_from') ? Number(one('price_from')) : undefined,
    priceTo: one('price_to') ? Number(one('price_to')) : undefined,
  };
}

// Lightweight match function to check if an item satisfies child filters.
// We rely on best-effort fields present in the Vinted API item payload.
export function itemMatchesFilters(item, filters) {
  try {
    // Price bounds (if provided)
    const priceRaw = item?.price?.amount ?? item?.price_numeric ?? item?.price ?? null;
    const price = priceRaw != null ? Number(String(priceRaw).replace(/,/, '.')) : NaN;
    if (!Number.isNaN(price)) {
      if (typeof filters.priceFrom === 'number' && price < filters.priceFrom) return false;
      if (typeof filters.priceTo === 'number' && price > filters.priceTo) return false;
    }
    // Catalogs (if provided)
    const REQ_CAT = String(process.env.FANOUT_REQUIRE_CATALOG_MATCH || '0') === '1';
    if (REQ_CAT && filters.catalogs?.length) {
      const cid = String(item?.catalog_id ?? item?.catalog?.id ?? '');
      if (!cid || !filters.catalogs.includes(cid)) return false;
    }
    // Text search (optional, best-effort)
    if (filters.text) {
      const t = String(filters.text).toLowerCase().split(/\s+/).filter(Boolean);
      const hay = `${item?.title || ''} ${item?.description || ''}`.toLowerCase();
      for (const w of t) if (!hay.includes(w)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
