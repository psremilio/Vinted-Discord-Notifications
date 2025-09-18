// Minimal EDF scheduler for rule polling
import { tierOf, TIER_TARGET_SEC } from './tiers.js';
import { getRuleSkipRatio } from './stickyMap.js';
import { metrics } from '../infra/metrics.js';
import { healthyCount, shouldSafeMode } from '../net/proxyHealth.js';

function jitter(ms, spread = 0.2) {
  const k = 1 - spread + Math.random() * (2 * spread);
  return Math.max(1000, Math.floor(ms * k));
}

const SAFE_MODE_LOG_INTERVAL_MS = Math.max(1, Number(process.env.SAFE_MODE_LOG_INTERVAL_MS || 30_000));

export class EdfScheduler {
  constructor(runFn) {
    this.runFn = runFn; // async (client, rule)
    this._lastDispatchAt = 0;
    this._lastStallLogAt = 0;
    this.rules = new Map(); // name -> { rule, tier, targetMs, nextAt, running, phaseOffset }
    this.timer = null;
    this.client = null;
    this.inflight = 0;
    this._lastSafeModeLog = 0;
  }

  addRule(client, rule) {
    this.client = client;
    const name = rule.channelName;
    const tier = tierOf(name);
    // Prefer per-rule frequency when provided, else fall back to tier target
    const freqSec = Number(rule?.frequency || 0);
    const MIN_PERIOD = Math.max(1000, Number(process.env.SEARCH_PERIOD_MIN_MS || 3000));
    const MAX_PERIOD = Math.max(MIN_PERIOD, Number(process.env.SEARCH_PERIOD_MAX_MS || 8000));
    const baseMs = Math.floor((freqSec > 0 ? freqSec : (TIER_TARGET_SEC[tier] || 12)) * 1000);
    const targetMs = Math.max(MIN_PERIOD, Math.min(MAX_PERIOD, baseMs));
    // Phase anchor: fixed 10s grid with per-rule offset + jitter ±1s
    const PHASE_MS = 10_000;
    const h = [...String(name)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0);
    const baseOffset = h % PHASE_MS; // 0..9999
    const jitterMs = Math.floor((Math.random() * 2000) - 1000); // ±1s
    const phaseOffset = Math.max(0, Math.min(PHASE_MS - 1, baseOffset + jitterMs));
    const now = Date.now();
    const nextAnchor = Math.floor(now / PHASE_MS) * PHASE_MS + PHASE_MS;
    let nextAt = nextAnchor + phaseOffset;
    // Fast-start: dispatch promptly after start to avoid initial idle window
    if (String(process.env.SEARCH_FAST_START || '1') === '1') {
      const soon = Date.now() + Math.floor(Math.random() * 200);
      nextAt = Math.min(nextAt, soon);
    }
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
    st.rule = rule; // keep nextAt/running; refresh targetMs if frequency changed
    try {
      const tier = st.tier || tierOf(name);
      const freqSec = Number(rule?.frequency || 0);
      st.targetMs = Math.max(1000, Math.floor((freqSec > 0 ? freqSec : (TIER_TARGET_SEC[tier] || 12)) * 1000));
    } catch {}
    this.rules.set(name, st);
    return true;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this._tick(), 250);
    // light observability
    let lastLog = Date.now();
    const logTimer = setInterval(() => {
      const now = Date.now();
      const ready = Array.from(this.rules.values()).filter(r => !r.running && r.nextAt <= now).length;
      const total = this.rules.size;
      console.log(`[sched.edf.tick] ready=${ready} rules=${total}`);
    }, 2000);
    logTimer.unref?.();

    // Stall guard: ensure rules eventually dispatch even if timers drift
    const STALL_SEC = Math.max(5, Number(process.env.SCHED_STALL_RESET_SEC || 20));
    const stallTimer = setInterval(() => {
      const nowStall = Date.now();
      if ((this.inflight || 0) > 0) return;
      const last = this._lastDispatchAt || 0;
      if (!last) return;
      if (nowStall - last > STALL_SEC * 1000) {
        let bumped = 0;
        for (const st of this.rules.values()) {
          if (!st.running && st.nextAt > nowStall) {
            st.nextAt = nowStall + Math.floor(Math.random() * 200);
            bumped++;
          }
        }
        if (bumped > 0 && (nowStall - this._lastStallLogAt) > 5000) {
          this._lastStallLogAt = nowStall;
          console.warn(`[sched.edf.stall] reset nextAt for ${bumped} rules after ${Math.round((nowStall - last) / 1000)}s idle`);
        }
      }
    }, 1500);
    stallTimer.unref?.();
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
    // Global pause gate to let slash commands ack/respond without contention
    try {
      if (Date.now() < EdfGate.pauseUntil) return;
    } catch {}
    const safeModeMin = Math.max(0, Number(process.env.SAFE_MODE_MIN_HEALTHY || process.env.MIN_HEALTHY || 10));
    let healthy = 0;
    try { healthy = healthyCount(); } catch {}
    if (!Number.isFinite(healthy) || healthy < 0) healthy = 0;
    const safeModeActive = typeof shouldSafeMode === 'function' ? shouldSafeMode() : (safeModeMin > 0 && healthy < safeModeMin);
    const softEnabled = String(process.env.SOFT_SAFE_MODE || '0') === '1';
    const softRateRaw = Number(process.env.SOFT_SAFE_MODE_RATE || 0.25);
    const softRate = Math.max(0.05, Math.min(1, Number.isFinite(softRateRaw) ? softRateRaw : 0.25));
    let softScale = null;
    if (safeModeActive && safeModeMin > 0 && healthy < safeModeMin) {
      const now = Date.now();
      const hardStop = healthy <= 0 || !softEnabled;
      try { metrics.proxy_safe_mode?.set?.(1); } catch {}
      if (!this._lastSafeModeLog || (now - this._lastSafeModeLog) >= SAFE_MODE_LOG_INTERVAL_MS) {
        this._lastSafeModeLog = now;
        const label = hardStop ? 'paused scheduling' : `soft throttle (${Math.round(softRate * 100)}%)`;
        try { console.warn(`[sched.safe_mode] ${label} (healthy=${healthy} < min=${safeModeMin})`); } catch {}
      }
      if (hardStop) {
        return;
      }
      if (Math.random() > softRate) {
        return;
      }
      softScale = softRate;
    } else {
      this._lastSafeModeLog = 0;
      try { metrics.proxy_safe_mode?.set?.(0); } catch {}
    }
    // Determine dispatch budget with optional auto-scaling
    // Slightly higher default scheduler concurrency for faster discovery on hot rules
    const cfg = Math.max(1, Number(process.env.SEARCH_SCHED_CONCURRENCY || process.env.SEARCH_CONCURRENCY || 16));
    const auto = String(process.env.AUTO_SCALE_SCHED || '1') === '1';
    const maxC = Math.max(cfg, Number(process.env.SEARCH_SCHED_MAX_CONC || cfg));
    const nowTick = Date.now();
    const readyCount = Array.from(this.rules.values()).filter(r => !r.running && r.nextAt <= nowTick).length;
    let budget = cfg;
    if (auto) {
      const want = Math.max(cfg, Math.min(maxC, Math.ceil(readyCount / 2)));
      budget = Math.min(maxC, Math.max(cfg, want));
    }
    let concurrencyCap = Math.max(1, healthy || 1);
    if (softScale !== null) {
      budget = Math.max(1, Math.floor(Math.max(1, budget * softScale)));
      const scaledCap = Math.max(1, Math.floor(Math.max(1, concurrencyCap * Math.max(softScale, 0.1))));
      concurrencyCap = scaledCap;
    }
    let dispatched = 0;
    while (dispatched < budget && (this.inflight + dispatched) < concurrencyCap) {
      const st = this._pickReady();
      if (!st) break;
      st.running = true;
      this.inflight++;
      dispatched++;
      this._lastDispatchAt = Date.now();
      // fire-and-forget; limiter in runFn enforces real concurrency
      const ratio = (()=>{ try { return getRuleSkipRatio(st.rule.channelName); } catch { return 0; } })();
      const thr = Number(process.env.STARVATION_SKIP_RATIO || 0.3);
      if (ratio > thr) { try { metrics.rule_catchup_grants_total?.inc(); } catch {} }
      this.runFn(this.client, st.rule)
        .catch(() => {})
        .finally(() => {
          st.running = false;
          // Next schedule time: optionally use per-rule targetMs to avoid 10s bursts
          const t = Date.now();
          const USE_TARGET = String(process.env.EDF_USE_TARGET_MS || '1') === '1';
          if (!st._deleted) {
            if (USE_TARGET) {
              const base = st.targetMs || 10_000;
              const next = t + jitter(base, 0.15);
              st.nextAt = next;
            } else {
              const PHASE_MS = 10_000;
              const nextAnchor = Math.floor(t / PHASE_MS) * PHASE_MS + PHASE_MS;
              st.nextAt = nextAnchor + (st.phaseOffset || 0);
            }
          }
          this.inflight = Math.max(0, this.inflight - 1);
        });
    }
    if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') {
      const ready = Array.from(this.rules.values()).filter(r => !r.running && r.nextAt <= Date.now()).length;
      console.log(`[sched.edf.tick] dispatched=${dispatched} inflight=${this.inflight} readyLeft=${ready}`);
    }
  }
}

// Simple exported gate to pause scheduler briefly (e.g., during slash-interaction ack)
export const EdfGate = {
  pauseUntil: 0,
  pause(ms = 750) {
    const now = Date.now();
    const until = now + Math.max(0, Number(ms || 0));
    if (until > this.pauseUntil) this.pauseUntil = until;
  }
};
