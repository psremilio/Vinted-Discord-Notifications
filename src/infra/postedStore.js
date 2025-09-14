// postedStore: setIfAbsent with TTL, backed by Redis when available, else in-memory TTL map
import { createClient } from 'redis';

let redis = null;
let redisInitError = null;
const REDIS_URL = process.env.REDIS_URL || process.env.REDIS_SOCKET;

async function initRedisOnce() {
  if (!REDIS_URL) return null;
  if (redis || redisInitError) return redis;
  try {
    const client = createClient({ url: REDIS_URL });
    client.on('error', (e) => { redisInitError = e; try { console.warn('[postedStore.redis]', e?.message || e); } catch {} });
    await client.connect();
    redis = client;
  } catch (e) {
    redisInitError = e;
    try { console.warn('[postedStore] redis init failed:', e?.message || e); } catch {}
  }
  return redis;
}

const mem = new Map(); // key -> expireAt epoch ms
function memCleanup() {
  const now = Date.now();
  for (const [k, exp] of mem.entries()) { if (exp && exp <= now) mem.delete(k); }
}

export async function setIfAbsent(key, ttlSec = 86400) {
  const k = String(key || '');
  if (!k) return false;
  // Try Redis first
  try {
    const cli = await initRedisOnce();
    if (cli) {
      const res = await cli.set(k, '1', { NX: true, EX: Math.max(1, Number(ttlSec || 1)) });
      return res === 'OK';
    }
  } catch {}
  // Fallback to in-memory
  memCleanup();
  if (mem.has(k)) return false;
  const exp = Date.now() + Math.max(1, Number(ttlSec || 1)) * 1000;
  mem.set(k, exp);
  return true;
}

