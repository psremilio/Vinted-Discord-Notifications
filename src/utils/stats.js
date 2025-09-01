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
    console.log(`[stats] search_ok=${stats.ok} search_403=${stats.s403} search_5xx=${stats.s5xx} rpm=${rpm} posted=${stats.posted} queue=${stats.queue}`);
    // decay counters each minute
    for (const k of Object.keys(stats)) stats[k] = 0;
  }, 60 * 1000);
}

