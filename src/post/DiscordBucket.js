export class DiscordBucket {
  constructor(key, safetyMs = Number(process.env.DISCORD_SAFE_GAP_MS || 150)) {
    this.key = String(key);
    this.limit = 5;
    this.remaining = 5;
    this.resetAt = 0; // epoch ms
    this.safetyMs = Number.isFinite(safetyMs) ? safetyMs : 150;
    this.inflight = 0; // enforce bucket-level concurrency=1
  }
  now() { return Date.now(); }
  canSend(t = this.now()) {
    if (this.inflight > 0) return false; // one-inflight per bucket
    if (this.remaining > 0) return true;
    return t >= (this.resetAt + this.safetyMs);
  }
  onRequestQueued() {
    // Virtually take a token to prevent stampedes
    this.remaining = Math.max(0, (this.remaining || 0) - 1);
    this.inflight += 1;
  }
  onHeaders(hdrs = {}) {
    // Apply headers from Discord response
    const h = (k) => {
      try { return hdrs.get ? hdrs.get(k) : hdrs[k]; } catch { return undefined; }
    };
    const lim = Number(h('x-ratelimit-limit'));
    const rem = Number(h('x-ratelimit-remaining'));
    const ra = Number(h('x-ratelimit-reset-after'));
    if (Number.isFinite(lim) && lim > 0) this.limit = lim;
    if (Number.isFinite(rem)) this.remaining = Math.min(this.limit, Math.max(0, rem));
    if (Number.isFinite(ra)) this.resetAt = this.now() + (ra * 1000);
    this.inflight = Math.max(0, this.inflight - 1);
  }
  on429RetryAfter(retryAfterSec) {
    const sec = Number(retryAfterSec);
    const ms = Number.isFinite(sec) && sec > 0 ? sec * 1000 : 1000;
    this.resetAt = this.now() + ms;
    this.remaining = 0;
    this.inflight = Math.max(0, this.inflight - 1);
  }
}

