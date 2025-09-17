import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalizeForFamily, buildFamilyKeyFromURL } from '../rules/urlNormalizer.js';

test('alias mapping and numeric canonicalization', () => {
  const p = 'https://www.vinted.de/catalog?brand_id=12&brand=12&catalog=3&catalog_id=3&order=newest&page=2';
  const c = 'https://vinted.de/catalog/?brand_ids[]=12&catalog_ids[]=3&price_to=20&sort=oldest';
  const a = canonicalizeForFamily(p);
  const b = canonicalizeForFamily(c);
  assert.equal(a.host, b.host);
  assert.equal(a.path, b.path);
  assert.deepEqual(a.brandIds, b.brandIds);
  assert.deepEqual(a.catalogs, b.catalogs);
  assert.equal(a.currency, b.currency);
  const k1 = buildFamilyKeyFromURL(p);
  const k2 = buildFamilyKeyFromURL(c);
  assert.equal(k1, k2);
});

test('currency defaults to EUR', () => {
  const p = 'https://vinted.de/catalog?brand_ids[]=1&catalog_ids[]=2';
  const key = buildFamilyKeyFromURL(p);
  assert.ok(key.includes('cur=EUR') || key.includes('currency=EUR'));
});

