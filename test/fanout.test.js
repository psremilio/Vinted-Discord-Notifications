import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dedupeKeyForChannel } from '../src/utils/dedupe.js';
import { buildParentGroups } from '../src/rules/parenting.js';

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

