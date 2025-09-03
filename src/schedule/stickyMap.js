import { EventEmitter } from 'events';
import { HashRing } from './hashRing.js';
import { healthEvents, listHealthyProxies, getProxyScores } from '../net/proxyHealth.js';
import { rateCtl } from './rateControl.js';
import { metrics } from '../infra/metrics.js';

// Maintains a consistent hash mapping ruleId -> proxyId, with dynamic pool updates
class StickyMap extends EventEmitter {
  constructor() {
    super();
    this.ring = new HashRing(Number(process.env.VNODES_PER_PROXY || 128));
    this.overrides = new Map(); // ruleId -> { proxy, until }
    this.ruleSkips = new Map(); // ruleId -> array of {t, skipped, proxy}
    this.ruleReassignCooldown = new Map(); // ruleId -> ts
    this._init();
  }

  _init() {
    try { this._rebuildWeighted(); } catch {}
    // Listen to pool events (best-effort)
    try {
      const rebuild = () => { try { this._rebuildWeighted(); } catch {} };
      healthEvents.on('add', rebuild);
      healthEvents.on('restore', rebuild);
      healthEvents.on('cooldown', rebuild);
      healthEvents.on('remove', rebuild);
    } catch {}
    // Safety: periodic reconcile in case of missed events
    setInterval(() => {
      try { this._rebuildWeighted(); } catch {}
    }, 30_000).unref?.();
  }

  _rebuildWeighted() {
    const list = listHealthyProxies();
    const scores = getProxyScores?.() || {};
    // weighting: 1..3 based on score (-10..+10)
    for (const id of Array.from(this.ring.nodes?.keys?.() || [])) this.ring.remove(id);
    list.forEach(p => {
      const s = Number(scores[p] ?? 0);
      const w = s >= 6 ? 3 : s >= 2 ? 2 : 1;
      this.ring.add(p, w);
    });
  }

  assign(ruleId) {
    const ov = this.overrides.get(ruleId);
    if (ov && ov.until > Date.now()) return ov.proxy;
    if (ov) this.overrides.delete(ruleId);
    return this.ring.get(ruleId);
  }

  next(currentProxyId) {
    return this.ring.next(currentProxyId);
  }

  failover(ruleId) {
    const cur = this.assign(ruleId);
    const alt = this.next(cur);
    const ttlMin = Math.max(2, Number(process.env.RULE_FAILOVER_MIN || 5));
    this.overrides.set(ruleId, { proxy: alt, until: Date.now() + ttlMin * 60 * 1000 });
    this.emit('failover', { ruleId, from: cur, to: alt, ttlMin });
    return alt;
  }

  record(ruleId, { skipped = false, proxy }) {
    const arr = this.ruleSkips.get(ruleId) || [];
    const t = Math.floor(Date.now() / 1000);
    arr.push({ t, skipped: !!skipped, proxy });
    const cutoff = t - 180; // 3 minutes
    while (arr.length && arr[0].t < cutoff) arr.shift();
    this.ruleSkips.set(ruleId, arr);
  }

  _p95Skips() {
    const ratios = [];
    for (const arr of this.ruleSkips.values()) {
      if (!arr.length) continue;
      const total = arr.length;
      const skip = arr.filter(x => x.skipped).length;
      ratios.push(skip / total);
    }
    if (!ratios.length) return 0;
    ratios.sort((a, b) => a - b);
    return ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * 0.95))];
  }

  _rebalanceSkew() {
    const now = Date.now();
    const THRESH = Number(process.env.STARVATION_SKIP_RATIO || process.env.RULE_SKIP_RATIO_THRESH || 0.3);
    const COOLDOWN_MS = Number(process.env.STARVATION_OVERRIDE_TTL_MS || process.env.RULE_REASSIGN_COOLDOWN_MS || 5 * 60 * 1000);
    for (const [ruleId, arr] of this.ruleSkips.entries()) {
      if (!arr.length) continue;
      const total = arr.length;
      const skip = arr.filter(x => x.skipped).length;
      const ratio = total ? (skip / total) : 0;
      if (ratio <= THRESH) continue;
      const cd = this.ruleReassignCooldown.get(ruleId) || 0;
      if (cd > now) continue;
      // Decide headroom on alternate
      const cur = this.assign(ruleId);
      const alt = this.next(cur);
      if (!alt || alt === cur) continue;
      const headroom = (rateCtl.currentTarget(alt) || 0) - (rateCtl.currentRate(alt) || 0);
      if (headroom < Number(process.env.HEADROOM_MIN || 0.2)) continue;
      // reassign for cooldown period
      this.overrides.set(ruleId, { proxy: alt, until: now + COOLDOWN_MS });
      this.ruleReassignCooldown.set(ruleId, now + COOLDOWN_MS);
      try { metrics.rules_reassigned_total.inc(); } catch {}
    }
    try { metrics.skipped_ratio_p95.set(this._p95Skips()); } catch {}
  }
}

// Periodic skew rebalance
const sticky = new StickyMap();
setInterval(() => { try { sticky._rebalanceSkew(); } catch {} }, 60 * 1000).unref?.();
export const stickyMap = sticky;

// expose approximate skip ratio for a rule over 3 minutes
export function getRuleSkipRatio(ruleId) {
  try {
    const arr = stickyMap.ruleSkips?.get?.(ruleId) || [];
    if (!arr.length) return 0;
    const total = arr.length;
    const skip = arr.filter(x => x.skipped).length;
    return total ? skip / total : 0;
  } catch { return 0; }
}
