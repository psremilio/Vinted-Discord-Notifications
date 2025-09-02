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
const chanBuf = new Map(); // channelId -> { buf: Array<{discoveredAt, createdAt, channel, payload}>, timer }
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
  try { metrics.reorder_buffer_depth.set({ channel: id }, st.buf.length); } catch {}
  if (!eligible.length) return;
  // chronologisch nach createdAt aufsteigend (ältere zuerst)
  eligible.sort((a, b) => (Number(a.createdAt||0) - Number(b.createdAt||0)) || (a.discoveredAt - b.discoveredAt));
  const maxFlush = Math.max(1, Number(process.env.REORDER_FLUSH_MAX || 3));
  const slice = eligible.slice(0, maxFlush);
  const keep = eligible.slice(maxFlush);
  // Nicht geflushedes zurück in Buffer legen
  st.buf = keep.concat(st.buf);
  for (const job of slice) enqueueRoute(job.channel, job.payload, job.discoveredAt);
  if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') {
    console.log(`[post.flush] channel=${id} released=${slice.length} remain=${st.buf.length}`);
  }
}

// Optional webhook fanout config: JSON mapping channelId -> [webhookURL,...]
let WEBHOOK_MAP = null; try { WEBHOOK_MAP = JSON.parse(process.env.DISCORD_WEBHOOKS_JSON || 'null'); } catch {}

export async function sendQueued(channel, payload, meta = {}) {
  // Simple backpressure: drop tail if queue exceeds MAX_QUEUE
  try { metrics.discord_queue_depth.set(queue.length); } catch {}
  if (queue.length >= MAX_QUEUE) {
    metrics.discord_dropped_total.inc();
    return; // drop
  }
  // Optional per-channel reorder window
  const discoveredAt = Number(meta?.discoveredAt || Date.now());
  const createdAt = Number(meta?.createdAt || Date.now());
  if (REORDER_WINDOW_MS > 0 && channel?.id) {
    const st = ensureChannelBuffer(channel);
    st.buf.push({ discoveredAt, createdAt, channel, payload });
    try { metrics.reorder_buffer_depth.set({ channel: channel.id }, st.buf.length); } catch {}
    return;
  }
  enqueueRoute(channel, payload, discoveredAt, createdAt);
}

// Route-aware per-bucket queues (bucket ≈ channel route)
const routeBuckets = new Map(); // key -> { q: Array<{channel,payload,discoveredAt}>, cooldownUntil: number }
function bucketKey(channel) { return `chan:${channel?.id || 'UNKNOWN'}`; }
function getBucket(channel) {
  const key = bucketKey(channel);
  let b = routeBuckets.get(key);
  if (!b) { b = { q: [], cooldownUntil: 0 }; routeBuckets.set(key, b); }
  return [key, b];
}

function enqueueRoute(channel, payload, discoveredAt, createdAt) {
  const [, b] = getBucket(channel);
  const job = { channel, payload, discoveredAt, createdAt };
  // If webhooks configured for this channel, pick next webhook URL (round-robin by length)
  const webhooks = channel?.id && WEBHOOK_MAP && Array.isArray(WEBHOOK_MAP[channel.id]) ? WEBHOOK_MAP[channel.id] : null;
  if (webhooks && webhooks.length) {
    const idx = b._rr || 0;
    job.webhookUrl = webhooks[idx % webhooks.length];
    b._rr = (idx + 1) % webhooks.length;
  }
  b.q.push(job);
}

// WFQ-like scheduler: per second serve up to currentQps, 1 msg per bucket per tick
setInterval(() => {
  let slots = currentQps;
  const now = Date.now();
  const keys = Array.from(routeBuckets.keys());
  for (const key of keys) {
    if (slots <= 0) break;
    const b = routeBuckets.get(key);
    if (!b || b.q.length === 0) continue;
    if (b.cooldownUntil > now) continue;
    const job = b.q.shift();
    slots--;
    // send with concurrency limiter
    postLimiter.schedule(() => doSend(job, b)).catch(() => {});
  }
  if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') {
    const ready = keys.filter(k => (routeBuckets.get(k)?.q?.length||0)>0).length;
    console.log(`[post.tick] qps=${currentQps} bucketsReady=${ready} slotsLeft=${slots}`);
  }
}, 1000);

async function doSend(job, bucket) {
  const now = Date.now();
  if (discordCooldownUntil > now) {
    try { metrics.discord_cooldown_active.set(1); } catch {}
    await new Promise(r => setTimeout(r, Math.min(5000, discordCooldownUntil - now)));
  } else {
    try { metrics.discord_cooldown_active.set(0); } catch {}
  }
  try {
    let res;
    if (job.webhookUrl) {
      // Send via webhook (route-fanout)
      res = await sendWebhook(job.webhookUrl, job.payload);
    } else {
      res = await job.channel.send(job.payload);
    }
    const latency = Date.now() - (Number(job.discoveredAt) || now);
    recordPostLatency(latency);
    try { metrics.discord_cooldown_active.set(0); } catch {}
    return res;
  } catch (e) {
    if (is429(e)) metrics.discord_rate_limit_hits.inc();
    const retry = Math.max(
      Number(e?.retry_after || e?.data?.retry_after || e?.rawError?.retry_after || 0) * 1000,
      Number(e?.headers?.['x-ratelimit-reset-after'] || 0) * 1000
    );
    if (retry > 0) {
      bucket.cooldownUntil = Date.now() + retry;
      discordCooldownUntil = Math.max(discordCooldownUntil, bucket.cooldownUntil);
      try { metrics.discord_cooldown_active.set(1); } catch {}
    }
    throw e;
  }
}

// Post latency p95
const postLats = [];
function recordPostLatency(ms) { postLats.push(ms); if (postLats.length > 500) postLats.shift(); }
setInterval(() => {
  if (!postLats.length) return;
  const a = postLats.slice().sort((x, y) => x - y);
  const p95 = a[Math.min(a.length - 1, Math.floor(a.length * 0.95))];
  try { metrics.post_latency_ms_p95.set(p95); } catch {}
}, 60 * 1000);

// Minimal webhook sender via fetch (undici or global)
async function sendWebhook(url, payload) {
  // Discord expects JSON with content/embeds/components; payload passthrough
  const body = JSON.stringify(payload);
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  if (res.status === 429) {
    metrics.discord_rate_limit_hits.inc();
    const retryAfter = Number((await res.json().catch(()=>({})))?.retry_after || 0) * 1000;
    if (retryAfter > 0) await new Promise(r => setTimeout(r, retryAfter));
    throw new Error('429');
  }
  if (!res.ok) {
    const txt = await res.text().catch(()=> '');
    throw new Error(`webhook ${res.status} ${txt}`);
  }
  return res;
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
