// Simple tier mapping via glob lists from env

function parseGlobs(envName, fallback = '') {
  const raw = process.env[envName] || '';
  const val = String(raw).trim() ? raw : fallback;
  return String(val)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function matchGlob(name, pattern) {
  // very small glob: * matches any chars, case-insensitive
  const esc = s => s.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*');
  const re = new RegExp('^' + esc(pattern) + '$', 'i');
  return re.test(String(name));
}

export function tierOf(ruleId) {
  // Treat parent aggregators and their priced children as hot by default
  // unless overridden by env (TIER_HOT_GLOBS). Avoid non-ASCII in fallback
  // to prevent encoding issues: price-children match by suffix after "-all-".
  const hot = parseGlobs('TIER_HOT_GLOBS', '*-all,*-all-*');
  for (const g of hot) if (matchGlob(ruleId, g)) return 'T0';
  const warm = parseGlobs('TIER_WARM_GLOBS');
  for (const g of warm) if (matchGlob(ruleId, g)) return 'T1';
  return 'T2';
}

export const TIER_TARGET_SEC = {
  // More aggressive polling defaults to keep discovery in the 10–30s band
  T0: Number(process.env.T0_TARGET_SEC || 6),
  T1: Number(process.env.T1_TARGET_SEC || 10),
  T2: Number(process.env.T2_TARGET_SEC || 15),
};

