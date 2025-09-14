// postedStore: setIfAbsent with TTL using in-memory map (no Redis dependency)
const mem = new Map(); // key -> expireAt epoch ms
function memCleanup() {
  const now = Date.now();
  for (const [k, exp] of mem.entries()) { if (exp && exp <= now) mem.delete(k); }
}

export async function setIfAbsent(key, ttlSec = 86400) {
  const k = String(key || '');
  if (!k) return false;
  // In-memory idempotency with TTL
  memCleanup();
  if (mem.has(k)) return false;
  const exp = Date.now() + Math.max(1, Number(ttlSec || 1)) * 1000;
  mem.set(k, exp);
  return true;
}
