import { aggQueue } from '../queue/aggQueue.js';
import { sendDiscordWebhook, ChannelLimiter } from '../discord/limiter.js';

const MAX_INFLIGHT = Math.max(1, Number(process.env.POSTER_MAX_INFLIGHT || 128));
const PER_CH_INFLIGHT = Math.max(1, Number(process.env.POSTER_PER_CHANNEL_MAX_INFLIGHT || 1));
const MULTI = Math.max(1, Math.min(10, Number(process.env.MULTI_EMBEDS_PER_MSG || 10)));
const DRAIN_ON = Math.max(0, Number(process.env.DRAIN_MODE_ON_QUEUE || 800));
const HOT_AGE = Math.max(0, Number(process.env.HOT_AGE_MS || 20000));

const inflightByChan = new Map(); // channelId -> number
function inFl(ch) { return inflightByChan.get(String(ch)) || 0; }
function inc(ch) { inflightByChan.set(String(ch), inFl(ch) + 1); }
function dec(ch) { inflightByChan.set(String(ch), Math.max(0, inFl(ch) - 1)); }
function globalInflight() { let s = 0; for (const v of inflightByChan.values()) s += (v || 0); return s; }

export function startLocalPoster() {
  const channels = Array.from(globalThis.channelsStore?.keys?.() || []);
  // simple scheduler loop
  setInterval(async () => {
    try {
      const totalQ = aggQueue.totalQueued();
      const drain = totalQ >= DRAIN_ON;
      // Hot-lane ordering: compute head age per channel
      const headAge = new Map();
      for (const ch of channels) {
        const arr = aggQueue.pullForChannel(String(ch), 0); // size 0 to ensure ensureChannel called but not deq
        // Not depleting; we'll probe by pulling 1 when needed
        headAge.set(String(ch), 0);
      }
      // Iterate channels; simple round-robin order is fine; we will pull a batch only when capacity exists
      for (const ch of channels) {
        if (globalInflight() >= MAX_INFLIGHT) break;
        if (inFl(ch) >= PER_CH_INFLIGHT) continue;
        const batchSize = drain ? MULTI : 1;
        const tasks = aggQueue.pullForChannel(String(ch), batchSize);
        if (!tasks.length) continue;
        const head = tasks[0];
        const isHot = head?.createdAtMs ? ((Date.now() - Number(head.createdAtMs)) <= HOT_AGE) : true;
        inc(ch);
        (async () => {
          try {
            if (tasks.length === 1) {
              await sendDiscordWebhook(String(ch), { embeds: [head.embed], allowed_mentions: { parse: [] } });
              aggQueue.markPosted(String(ch), head.id);
            } else {
              const embeds = tasks.slice(0, MULTI).map(t => t.embed).slice(0, 10);
              await sendDiscordWebhook(String(ch), { embeds, allowed_mentions: { parse: [] } });
              for (const t of tasks.slice(0, embeds.length)) aggQueue.markPosted(String(ch), t.id);
            }
          } catch (e) {
            // On rate-limit or other errors, let ChannelLimiter pacing handle retries at admit; we re-enqueue tasks by putting back
            try { for (const t of tasks) aggQueue.putItemToChannels({ id: t.id, createdAtMs: t.createdAtMs, embed: t.embed, components: t.components, content: t.content }, [String(ch)]); } catch {}
          } finally {
            dec(ch);
          }
        })();
      }
    } catch {}
  }, 50).unref?.();
}

