export function normalizeTimestampMs(value) {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Values below 1e12 are assumed to be seconds (Vinted uses created_at_ts seconds)
  return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
}

export function ensureRecentMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  if (normalized === 'strict' || normalized === 'relaxed') return normalized;
  return null;
}
