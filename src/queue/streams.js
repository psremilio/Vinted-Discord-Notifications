import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL || process.env.REDIS_SOCKET;
const STREAM_PREFIX = String(process.env.STREAM_PREFIX || 'stream:posts:');

let client = null;
let initErr = null;
export async function getRedis() {
  if (client || initErr) return client;
  try {
    client = createClient({ url: REDIS_URL });
    client.on('error', (e) => { initErr = e; try { console.warn('[streams.redis]', e?.message || e); } catch {} });
    await client.connect();
  } catch (e) { initErr = e; try { console.warn('[streams.init] failed:', e?.message || e); } catch {} }
  return client;
}

export function streamKey(channelId) { return `${STREAM_PREFIX}${String(channelId)}`; }

export async function ensureGroup(channelId, group = String(process.env.POST_GROUP || 'poster')) {
  const cli = await getRedis(); if (!cli) return false;
  const key = streamKey(channelId);
  try {
    await cli.sendCommand(['XGROUP', 'CREATE', key, group, '0', 'MKSTREAM']);
    return true;
  } catch (e) {
    // BUSYGROUP is fine
    return true;
  }
}

export async function xaddPostTask(channelId, fields = {}) {
  const cli = await getRedis(); if (!cli) return null;
  const key = streamKey(channelId);
  const arr = [];
  for (const [k, v] of Object.entries(fields)) { arr.push(String(k), typeof v === 'string' ? v : JSON.stringify(v)); }
  const id = await cli.sendCommand(['XADD', key, '*', ...arr]);
  return id;
}

export async function xreadGroupBatch(keys = [], group, consumer, { count = 10, blockMs = 2000 } = {}) {
  const cli = await getRedis(); if (!cli || !keys.length) return [];
  const cmd = ['XREADGROUP', 'GROUP', group, consumer, 'COUNT', String(count), 'BLOCK', String(blockMs), 'STREAMS'];
  for (const k of keys) cmd.push(streamKey(k));
  for (let i = 0; i < keys.length; i++) cmd.push('>');
  const res = await cli.sendCommand(cmd).catch(()=>null);
  // Result shape: [ [ key, [ [id, [field, val, ...]], ... ] ], ... ]
  const out = [];
  if (!Array.isArray(res)) return out;
  for (const entry of res) {
    const [skey, items] = entry;
    const channelId = String(skey).slice(STREAM_PREFIX.length);
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      const [id, flat] = it;
      const obj = {};
      for (let i = 0; i < flat.length; i += 2) { const k = flat[i]; const v = flat[i + 1]; obj[k] = v; }
      out.push({ channelId, id, fields: obj });
    }
  }
  return out;
}

export async function xack(channelId, group, id) {
  const cli = await getRedis(); if (!cli) return 0;
  const key = streamKey(channelId);
  try { return await cli.xAck(key, group, id); } catch { return 0; }
}

export async function xautoclaim(channelId, group, consumer, minIdleMs = 15000, lastId = '0-0', count = 25) {
  const cli = await getRedis(); if (!cli) return [];
  const key = streamKey(channelId);
  const res = await cli.sendCommand(['XAUTOCLAIM', key, group, consumer, String(minIdleMs), lastId, 'COUNT', String(count)]).catch(()=>null);
  // res: [ nextId, [ [id, [field, val,...]], ... ] ]
  const out = [];
  if (!Array.isArray(res)) return out;
  const items = res[1];
  if (!Array.isArray(items)) return out;
  for (const it of items) {
    const [id, flat] = it;
    const obj = {};
    for (let i = 0; i < flat.length; i += 2) { const k = flat[i]; const v = flat[i + 1]; obj[k] = v; }
    out.push({ id, fields: obj });
  }
  return out;
}

