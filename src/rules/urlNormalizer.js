// Build a stable parent key from a Vinted search URL by stripping
// volatile params and those intended to vary across children (price, sort, page).
// Also normalizes common aliases and ordering of multi-value params.

const STRIP_KEYS = new Set([
  'order', 'sort', 'page', '_t', 'time', 'cursor', 'ref', 'utm_source', 'utm_medium', 'utm_campaign', 'search_id'
]);
const ARRAY_KEYS = new Set([
  'catalog[]', 'size_ids[]', 'brand_ids[]', 'status_ids[]', 'color_ids[]', 'material_ids[]'
]);

function normalizeArray(values) {
  return Array.from(new Set(values.filter(Boolean).map(String))).sort();
}

export function buildParentKey(rawUrl, opts = {}) {
  try {
    const u = new URL(String(rawUrl || ''));
    const params = new URLSearchParams(u.search);
    // collect into ordered object
    const norm = {};
    for (const [k, v] of params.entries()) {
      if (STRIP_KEYS.has(k)) continue;
      if (opts.stripPrice && (k === 'price_from' || k === 'price_to')) continue;
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
  const strat = String(process.env.PARENTING_STRATEGY || 'mapped');
  if (strat === 'exact_url') return buildParentKey(rawUrl);
  try {
    const u = new URL(String(rawUrl || ''));
    const p = new URLSearchParams(u.search);
    const brands = normalizeArray(p.getAll('brand_ids[]'));
    const cats = normalizeArray(p.getAll('catalog[]'));
    if (!brands.length && !cats.length) return `${u.host}${u.pathname}?INVALID_NO_SCOPE`;
    const parts = [];
    if (brands.length) parts.push(`brand_ids[]=${brands.join(',')}`);
    if (cats.length) parts.push(`catalog[]=${cats.join(',')}`);
    return `${u.host}${u.pathname}?${parts.join('&')}`;
  } catch { return String(rawUrl || ''); }
}

// Canonicalize a Vinted search URL by normalizing parameter order and array values.
// Keeps all parameters (does not strip) but sorts arrays and keys for deterministic storage.
export function canonicalizeUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    const params = new URLSearchParams(u.search);
    const norm = {};
    for (const [k, v] of params.entries()) {
      if (ARRAY_KEYS.has(k)) {
        norm[k] = norm[k] || [];
        norm[k].push(v);
      } else {
        // last write wins for non-array keys
        norm[k] = String(v || '');
      }
    }
    for (const k of Object.keys(norm)) {
      if (ARRAY_KEYS.has(k)) norm[k] = normalizeArray(norm[k]);
    }
    const keys = Object.keys(norm).sort();
    const parts = [];
    for (const k of keys) {
      const v = norm[k];
      if (Array.isArray(v)) {
        for (const it of v) parts.push([k, it]);
      } else {
        parts.push([k, v]);
      }
    }
    const sp = new URLSearchParams();
    for (const [k, v] of parts) sp.append(k, v);
    u.search = sp.toString();
    return u.toString();
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
import { expandBrandIds } from './brandAliases.js';
import { expandCatalogs } from './catalogMap.js';
import { metrics } from '../infra/metrics.js';

export function normalizedPrice(item, preferredCurrency) {
  try {
    const priceObj = item?.price || {};
    const raw = priceObj.amount ?? item?.price_numeric ?? item?.price ?? null;
    const cur = String(priceObj.currency_code || '').toUpperCase();
    const want = String(preferredCurrency || 'EUR').toUpperCase();
    // Prefer converted_amount when targeting EUR
    if (want === 'EUR' && typeof priceObj.converted_amount === 'number') {
      return Number(priceObj.converted_amount);
    }
    // If item already in preferred currency use raw amount
    if (cur && want && cur === want && raw != null) {
      return Number(String(raw).replace(/,/, '.'));
    }
    // Fallback: raw
    return raw != null ? Number(String(raw).replace(/,/, '.')) : NaN;
  } catch {
    return NaN;
  }
}

export function itemMatchesFilters(item, filters) {
  try {
    // Price bounds (if provided) — normalize to requested currency (default EUR)
    const price = normalizedPrice(item, filters?.currency || 'EUR');
    if (!Number.isNaN(price)) {
      if (typeof filters.priceFrom === 'number' && price < filters.priceFrom) return false;
      if (typeof filters.priceTo === 'number' && price > filters.priceTo) return false;
    }
    // Catalogs (if provided)
    const REQ_CAT = String(process.env.FANOUT_REQUIRE_CATALOG_MATCH || '1') === '1';
    // Treat catalog id 2050 as a broad/top-level bucket (brand "all")
    // and do not enforce catalog matching when present. This avoids
    // false negatives during parent→child fanout where children often
    // use catalog=2050 as a catch‑all.
    const catalogs = Array.isArray(filters.catalogs) ? filters.catalogs.map(String) : [];
    const HAS_WILDCARD_2050 = catalogs.includes('2050');
    if (REQ_CAT && catalogs.length && !HAS_WILDCARD_2050) {
      const cid = String(item?.catalog_id ?? item?.catalog?.id ?? '');
      if (!cid) return false;
      const strat = String(process.env.CATALOG_MATCH_STRATEGY || 'subtree');
      if (strat === 'subtree') {
        const expanded = expandCatalogs(catalogs);
        if (!expanded.has(cid)) return false;
        try { metrics.subcatalog_ok_total?.inc(1); } catch {}
      } else {
        if (!catalogs.includes(cid)) return false;
        try { metrics.catalog_ok_total?.inc(1); } catch {}
      }
    }
    // Optional brand enforcement
    if (String(process.env.FANOUT_ENFORCE_BRAND || '1') === '1' && filters.brandIds?.length) {
      const bid = String(item?.brand_id ?? item?.brand?.id ?? '');
      if (!bid) return false;
      const strat = String(process.env.BRAND_MATCH_STRATEGY || 'alias_group');
      if (strat === 'alias_group') {
        const expanded = expandBrandIds(filters.brandIds);
        if (!expanded.has(bid)) return false;
        const orig = new Set(filters.brandIds.map(String));
        try { (orig.has(bid) ? metrics.brand_ok_total : metrics.brand_alias_ok_total)?.inc(1); } catch {}
      } else {
        if (!filters.brandIds.map(String).includes(bid)) return false;
        try { metrics.brand_ok_total?.inc(1); } catch {}
      }
    }
    // Optional size enforcement
    if (String(process.env.FANOUT_ENFORCE_SIZE || '0') === '1' && filters.sizeIds?.length) {
      const sid = String(item?.size_id ?? item?.size?.id ?? '');
      if (!sid || !filters.sizeIds.map(String).includes(sid)) return false;
    }
    // Optional status/condition enforcement
    if (String(process.env.FANOUT_ENFORCE_STATUS || '0') === '1' && filters.statusIds?.length) {
      const st = String(item?.status_id ?? item?.status ?? '').toLowerCase();
      if (!st || !filters.statusIds.map(x=>String(x).toLowerCase()).includes(st)) return false;
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

// Return first failing reason for diagnostics (does not mutate metrics)
export function debugMatchFailReason(item, filters) {
  try {
    const price = normalizedPrice(item, filters?.currency || 'EUR');
    if (!Number.isNaN(price)) {
      if (typeof filters.priceFrom === 'number' && price < filters.priceFrom) return 'price_out_of_range';
      if (typeof filters.priceTo === 'number' && price > filters.priceTo) return 'price_out_of_range';
    }
    const REQ_CAT = String(process.env.FANOUT_REQUIRE_CATALOG_MATCH || '1') === '1';
    const catalogs = Array.isArray(filters.catalogs) ? filters.catalogs.map(String) : [];
    const HAS_WILDCARD_2050 = catalogs.includes('2050');
    if (REQ_CAT && catalogs.length && !HAS_WILDCARD_2050) {
      const cid = String(item?.catalog_id ?? item?.catalog?.id ?? '');
      if (!cid) return 'catalog_mismatch';
      const stratC = String(process.env.CATALOG_MATCH_STRATEGY || 'subtree');
      if (stratC === 'subtree') {
        if (!expandCatalogs(catalogs).has(cid)) return 'catalog_mismatch';
      } else {
        if (!catalogs.includes(cid)) return 'catalog_mismatch';
      }
    }
    if (String(process.env.FANOUT_ENFORCE_BRAND || '1') === '1' && filters.brandIds?.length) {
      const bid = String(item?.brand_id ?? item?.brand?.id ?? '');
      if (!bid) return 'brand_mismatch';
      const stratB = String(process.env.BRAND_MATCH_STRATEGY || 'alias_group');
      if (stratB === 'alias_group') {
        if (!expandBrandIds(filters.brandIds).has(bid)) return 'brand_mismatch';
      } else {
        if (!filters.brandIds.map(String).includes(bid)) return 'brand_mismatch';
      }
    }
    if (String(process.env.FANOUT_ENFORCE_SIZE || '0') === '1' && filters.sizeIds?.length) {
      const sid = String(item?.size_id ?? item?.size?.id ?? '');
      if (!sid || !filters.sizeIds.map(String).includes(sid)) return 'size_mismatch';
    }
    if (String(process.env.FANOUT_ENFORCE_STATUS || '0') === '1' && filters.statusIds?.length) {
      const st = String(item?.status_id ?? item?.status ?? '').toLowerCase();
      if (!st || !filters.statusIds.map(x=>String(x).toLowerCase()).includes(st)) return 'status_mismatch';
    }
    if (filters.text) {
      const t = String(filters.text).toLowerCase().split(/\s+/).filter(Boolean);
      const hay = `${item?.title || ''} ${item?.description || ''}`.toLowerCase();
      for (const w of t) if (!hay.includes(w)) return 'text_mismatch';
    }
    return null;
  } catch {
    return 'unknown';
  }
}

// Brand+Catalog only matcher (ignores price and other filters)
export function brandCatalogMatches(item, filters) {
  try {
    // Catalogs
    const REQ_CAT = String(process.env.FANOUT_REQUIRE_CATALOG_MATCH || '1') === '1';
    const catalogs = Array.isArray(filters?.catalogs) ? filters.catalogs.map(String) : [];
    const HAS_WILDCARD_2050 = catalogs.includes('2050');
    if (REQ_CAT && catalogs.length && !HAS_WILDCARD_2050) {
      const cid = String(item?.catalog_id ?? item?.catalog?.id ?? '');
      if (!cid) return false;
      const strat = String(process.env.CATALOG_MATCH_STRATEGY || 'subtree');
      if (strat === 'subtree') {
        if (!expandCatalogs(catalogs).has(cid)) return false;
      } else if (!catalogs.includes(cid)) return false;
    }
    // Brand
    if (String(process.env.FANOUT_ENFORCE_BRAND || '1') === '1' && (filters?.brandIds?.length)) {
      const bid = String(item?.brand_id ?? item?.brand?.id ?? '');
      if (!bid) return false;
      const strat = String(process.env.BRAND_MATCH_STRATEGY || 'alias_group');
      if (strat === 'alias_group') {
        if (!expandBrandIds(filters.brandIds).has(bid)) return false;
      } else if (!filters.brandIds.map(String).includes(bid)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Canonicalize URL ignoring a set of keys (e.g., price_to)
export function canonicalizeUrlExcept(rawUrl, ignoreKeys = []) {
  try {
    const u = new URL(String(rawUrl || ''));
    const params = new URLSearchParams(u.search);
    const norm = {};
    for (const [k, v] of params.entries()) {
      if (ignoreKeys.includes(k)) continue;
      if (ARRAY_KEYS.has(k)) {
        norm[k] = norm[k] || [];
        norm[k].push(v);
      } else {
        norm[k] = String(v || '');
      }
    }
    for (const k of Object.keys(norm)) if (ARRAY_KEYS.has(k)) norm[k] = normalizeArray(norm[k]);
    const keys = Object.keys(norm).sort();
    const parts = [];
    for (const k of keys) {
      const v = norm[k];
      if (Array.isArray(v)) parts.push(`${k}=${v.join(',')}`); else parts.push(`${k}=${v}`);
    }
    return `${u.host}${u.pathname}?${parts.join('&')}`;
  } catch { return String(rawUrl || ''); }
}
