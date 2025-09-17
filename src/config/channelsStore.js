import fs from 'fs';
import path from 'path';
import { channelsPath } from '../infra/paths.js';
import { writeJsonAtomic } from '../infra/atomicJson.js';

function safeRead(p) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return []; } }
function fileInfo(p) {
  try { const st = fs.statSync(p); return { mtime: st.mtimeMs, count: Array.isArray(safeRead(p)) ? safeRead(p).length : 0 }; } catch { return { mtime: 0, count: 0 }; }
}

export function loadChannels(prefer = process.env.CONFIG_SOURCE || 'auto') {
  const cfg = path.resolve('./config/channels.json');
  const data = (fs.existsSync('/data') ? '/data/channels.json' : path.resolve('./data/channels.json'));
  const cfgExists = fs.existsSync(cfg);
  const dataExists = fs.existsSync(data);
  let chosen = null;
  if (prefer === 'force_config' && cfgExists) chosen = cfg;
  else if (prefer === 'force_data' && dataExists) chosen = data;
  else if (dataExists && !cfgExists) chosen = data;
  else if (cfgExists && !dataExists) chosen = cfg;
  else if (cfgExists && dataExists) {
    const ci = fileInfo(cfg); const di = fileInfo(data);
    // Prefer larger count; tie-breaker newer mtime
    if (di.count > ci.count) chosen = data; else if (ci.count > di.count) chosen = cfg; else chosen = (di.mtime >= ci.mtime ? data : cfg);
    try { console.log('[config] decide', { cfg_count: ci.count, data_count: di.count, cfg_mtime: ci.mtime, data_mtime: di.mtime, chosen }); } catch {}
  }
  if (!chosen) chosen = channelsPath();
  const list = safeRead(chosen);
  try { console.log('[config] using', chosen, 'count=', Array.isArray(list) ? list.length : 0); } catch {}
  return { list, path: chosen };
}

export function saveChannels(arr) {
  const p = channelsPath();
  writeJsonAtomic(p, arr);
  try {
    const dir = path.dirname(p);
    const ts = new Date();
    const stamp = `${ts.getFullYear()}${String(ts.getMonth()+1).padStart(2,'0')}${String(ts.getDate()).padStart(2,'0')}${String(ts.getHours()).padStart(2,'0')}${String(ts.getMinutes()).padStart(2,'0')}`;
    const bak = path.join(dir, `channels.backup-${stamp}.json`);
    fs.writeFileSync(bak, JSON.stringify(arr, null, 2));
  } catch {}
}

export function mergeChannels(a = [], b = []) {
  const out = [];
  const seen = new Set();
  const keyOf = (r) => `${String(r.channelId || '')}|${String(r.url || '')}`;
  for (const r of [...a, ...b]) { const k = keyOf(r); if (seen.has(k)) continue; seen.add(k); out.push(r); }
  return out;
}

