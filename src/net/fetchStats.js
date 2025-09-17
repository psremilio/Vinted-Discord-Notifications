let successRate = 1;

export function updateFetchSuccessRate(rate) {
  if (!Number.isFinite(rate)) return;
  successRate = Math.max(0, Math.min(1, rate));
}

export function getFetchSuccessRate() {
  return successRate;
}
