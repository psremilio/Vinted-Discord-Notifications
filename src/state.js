export const state = {
  startedAt: new Date(),
  lastFetchAt: null,
  lastFetchSuccessAt: null,
  lastPostAt: null,
  consecutiveErrors: 0,
  watchers: 0,
  lastProbe: { code: null, ms: null },
  commit: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.COMMIT_SHA || 'dev',
  version: process.env.npm_package_version || 'dev',
};

// Track recent soft-fail events per rule to make quarantine and zero-match logic aware
const lastSoftFailByRule = new Map(); // ruleId -> timestamp

export function markFetchAttempt() {
  state.lastFetchAt = new Date();
}

export function markFetchSuccess(ms, code) {
  state.lastFetchSuccessAt = new Date();
  state.consecutiveErrors = 0;
  if (ms != null || code != null) state.lastProbe = { code: code ?? state.lastProbe.code, ms: ms ?? state.lastProbe.ms };
}

export function markFetchError() {
  state.consecutiveErrors = (state.consecutiveErrors || 0) + 1;
}

export function markPosted() {
  state.lastPostAt = new Date();
}

export function recordSoftFail(ruleId) {
  try { lastSoftFailByRule.set(String(ruleId), Date.now()); } catch {}
}

export function hadSoftFailRecently(ruleId, windowMs = 30 * 1000) {
  try {
    const ts = lastSoftFailByRule.get(String(ruleId)) || 0;
    return ts > 0 && (Date.now() - ts) <= Math.max(1000, Number(windowMs || 0));
  } catch { return false; }
}
