// Simple in-memory TTL store + dedupe key helpers
// Allow CROSS_RULE_DEDUP=1 to force global scope
const CROSS = String(process.env.CROSS_RULE_DEDUP || '0') === '1';
// Supported scopes: 'per_rule', 'global', 'channel', 'family'
// Default to 'channel' to allow cross-posting between parent/children while
// preventing duplicates within the same Discord channel.
export const DEDUPE_SCOPE = CROSS ? 'global' : (process.env.DEDUPE_SCOPE || 'channel');
export const PROCESSED_TTL_MIN = parseInt(process.env.PROCESSED_TTL_MIN ?? '60', 10);
export const ttlMs = PROCESSED_TTL_MIN * 60 * 1000;

const slug = (s) => String(s || '').toLowerCase().trim().replace(/\s+/g, '-');

export function dedupeKey(ruleName, itemId) {
  const id = String(itemId ?? '');
  return (DEDUPE_SCOPE === 'global')
    ? `seen:item:${id}`
    : `seen:rule:${slug(ruleName)}:item:${id}`;
}

// Compute a dedupe key based on configured scope and the full channel object
export function dedupeKeyForChannel(channel, itemId, familyKeyOptional) {
  try {
    const id = String(itemId ?? '');
    if (DEDUPE_SCOPE === 'global') return `seen:item:${id}`;
    if (DEDUPE_SCOPE === 'channel') return `seen:chan:${String(channel?.channelId || channel?.id || '')}:item:${id}`;
    if (DEDUPE_SCOPE === 'family') {
      const fk = String(familyKeyOptional || '');
      if (fk) return `seen:family:${slug(fk)}:item:${id}`;
      // Fallback to per_rule when no family key provided
      return `seen:rule:${slug(channel?.channelName || '')}:item:${id}`;
    }
    // per_rule
    return `seen:rule:${slug(channel?.channelName || '')}:item:${id}`;
  } catch {
    return dedupeKey(channel?.channelName || '', itemId);
  }
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
