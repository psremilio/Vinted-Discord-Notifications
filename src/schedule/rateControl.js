// AIMD per-proxy rate controller with 180s sliding window

import { metrics } from '../infra/metrics.js';
import fs from 'fs';
import path from 'path';
import { getLagP95 } from '../infra/loopLag.js';

function nowSec() { return Math.floor(Date.now() / 1000); }

class ProxyCtl {
  constructor() {
    this.state = new Map(); // proxy -> { rate, target, samples: [{t, ok, code, ms}] }
    this.maxDynamic = null; // dynamic MAX ceiling
    this.conf = {
      MIN: Number(process.env.PROXY_RPM_MIN || 0.5),
      MAX: Number(process.env.PROXY_RPM_MAX || 4),
      START: Number(process.env.PROXY_RPM_START || 1),
      INC: Number(process.env.INCREASE_STEP || 0.3),
      DEC: Number(process.env.DECREASE_FACTOR || 0.6),
      ERR_BUDGET: Number(process.env.ERROR_BUDGET_429 || 0.05),
      LAT_BUDGET: Number(process.env.LATENCY_BUDGET_MS || 2000),
      WINDOW: 180,
    };
    this._tick = setInterval(() => this._adjustLoop(), 60_000).unref?.();
    this._loadSnapshot();
  }

  _get(proxy) {
    let s = this.state.get(proxy);
    if (!s) {
      s = { rate: this.conf.START, target: this.conf.START, samples: [] };
      this.state.set(proxy, s);
    }
    return s;
  }

  currentRate(proxy) { return this._get(proxy).rate; }
  currentTarget(proxy) { return this._get(proxy).target; }

  observe(proxy, ev) {
    const s = this._get(proxy);
    const t = nowSec();
    const sample = { t, ok: !!ev.ok, code: ev.code || null, ms: ev.latency || null, softFail: !!ev.softFail };
    s.samples.push(sample);
    // trim to window
    const cutoff = t - this.conf.WINDOW;
    while (s.samples.length && s.samples[0].t < cutoff) s.samples.shift();
    // update metrics
    try {
      metrics.proxy_rpm_current.set({ proxy }, s.rate);
      metrics.proxy_rpm_target.set({ proxy }, s.target);
      if (ev.code === 429) metrics.http_429_total.inc();
      if (ev.code === 403) metrics.http_403_total.inc();
      if (ev.ok) metrics.fetch_ok_total.inc();
      if (ev.skipped) metrics.fetch_skipped_total.inc();
      if (ev.softFail || ev.fail) metrics.fetch_softfail_total.inc();
    } catch {}
  }

  _summary(samples) {
    const total = samples.length || 0;
    let err = 0; const lats = [];
    for (const s of samples) {
      if (s.code === 429 || s.code === 403) err++;
      if (typeof s.ms === 'number') lats.push(s.ms);
    }
    const errRate = total ? err / total : 0;
    lats.sort((a, b) => a - b);
    const p95 = lats.length ? lats[Math.min(lats.length - 1, Math.floor(lats.length * 0.95))] : 0;
    return { total, errRate, p95 };
  }

  _adjustOne(proxy, s) {
    const { total, errRate, p95 } = this._summary(s.samples);
    const conf = this.conf;
    const MAX = this.maxDynamic != null ? Math.max(conf.MIN, this.maxDynamic) : conf.MAX;
    if (total < 5) return; // not enough data
    if (errRate > conf.ERR_BUDGET) {
      s.target = Math.max(conf.MIN, s.rate * conf.DEC);
    } else if (p95 && p95 > conf.LAT_BUDGET) {
      s.target = Math.max(conf.MIN, s.rate * conf.DEC);
    } else {
      s.target = Math.min(MAX, s.rate + conf.INC);
    }
    // converge gradually to target
    if (Math.abs(s.rate - s.target) < 0.05) s.rate = s.target;
    else if (s.rate < s.target) s.rate = Math.min(s.target, s.rate + conf.INC);
    else s.rate = Math.max(s.target, s.rate * conf.DEC);
    s.rate = Math.max(conf.MIN, Math.min(MAX, s.rate));
    metrics.proxy_rpm_current.set({ proxy }, s.rate);
    metrics.proxy_rpm_target.set({ proxy }, s.target);
  }

  _adjustLoop() {
    for (const [proxy, s] of this.state.entries()) this._adjustOne(proxy, s);
    // Global softcap clamp on targets (last resort)
    const SOFTCAP = Number(process.env.GLOBAL_RPM_SOFTCAP || 3000);
    if (SOFTCAP > 0) {
      let sumTargets = 0;
      for (const s of this.state.values()) sumTargets += (s.target || 0);
      if (sumTargets > SOFTCAP && sumTargets > 0) {
        const factor = SOFTCAP / sumTargets;
        for (const [proxy, s] of this.state.entries()) {
          s.target = Math.max(this.conf.MIN, s.target * factor);
          metrics.proxy_rpm_target.set({ proxy }, s.target);
          // allow rates to converge down naturally; hard cap if grossly above
          if (s.rate > s.target * 1.5) s.rate = s.target;
          metrics.proxy_rpm_current.set({ proxy }, s.rate);
        }
      }
    }
    // Event-loop lag protection & dynamic MAX tuning
    try {
      const LAG_P95 = getLagP95();
      const THRESH = Number(process.env.EVENT_LOOP_LAG_MAX_MS || 150);
      const err60 = this.errorRateSec(60);
      const lowLag = LAG_P95 < Number(process.env.EVENT_LOOP_LAG_LOW_MS || 80);
      const lowErr = err60 < Number(process.env.ERROR_RATE_LOW || 0.02);
      const ceil = Number(process.env.PROXY_RPM_MAX_CEIL || Math.max(6, this.conf.MAX));
      const floor = this.conf.MAX; // don't go below configured MAX
      if (this.maxDynamic == null) this.maxDynamic = this.conf.MAX;
      if (LAG_P95 > THRESH || err60 > this.conf.ERR_BUDGET) {
        this.maxDynamic = Math.max(floor, this.maxDynamic * Number(process.env.LAG_CLAMP_FACTOR || 0.85));
      } else if (lowLag && lowErr) {
        this.maxDynamic = Math.min(ceil, this.maxDynamic + Number(process.env.MAX_RAMP_STEP || 0.2));
      }
      metrics.global_latency_p95_ms.set(this.latencyP95Sec(60));
      metrics.http_429_rate_60s.set(this.errorRateSec(60));
    } catch {}

    // global effective rpm estimation
    try {
      let sum = 0; for (const s of this.state.values()) sum += (s.rate || 0);
      metrics.global_rpm_effective.set(sum);
    } catch {}
    this._saveSnapshot();
  }

  // Global error rate over a short window (seconds)
  errorRateSec(windowSec = 60) {
    const cutoff = nowSec() - Math.max(1, windowSec);
    let total = 0, err = 0;
    for (const s of this.state.values()) {
      for (const sm of s.samples) {
        if (sm.t >= cutoff) {
          total++;
          if (sm.code === 429 || sm.code === 403) err++;
        }
      }
    }
    return total ? err / total : 0;
  }

  latencyP95Sec(windowSec = 60) {
    const cutoff = nowSec() - Math.max(1, windowSec);
    const lats = [];
    for (const s of this.state.values()) {
      for (const sm of s.samples) {
        if (sm.t >= cutoff && typeof sm.ms === 'number') lats.push(sm.ms);
      }
    }
    if (!lats.length) return 0;
    lats.sort((a, b) => a - b);
    return lats[Math.min(lats.length - 1, Math.floor(lats.length * 0.95))];
  }

  // Snapshot persistence
  _snapshotPath() {
    const base = process.env.DATA_DIR || '/data';
    try { fs.mkdirSync(base, { recursive: true }); } catch {}
    let dir = base;
    try { fs.accessSync(base, fs.constants.W_OK); } catch { dir = path.resolve('./data'); try { fs.mkdirSync(dir, { recursive: true }); } catch {} }
    return path.join(dir, 'aimd_snapshot.json');
  }
  _saveSnapshot() {
    try {
      const obj = { ts: Date.now(), entries: {} };
      for (const [proxy, s] of this.state.entries()) {
        obj.entries[proxy] = { rate: s.rate, target: s.target };
      }
      fs.writeFile(this._snapshotPath(), JSON.stringify(obj), () => {});
    } catch {}
  }
  _loadSnapshot() {
    try {
      const p = this._snapshotPath();
      if (!fs.existsSync(p)) return;
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (!raw || typeof raw !== 'object' || !raw.entries) return;
      // ignore very old snapshots (> 6h)
      if ((Date.now() - (raw.ts || 0)) > 6 * 60 * 60 * 1000) return;
      for (const [proxy, v] of Object.entries(raw.entries)) {
        const s = this._get(proxy);
        if (typeof v.rate === 'number') s.rate = v.rate;
        if (typeof v.target === 'number') s.target = v.target;
        metrics.proxy_rpm_current.set({ proxy }, s.rate);
        metrics.proxy_rpm_target.set({ proxy }, s.target);
      }
    } catch {}
  }
}

export const rateCtl = new ProxyCtl();

// Utility clamp for external/global use if needed
export function clampGlobalTargets(targets, softcap) {
  try {
    const vals = Object.values(targets || {});
    const sum = vals.reduce((a, b) => a + (Number(b) || 0), 0);
    const cap = Number(softcap || 0);
    if (!cap || sum <= cap) return targets;
    const k = cap / sum;
    for (const p in targets) targets[p] = Math.max((Number(targets[p]) || 0) * k, 0.1);
  } catch {}
  return targets;
}
