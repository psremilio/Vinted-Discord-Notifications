import Bottleneck from 'bottleneck';
import { metrics } from './metrics.js';

const QPS = Math.max(1, Number(process.env.DISCORD_QPS || process.env.DISCORD_QPS_MAX || 50));
const CONC = Math.max(1, Number(process.env.DISCORD_POST_CONCURRENCY || 4));
const REORDER_WINDOW_MS = Math.max(0, Number(process.env.REORDER_WINDOW_MS || 12000));

export const postLimiter = new Bottleneck({
  maxConcurrent: CONC,
  reservoir: QPS,
  reservoirRefreshAmount: QPS,
  reservoirRefreshInterval: 1000,
});

function is429(err) {
  const s = Number(err?.status || err?.httpStatus || 0);
  return s === 429;
}

const MAX_QUEUE = Math.max(2000, Number(process.env.DISCORD_QUEUE_MAX || 5000));
const queue = [];
let discordCooldownUntil = 0;

// Per-channel reorder buffers
const chanBuf = new Map(); // channelId -> { buf: Array<{discoveredAt, channel, payload}>, timer }
function ensureChannelBuffer(channel) {
  const id = channel?.id || 'UNKNOWN';
  let st = chanBuf.get(id);
  if (!st) {
    st = { buf: [], timer: null };
    st.timer = setInterval(() => flushChannel(id), 1000);
    chanBuf.set(id, st);
  }
  return st;
}
function flushChannel(id) {
  const st = chanBuf.get(id);
  if (!st) return;
  const now = Date.now();
  const eligible = [];
  const rest = [];
  for (const it of st.buf) {
    if (!REORDER_WINDOW_MS || (now - it.discoveredAt) >= REORDER_WINDOW_MS) eligible.push(it);
    else rest.push(it);
  }
  st.buf = rest;
  if (!eligible.length) return;
  // newest first
  eligible.sort((a, b) => b.discoveredAt - a.discoveredAt);
  for (const job of eligible) {
    enqueueSend(job.channel, job.payload);
  }
}

export async function sendQueued(channel, payload, meta = {}) {
  // Simple backpressure: drop tail if queue exceeds MAX_QUEUE
  try { metrics.discord_queue_depth.set(queue.length); } catch {}
  if (queue.length >= MAX_QUEUE) {
    metrics.discord_dropped_total.inc();
    return; // drop
  }
  // Optional per-channel reorder window
  const discoveredAt = Number(meta?.discoveredAt || Date.now());
  if (REORDER_WINDOW_MS > 0 && channel?.id) {
    const st = ensureChannelBuffer(channel);
    st.buf.push({ discoveredAt, channel, payload });
    return;
  }
  enqueueSend(channel, payload);
}

function enqueueSend(channel, payload) {
  const job = () => postLimiter.schedule(async () => {
    // Honor hard cooldown from headers/errors
    const now = Date.now();
    if (discordCooldownUntil > now) {
      try { metrics.discord_cooldown_active.set(1); } catch {}
      await new Promise(r => setTimeout(r, Math.min(5000, discordCooldownUntil - now)));
    } else {
      try { metrics.discord_cooldown_active.set(0); } catch {}
    }
    try {
      const res = await channel.send(payload);
      // No headers from discord.js, but if ever available, handle here
      try { metrics.discord_cooldown_active.set(0); } catch {}
      return res;
    } catch (e) {
      if (is429(e)) metrics.discord_rate_limit_hits.inc();
      const retry = Math.max(
        Number(e?.retry_after || e?.data?.retry_after || e?.rawError?.retry_after || 0) * 1000,
        Number(e?.headers?.['x-ratelimit-reset-after'] || 0) * 1000
      );
      if (retry > 0) {
        discordCooldownUntil = Date.now() + retry;
        try { metrics.discord_cooldown_active.set(1); } catch {}
      }
      throw e;
    }
  });
  queue.push(job);
  // drain loop (micro task)
  setImmediate(async () => {
    const j = queue.shift();
    try { metrics.discord_queue_depth.set(queue.length); } catch {}
    if (j) { try { await j(); } catch {} }
  });
}

// Auto-tune QPS based on recent 429s
let last429 = 0;
let currentQps = QPS;
const MAX_QPS = Math.max(QPS, Number(process.env.DISCORD_QPS_MAX || 50));
const MIN_QPS = Math.max(5, Number(process.env.DISCORD_QPS_MIN || 20));
const INC_STEP = Math.max(1, Number(process.env.DISCORD_QPS_INC || 2));
const DEC_FACTOR = Number(process.env.DISCORD_QPS_DEC_FACTOR || 0.85);

setInterval(() => {
  try {
    const total = metrics.discord_rate_limit_hits.get?.() ?? 0;
    const delta = total - last429;
    last429 = total;
    if (delta > 0) {
      currentQps = Math.max(MIN_QPS, Math.floor(currentQps * DEC_FACTOR));
    } else {
      currentQps = Math.min(MAX_QPS, currentQps + INC_STEP);
    }
    // apply
    postLimiter.updateSettings({ reservoir: currentQps, reservoirRefreshAmount: currentQps });
  } catch {}
}, 60 * 1000);
