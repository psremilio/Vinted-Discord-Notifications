import { metrics } from '../infra/metrics.js';

export const stats = {
  ok: 0,
  s401: 0,
  s403: 0,
  s4xx: 0,
  s5xx: 0,
  posted: 0,
  queue: 0,
};

let timer = null;
export function startStats() {
  if (timer) return;
  timer = setInterval(() => {
    const rpm = stats.ok + stats.s401 + stats.s403 + stats.s4xx + stats.s5xx;
    try {
      const grpm = metrics.global_rpm_effective.get?.() ?? null;
      const e429 = metrics.http_429_rate_60s.get?.() ?? null;
      const lag = metrics.global_latency_p95_ms.get?.() ?? null;
      const dq = metrics.discord_queue_depth.get?.() ?? null;
      const dc = metrics.discord_cooldown_active.get?.() ?? null;
      const p95 = metrics.post_latency_ms_p95.get?.() ?? null;
      const bf = metrics.backfill_pages_active.get?.() ?? null;
      console.log(`[obs] rpm=${rpm} grpm=${grpm} 429_rate60=${e429} lag_p95_ms=${lag} dq=${dq} dc=${dc} post_p95_ms=${p95} bf_active=${bf}`);
    } catch {
      console.log(`[stats] search_ok=${stats.ok} search_403=${stats.s403} search_5xx=${stats.s5xx} rpm=${rpm} posted=${stats.posted} queue=${stats.queue}`);
    }
    // decay counters each minute
    for (const k of Object.keys(stats)) stats[k] = 0;
  }, 60 * 1000);
}
