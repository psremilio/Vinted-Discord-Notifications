import { limiter } from './ratelimit.js';
import { fetchVinted } from './vinted.js';
import { ensureSubscription, markSeen } from './db.js';
import { postItems } from './poster.js';

const INTERVAL_START = Number(process.env.POLL_INTERVAL_MS || 10000);
const INTERVAL_MIN = Number(process.env.POLL_INTERVAL_MIN_MS || 3000);
const INTERVAL_MAX = Number(process.env.POLL_INTERVAL_MAX_MS || 20000);

export function startScheduler(client, subscriptions) {
  const state = subscriptions.map(s => ({
    ...s,
    interval: INTERVAL_START,
    cooldownUntil: 0,
    subId: ensureSubscription(s.channelId, s.filterKey)
  }));

  async function tick(entry) {
    const now = Date.now();
    if (now < entry.cooldownUntil) {
      setTimeout(() => tick(entry), Math.max(0, entry.cooldownUntil - now));
      return;
    }
    const started = Date.now();
    let newCount = 0;
    try {
      const items = await limiter.schedule(() => fetchVinted(entry.params));
      const fresh = [];
      for (const it of items) {
        if (markSeen(entry.subId, it.id)) fresh.push(it);
      }
      if (fresh.length) {
        newCount = fresh.length;
        await postItems(client, entry.channelId, entry.filterLabel, fresh);
      }
      entry.interval = newCount > 0
        ? Math.max(INTERVAL_MIN, entry.interval - 2000)
        : Math.min(INTERVAL_MAX, entry.interval + 2000);
    } catch (e) {
      const code = Number(e?.status || 0);
      if (code === 429 || code === 403) {
        entry.interval = Math.min(INTERVAL_MAX, entry.interval + 10000);
        entry.cooldownUntil = Date.now() + 15000;
      } else {
        entry.interval = Math.min(INTERVAL_MAX, entry.interval + 5000);
      }
    } finally {
      const elapsed = Date.now() - started;
      const delay = Math.max(0, entry.interval - elapsed);
      setTimeout(() => tick(entry), delay);
    }
  }

  for (const e of state) setTimeout(() => tick(e), 0);
}
