// Simple in-memory TTL store + dedupe key helpers
// Allow CROSS_RULE_DEDUP=1 to force global scope
const CROSS = String(process.env.CROSS_RULE_DEDUP || '0') === '1';
export const DEDUPE_SCOPE = CROSS ? 'global' : (process.env.DEDUPE_SCOPE || 'per_rule'); // 'per_rule' | 'global'
export const PROCESSED_TTL_MIN = parseInt(process.env.PROCESSED_TTL_MIN ?? '60', 10);
export const ttlMs = PROCESSED_TTL_MIN * 60 * 1000;

const slug = (s) => String(s || '').toLowerCase().trim().replace(/\s+/g, '-');

export function dedupeKey(ruleName, itemId) {
  const id = String(itemId ?? '');
  return (DEDUPE_SCOPE === 'global')
    ? `seen:item:${id}`
    : `seen:rule:${slug(ruleName)}:item:${id}`;
}

export function createProcessedStore() {
  const map = new Map(); // key -> { value, expireAt }
  function has(key) {
    const entry = map.get(key);
    if (!entry) return false;
    if (entry.expireAt && entry.expireAt <= Date.now()) {
      map.delete(key);
      return false;
    }
    return true;
  }
  function set(key, value, { ttl } = {}) {
    const expireAt = ttl && ttl > 0 ? Date.now() + ttl : 0;
    map.set(key, { value, expireAt });
  }
  function purgeExpired() {
    const now = Date.now();
    for (const [k, v] of map.entries()) {
      if (v.expireAt && v.expireAt <= now) map.delete(k);
    }
  }
  function size() { return map.size; }
  return { has, set, purgeExpired, size };
}
