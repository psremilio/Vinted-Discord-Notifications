// Simple in-memory store of firstMatchedAt timestamps per (ruleId, itemId)
// Used for match-age gating and optional price-drop labeling.

const TTL_HOURS = Math.max(1, Number(process.env.SEEN_TTL_HOURS || 24));
const TTL_MS = TTL_HOURS * 60 * 60 * 1000;

const map = new Map(); // key -> { t, expireAt }

function key(ruleId, itemId) { return `${String(ruleId)}::${String(itemId)}`; }

export function getFirstMatchedAt(ruleId, itemId, now = Date.now()) {
  const k = key(ruleId, itemId);
  const e = map.get(k);
  if (e && e.expireAt > now) return e.t;
  return null;
}

export function recordFirstMatch(ruleId, itemId, when = Date.now()) {
  const k = key(ruleId, itemId);
  const prev = map.get(k);
  const t = prev?.t && prev.t <= when ? prev.t : when;
  map.set(k, { t, expireAt: when + TTL_MS });
  return t;
}

export function purgeExpiredMatches() {
  const now = Date.now();
  for (const [k, v] of map.entries()) if ((v?.expireAt || 0) <= now) map.delete(k);
}

