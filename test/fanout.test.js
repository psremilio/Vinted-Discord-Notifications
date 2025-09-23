import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dedupeKeyForChannel } from '../src/utils/dedupe.js';
import { buildParentGroups, buildAutoPriceFamilies } from '../src/rules/parenting.js';

test('dedupe is per-channel scoped', () => {
  const a = { channelId: 'A', channelName: 'parent', url: 'https://www.vinted.de/catalog?brand_ids[]=1&catalog[]=123' };
  const k1 = dedupeKeyForChannel(a, 42, 'host/path?brand_ids[]=1&catalog[]=123');
  const b = { channelId: 'B', channelName: 'child', url: a.url };
  const k2 = dedupeKeyForChannel(b, 42, 'host/path?brand_ids[]=1&catalog[]=123');
  assert.notEqual(k1, k2);
});

test('buildParentGroups creates family with children', () => {
  const parent = { channelName: 'p-all', url: 'https://www.vinted.de/catalog?brand_ids[]=1&catalog[]=123' };
  const child = { channelName: 'p-cheap', url: 'https://www.vinted.de/catalog?brand_ids[]=1&catalog[]=123&price_to=50' };
  const fams = buildParentGroups([parent, child]);
  const found = fams.find(f => f.parent.channelName === 'p-all' || f.children.some(c => c.rule.channelName === 'p-cheap'));
  assert.ok(found);
  assert.ok((found.children || []).length > 0);
});

test('auto price families keep children when no buckets configured', (t) => {
  const prevDefault = process.env.FAMILY_PRICE_BUCKETS_DEFAULT;
  const prevByBrand = process.env.FAMILY_PRICE_BUCKETS_BY_BRAND;
  const prevAllowed = process.env.FAMILY_ALLOWED_BRAND_IDS;
  delete process.env.FAMILY_PRICE_BUCKETS_DEFAULT;
  delete process.env.FAMILY_PRICE_BUCKETS_BY_BRAND;
  delete process.env.FAMILY_ALLOWED_BRAND_IDS;
  t.after(() => {
    if (prevDefault === undefined) delete process.env.FAMILY_PRICE_BUCKETS_DEFAULT;
    else process.env.FAMILY_PRICE_BUCKETS_DEFAULT = prevDefault;
    if (prevByBrand === undefined) delete process.env.FAMILY_PRICE_BUCKETS_BY_BRAND;
    else process.env.FAMILY_PRICE_BUCKETS_BY_BRAND = prevByBrand;
    if (prevAllowed === undefined) delete process.env.FAMILY_ALLOWED_BRAND_IDS;
    else process.env.FAMILY_ALLOWED_BRAND_IDS = prevAllowed;
  });
  const rules = [
    { channelName: 'nike-all', url: 'https://www.vinted.de/catalog?order=newest_first&search_text=Nike' },
    { channelName: 'nike-all-10€', url: 'https://www.vinted.de/catalog?order=newest_first&price_to=10&search_text=Nike' },
    { channelName: 'nike-all-15€', url: 'https://www.vinted.de/catalog?order=newest_first&price_to=15&search_text=Nike' },
    { channelName: 'nike-all-20€', url: 'https://www.vinted.de/catalog?order=newest_first&price_to=20&search_text=Nike' },
    { channelName: 'nike-all-30€', url: 'https://www.vinted.de/catalog?order=newest_first&price_to=30&search_text=Nike' },
  ];
  const fams = buildAutoPriceFamilies(rules);
  const fam = fams.find(f => f.parent?.channelName === 'nike-all');
  assert.ok(fam);
  assert.equal(fam.children.length, 4);
});

