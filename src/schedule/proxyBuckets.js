// Per-proxy token buckets (main + retry)

class TokenBucket {
  constructor(ratePerMin = 1) {
    this.ratePerMin = Math.max(0, Number(ratePerMin || 0));
    this.tokens = this.ratePerMin; // start with 1 minute budget
    this._last = Date.now();
  }
  take(n = 1) {
    this.refill();
    if (this.tokens >= n) { this.tokens -= n; return true; }
    return false;
  }
  refill(dtMs) {
    const now = Date.now();
    const dt = dtMs != null ? dtMs : (now - this._last);
    this._last = now;
    const perSec = this.ratePerMin / 60;
    this.tokens = Math.min(this.ratePerMin, this.tokens + perSec * (dt / 1000));
  }
  setRate(rpm) {
    this.ratePerMin = Math.max(0, Number(rpm || 0));
    // cap tokens to new capacity
    this.tokens = Math.min(this.tokens, this.ratePerMin);
  }
}

class ProxyBuckets {
  constructor(ratePerMin = 1) {
    this.main = new TokenBucket(ratePerMin);
    const ratio = Number(process.env.RETRY_BUDGET_RATIO || 0.3);
    this.retry = new TokenBucket(Math.floor(ratePerMin * ratio));
  }
  updateRates(mainRate) {
    this.main.setRate(mainRate);
    const ratio = Number(process.env.RETRY_BUDGET_RATIO || 0.3);
    this.retry.setRate(Math.floor(mainRate * ratio));
  }
}

const bucketsByProxy = new Map();
export function getBuckets(proxy, rateProvider) {
  if (!proxy) return null;
  let b = bucketsByProxy.get(proxy);
  if (!b) {
    const start = Number(process.env.PROXY_RPM_START || 1);
    b = new ProxyBuckets(start);
    bucketsByProxy.set(proxy, b);
  }
  // Sync rates with controller
  if (rateProvider) {
    try {
      const r = rateProvider.currentRate(proxy);
      if (typeof r === 'number') b.updateRates(r);
    } catch {}
  }
  return b;
}

export function dropBuckets(proxy) { if (proxy && bucketsByProxy.has(proxy)) bucketsByProxy.delete(proxy); }

