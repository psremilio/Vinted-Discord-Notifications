// Simple in-memory TTL store + dedupe key helpers
// Allow CROSS_RULE_DEDUP=1 to force global scope
const CROSS = String(process.env.CROSS_RULE_DEDUP || '0') === '1';
// Supported scopes: 'per_rule', 'global', 'channel', 'family'
// Accept both DEDUPE_SCOPE and common typo DEDUPLE_SCOPE
const _RAW_SCOPE = (process.env.DEDUPE_SCOPE || process.env.DEDUPLE_SCOPE || 'channel').toLowerCase();
// Prefer per_rule unless explicitly forced to global
const FORCE_GLOBAL = String(process.env.FORCE_GLOBAL_DEDUPE || '0') === '1';
let scope = CROSS || FORCE_GLOBAL ? 'global' : _RAW_SCOPE;
if ((scope === 'global' || !scope) && !FORCE_GLOBAL && !CROSS) {
  try { console.warn('[dedupe.scope.override] requested=%s -> using per_rule (recommended)', scope || '(empty)'); } catch {}
  scope = 'per_rule';
}
// Default to 'channel' only if explicitly set; otherwise prefer 'per_rule'
if (scope !== 'global' && scope !== 'channel' && scope !== 'family' && scope !== 'per_rule') {
  scope = 'per_rule';
}
// Export final scope
export const DEDUPE_SCOPE = scope;
// TTL: prefer seconds env if provided, else minutes fallback
const DEDUPE_TTL_SEC = parseInt(process.env.DEDUPE_TTL_SEC ?? process.env.PROCESSED_TTL_SEC ?? '0', 10);
export const PROCESSED_TTL_MIN = parseInt(process.env.PROCESSED_TTL_MIN ?? '60', 10);
export const ttlMs = (DEDUPE_TTL_SEC > 0 ? DEDUPE_TTL_SEC * 1000 : PROCESSED_TTL_MIN * 60 * 1000);

const slug = (s) => String(s || '').toLowerCase().trim().replace(/\s+/g, '-');

function channelIdentifier(channel) {
  try {
    const id = channel?.channelId || channel?.id || channel?.channel_id;
    if (id != null && String(id).trim() !== '') return String(id).trim();
  } catch {}
  return '';
}

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
    const chanId = channelIdentifier(channel);
    const chanSuffix = chanId ? `:chan:${chanId}` : '';
    if (DEDUPE_SCOPE === 'global') return `seen:item:${id}`;
    if (DEDUPE_SCOPE === 'channel') {
      const c = chanId || slug(channel?.channelName || channel?.name || '');
      return `seen:chan:${c}:item:${id}`;
    }
    if (DEDUPE_SCOPE === 'family') {
      const fk = String(familyKeyOptional || '');
      if (fk) return `seen:family:${slug(fk)}${chanSuffix}:item:${id}`;
      // Fallback to per_rule when no family key provided
      return `seen:rule:${slug(channel?.channelName || channel?.name || '')}${chanSuffix}:item:${id}`;
    }
    // per_rule
    return `seen:rule:${slug(channel?.channelName || channel?.name || '')}${chanSuffix}:item:${id}`;
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
