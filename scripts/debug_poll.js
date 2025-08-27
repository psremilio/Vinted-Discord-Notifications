// scripts/debug_poll.js
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

import { vintedSearch } from '../src/bot/search.js';
import { ensureProxyList } from '../src/net/ensureProxyList.js';
import { initProxyPool } from '../src/net/proxyHealth.js';

dotenv.config();

async function main() {
  const cfgPath = path.join(process.cwd(), 'config', 'channels.json');
  const rules = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  const name = process.argv[2] || rules?.[0]?.channelName;
  const rule = rules.find(r => r.channelName === name);
  if (!rule) {
    console.error('Rule not found. Available:', rules.map(r => r.channelName).join(', '));
    process.exit(1);
  }

  console.log(`[debug] running single poll for rule "${rule.channelName}"`);
  try {
    await ensureProxyList();
  } catch (e) {
    console.warn('[debug] ensureProxyList failed:', e.message || e);
  }
  try {
    await initProxyPool();
  } catch (e) {
    console.warn('[debug] initProxyPool failed:', e.message || e);
  }

  const processed = new Set();
  try {
    const items = await vintedSearch(rule, processed);
    console.log(`[debug] vintedSearch returned ${items?.length || 0} items`);
  } catch (e) {
    console.error('[debug] poll_error', e);
    process.exit(2);
  }
}

main().then(() => process.exit(0));

