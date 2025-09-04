#!/usr/bin/env node
import { buildFamilyKeyFromURL } from '../src/rules/urlNormalizer.js';

function testSet(name, urls) {
  console.log(`\n[set] ${name}`);
  let parentKey = null;
  for (const [tag, url] of urls) {
    const key = buildFamilyKeyFromURL(url, 'auto');
    console.log(tag, key, url);
    if (tag === 'P') parentKey = key;
    if (tag === 'C' && parentKey) {
      console.log('SAME?', key === parentKey ? 'SAME' : 'DIFF');
    }
  }
}

testSet('NIKE', [
  ['P','https://www.vinted.xx/catalog?brand_ids[]=123&catalog_ids[]=1'],
  ['C','https://www.vinted.xx/catalog?brand_ids[]=123&catalog_ids[]=1&price_to=10'],
  ['C','https://www.vinted.xx/catalog?catalog=1&brand_id=123&order=newest&page=1&currency=eur']
]);

testSet('ADIDAS', [
  ['P','https://www.vinted.xx/catalog?brand=456&catalog_id=1'],
  ['C','https://www.vinted.xx/catalog?brand_ids[]=456&catalog_ids[]=1&price_max=30']
]);

testSet('LACOSTE', [
  ['P','https://www.vinted.xx/catalog?brand_ids[]=789&catalog_ids[]=1'],
  ['C','https://www.vinted.xx/catalog?brand_ids=789&catalog_ids=1&price_to=20']
]);

