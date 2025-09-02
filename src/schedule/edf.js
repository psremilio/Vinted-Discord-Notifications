// Minimal EDF scheduler for rule polling
import { tierOf, TIER_TARGET_SEC } from './tiers.js';

function jitter(ms, spread = 0.2) {
  const k = 1 - spread + Math.random() * (2 * spread);
  return Math.max(1000, Math.floor(ms * k));
}

export class EdfScheduler {
  constructor(runFn) {
    this.runFn = runFn; // async (client, rule)
    this.rules = new Map(); // name -> { rule, tier, targetMs, nextAt, running }
    this.timer = null;
    this.client = null;
    this.inflight = 0;
  }

  addRule(client, rule) {
    this.client = client;
    const name = rule.channelName;
    const tier = tierOf(name);
    const targetMs = Math.max(1000, Math.floor((TIER_TARGET_SEC[tier] || 12) * 1000));
    const nextAt = Date.now() + jitter(targetMs);
    this.rules.set(name, { rule, tier, targetMs, nextAt, running: false });
  }

  removeRule(name) { this.rules.delete(name); }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this._tick(), 250);
    // light observability
    let lastLog = Date.now();
    setInterval(() => {
      const now = Date.now();
      const ready = Array.from(this.rules.values()).filter(r => !r.running && r.nextAt <= now).length;
      const total = this.rules.size;
      console.log(`[sched.edf.tick] ready=${ready} rules=${total}`);
    }, 2000).unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  _pickReady() {
    const now = Date.now();
    let best = null;
    for (const st of this.rules.values()) {
      if (st.running) continue;
      if (!best || st.nextAt < best.nextAt) best = st;
    }
    if (!best) return null;
    if (best.nextAt > now) return null;
    return best;
  }

  async _tick() {
    const budget = Math.max(1, Number(process.env.SEARCH_CONCURRENCY || 4));
    let dispatched = 0;
    while (dispatched < budget) {
      const st = this._pickReady();
      if (!st) break;
      st.running = true;
      this.inflight++;
      dispatched++;
      // fire-and-forget; limiter in runFn enforces real concurrency
      this.runFn(this.client, st.rule)
        .catch(() => {})
        .finally(() => {
          st.running = false;
          st.nextAt = Date.now() + jitter(st.targetMs);
          this.inflight = Math.max(0, this.inflight - 1);
        });
    }
    if (dispatched && String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') {
      const ready = Array.from(this.rules.values()).filter(r => !r.running && r.nextAt <= Date.now()).length;
      console.log(`[sched.edf.tick] dispatched=${dispatched} inflight=${this.inflight} readyLeft=${ready}`);
    }
  }
}
