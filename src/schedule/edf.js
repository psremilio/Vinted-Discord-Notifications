// Minimal EDF scheduler for rule polling
import { tierOf, TIER_TARGET_SEC } from './tiers.js';
import { getRuleSkipRatio } from './stickyMap.js';
import { metrics } from '../infra/metrics.js';

function jitter(ms, spread = 0.2) {
  const k = 1 - spread + Math.random() * (2 * spread);
  return Math.max(1000, Math.floor(ms * k));
}

export class EdfScheduler {
  constructor(runFn) {
    this.runFn = runFn; // async (client, rule)
    this.rules = new Map(); // name -> { rule, tier, targetMs, nextAt, running, phaseOffset }
    this.timer = null;
    this.client = null;
    this.inflight = 0;
  }

  addRule(client, rule) {
    this.client = client;
    const name = rule.channelName;
    const tier = tierOf(name);
    const targetMs = Math.max(1000, Math.floor((TIER_TARGET_SEC[tier] || 12) * 1000));
    // Phase anchor: fixed 10s grid with per-rule offset + jitter ±1s
    const PHASE_MS = 10_000;
    const h = [...String(name)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0);
    const baseOffset = h % PHASE_MS; // 0..9999
    const jitterMs = Math.floor((Math.random() * 2000) - 1000); // ±1s
    const phaseOffset = Math.max(0, Math.min(PHASE_MS - 1, baseOffset + jitterMs));
    const now = Date.now();
    const nextAnchor = Math.floor(now / PHASE_MS) * PHASE_MS + PHASE_MS;
    const nextAt = nextAnchor + phaseOffset;
    this.rules.set(name, { rule, tier, targetMs, nextAt, running: false, phaseOffset });
  }

  removeRule(name) { this.rules.delete(name); }
  
  // Hard remove with guard to avoid rescheduling after in-flight completion
  hardRemove(name) {
    const st = this.rules.get(name);
    if (st) { try { st._deleted = true; } catch {} }
    this.rules.delete(name);
  }

  // Update rule data in-place without resetting scheduling (zero-downtime)
  updateRule(rule) {
    const name = rule.channelName;
    const st = this.rules.get(name);
    if (!st) return false;
    st.rule = rule; // keep targetMs/nextAt/running
    this.rules.set(name, st);
    return true;
  }

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
      // catch-up bonus: shift effective nextAt earlier for starved rules
      let effNext = st.nextAt;
      try {
        const ratio = getRuleSkipRatio(st.rule.channelName);
        const thr = Number(process.env.STARVATION_SKIP_RATIO || 0.3);
        if (ratio > thr) {
          const w = Math.max(1, Number(process.env.CATCHUP_BONUS_WEIGHT || 2));
          effNext -= w * 1000; // up to a few seconds earlier
        }
      } catch {}
      if (!best || effNext < best._effNextAt) { best = st; best._effNextAt = effNext; }
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
      const ratio = (()=>{ try { return getRuleSkipRatio(st.rule.channelName); } catch { return 0; } })();
      const thr = Number(process.env.STARVATION_SKIP_RATIO || 0.3);
      if (ratio > thr) { try { metrics.rule_catchup_grants_total?.inc(); } catch {} }
      this.runFn(this.client, st.rule)
        .catch(() => {})
        .finally(() => {
          st.running = false;
          // schedule to next phase anchor respecting per-rule offset
          const PHASE_MS = 10_000;
          const t = Date.now();
          const nextAnchor = Math.floor(t / PHASE_MS) * PHASE_MS + PHASE_MS;
          if (!st._deleted) st.nextAt = nextAnchor + (st.phaseOffset || 0);
          this.inflight = Math.max(0, this.inflight - 1);
        });
    }
    if (dispatched && String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') {
      const ready = Array.from(this.rules.values()).filter(r => !r.running && r.nextAt <= Date.now()).length;
      console.log(`[sched.edf.tick] dispatched=${dispatched} inflight=${this.inflight} readyLeft=${ready}`);
    }
  }
}
