import fs from 'fs';
import path from 'path';

// Load price-family policy from config file and/or env vars
// Config format (optional):
// {
//   "brands": {
//     "nike": { "ids": ["53"], "buckets": [10,15,20,30] },
//     "adidas": { "ids": ["5"], "buckets": [10,20,30] },
//     "lacoste": { "ids": ["67"], "buckets": [10,20,30] }
//   },
//   "requireSingleBrand": true
// }

function parseBucketsCsv(csv) {
  const nums = String(csv || '')
    .split(/[,|;\s]+/)
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n));
  return new Set(nums);
}

export function loadPriceFamilyPolicy() {
  const file = path.resolve('./config/family_policy.json');
  let cfg = {};
  try { if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, 'utf-8')) || {}; } catch {}

  const allowedBrandIds = new Set();
  const bucketsByBrand = new Map();

  // From config
  try {
    const brands = cfg.brands || {};
    for (const [name, entry] of Object.entries(brands)) {
      const ids = Array.isArray(entry?.ids) ? entry.ids.map(String) : [];
      for (const id of ids) allowedBrandIds.add(String(id));
      const buckets = Array.isArray(entry?.buckets) ? new Set(entry.buckets.map(Number).filter(Number.isFinite)) : new Set();
      for (const id of ids) if (buckets.size) bucketsByBrand.set(String(id), buckets);
    }
  } catch {}

  // From env: FAMILY_ALLOWED_BRAND_IDS="53,5,67"
  const envBrands = String(process.env.FAMILY_ALLOWED_BRAND_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const id of envBrands) allowedBrandIds.add(String(id));

  // From env: FAMILY_PRICE_BUCKETS_DEFAULT="10,15,20,30"
  const defaultBuckets = parseBucketsCsv(process.env.FAMILY_PRICE_BUCKETS_DEFAULT || '');
  // From env: FAMILY_PRICE_BUCKETS_BY_BRAND="53:10|15|20|30;5:10|20|30;67:10|20|30"
  try {
    const by = String(process.env.FAMILY_PRICE_BUCKETS_BY_BRAND || '')
      .split(';')
      .map(s => s.trim())
      .filter(Boolean);
    for (const part of by) {
      const [bid, list] = part.split(':');
      if (!bid || !list) continue;
      bucketsByBrand.set(String(bid.trim()), parseBucketsCsv(list));
    }
  } catch {}

  const requireSingleBrand = (cfg.requireSingleBrand ?? (String(process.env.FAMILY_REQUIRE_SINGLE_BRAND || '1') === '1')) ? true : false;
  const nameWhitelistRegex = new RegExp(String(process.env.FAMILY_NAME_WHITELIST_REGEX || '^(nike|adidas|lacoste)\\b'), 'i');
  const defaultDenyWhenNoBrands = String(process.env.FAMILY_DEFAULT_DENY || '0') === '1';

  return { allowedBrandIds, bucketsByBrand, defaultBuckets, requireSingleBrand, nameWhitelistRegex, defaultDenyWhenNoBrands };
}
