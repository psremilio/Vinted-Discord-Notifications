import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalizeForFamily, buildFamilyKeyFromURL } from '../src/rules/urlNormalizer.js';

test('canonicalizeForFamily maps aliases and normalizes host/path', () => {
  const parent = 'https://WWW.VINTED.de/catalog//?brand=123&catalog_id=1&order=newest&page=1';
  const child  = 'https://www.vinted.de/catalog?brand_ids[]=123&catalog_ids[]=1&price_to=10';
  const a = canonicalizeForFamily(parent);
  const b = canonicalizeForFamily(child);
  assert.equal(a.host, 'www.vinted.de'.replace(/^www\./,''));
  assert.equal(b.host, 'www.vinted.de'.replace(/^www\./,''));
  assert.equal(a.path, '/catalog');
  assert.equal(b.path, '/catalog');
  assert.deepEqual(a.brandIds, [123]);
  assert.deepEqual(b.brandIds, [123]);
  assert.deepEqual(a.catalogs, [1]);
  assert.deepEqual(b.catalogs, [1]);
  assert.equal(typeof a.currency, 'string');
});

test('buildFamilyKeyFromURL equal for alias variations', () => {
  const p = 'https://www.vinted.xx/catalog?brand_ids[]=123&catalog_ids[]=1&currency=EUR';
  const c = 'https://www.vinted.xx/catalog?brand_id=123&catalog=1&price_to=20';
  const k1 = buildFamilyKeyFromURL(p);
  const k2 = buildFamilyKeyFromURL(c);
  assert.equal(k1, k2);
});

test('currency defaults to EUR when missing', () => {
  const p = 'https://www.vinted.xx/catalog?brand_ids[]=123&catalog_ids[]=1';
  const k = buildFamilyKeyFromURL(p);
  assert.ok(k.includes('cur=EUR') || k.includes('currency=EUR'));
});

