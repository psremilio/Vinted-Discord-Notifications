#!/usr/bin/env node
import { buildFamilyKeyFromURL } from '../src/rules/urlNormalizer.js';

function testSet(name, urls) {
  console.log(`\n[set] ${name}`);
  let parentKey = null;
  let allSame = true;
  for (const [tag, url] of urls) {
    const key = buildFamilyKeyFromURL(url, 'auto');
    console.log(tag, key, url);
    if (tag === 'P') parentKey = key;
    if (tag === 'C' && parentKey) {
      const same = key === parentKey;
      console.log('SAME?', same ? 'SAME' : 'DIFF');
      if (!same) allSame = false;
    }
  }
  return allSame;
}

const ok1 = testSet('NIKE', [
  ['P','https://www.vinted.xx/catalog?brand_ids[]=123&catalog_ids[]=1'],
  ['C','https://www.vinted.xx/catalog?brand_ids[]=123&catalog_ids[]=1&price_to=10'],
  ['C','https://www.vinted.xx/catalog?catalog=1&brand_id=123&order=newest&page=1&currency=eur']
]);

const ok2 = testSet('ADIDAS', [
  ['P','https://www.vinted.xx/catalog?brand=456&catalog_id=1'],
  ['C','https://www.vinted.xx/catalog?brand_ids[]=456&catalog_ids[]=1&price_max=30']
]);

const ok3 = testSet('LACOSTE', [
  ['P','https://www.vinted.xx/catalog?brand_ids[]=789&catalog_ids[]=1'],
  ['C','https://www.vinted.xx/catalog?brand_ids=789&catalog_ids=1&price_to=20']
]);

if (!(ok1 && ok2 && ok3)) {
  console.error('[smoke] DIFF detected in at least one set');
  process.exit(1);
}
console.log('[smoke] All sets SAME');
