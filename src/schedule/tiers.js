// Simple tier mapping via glob lists from env

function parseGlobs(envName) {
  const raw = process.env[envName] || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function matchGlob(name, pattern) {
  // very small glob: * matches any chars, case-insensitive
  const esc = s => s.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*');
  const re = new RegExp('^' + esc(pattern) + '$', 'i');
  return re.test(String(name));
}

export function tierOf(ruleId) {
  const hot = parseGlobs('TIER_HOT_GLOBS');
  for (const g of hot) if (matchGlob(ruleId, g)) return 'T0';
  const warm = parseGlobs('TIER_WARM_GLOBS');
  for (const g of warm) if (matchGlob(ruleId, g)) return 'T1';
  return 'T2';
}

export const TIER_TARGET_SEC = {
  T0: Number(process.env.T0_TARGET_SEC || 8),
  T1: Number(process.env.T1_TARGET_SEC || 12),
  T2: Number(process.env.T2_TARGET_SEC || 30),
};

