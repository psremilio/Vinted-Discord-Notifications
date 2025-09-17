import Bottleneck from 'bottleneck';
import { Pool, ProxyAgent } from 'undici';
import { sanitizeEmbeds } from '../discord/ensureValidEmbed.js';
import { DiscordBucket } from '../post/DiscordBucket.js';
import { metrics } from './metrics.js';
import { getWebhooksForChannelId, ensureWebhooksForChannel } from './webhooksManager.js';
import { ensureAfter404 } from '../discord/webhookEnsure.js';
import { remove as removeWebhookFromStore } from './webhooksStore.js';

const QPS = Math.max(1, Number(process.env.DISCORD_QPS || process.env.DISCORD_QPS_MAX || 50));
// QPS compatibility: used only to compute 'slots' in the scheduler loop.
// Actual rate control uses per-Discord-bucket token buckets.
const QPS_MIN = Math.max(1, Number(process.env.DISCORD_QPS_MIN || 10));
const QPS_MAX = Math.max(QPS_MIN, Number(process.env.DISCORD_QPS_MAX || 80));
let currentQps = Math.min(Math.max(Math.floor(Number(process.env.DISCORD_QPS || QPS_MIN)), QPS_MIN), QPS_MAX);
function setQps(n) { currentQps = Math.min(Math.max(Math.floor(Number(n)), QPS_MIN), QPS_MAX); }
const DIAG_ALL = String(process.env.DIAG_ALL || '0') === '1';
const DIAG_SAMPLE_N = Math.max(1, Number(process.env.DIAG_SAMPLE_N || 1));
let __diag_i = 0;
function diag(tag, obj) {
  if (!DIAG_ALL) return;
  try {
    __diag_i += 1;
    const n = DIAG_SAMPLE_N;
    if ((__diag_i % n) === 0) console.log(`[diag.${tag}]`, JSON.stringify(obj));
  } catch {}
}
// Higher defaults to improve send throughput while keeping QPS guardrails
const CONC = Math.max(1, Number(process.env.DISCORD_POST_GLOBAL_CONC || process.env.DISCORD_POST_CONCURRENCY || 8));
const CONC_MAX = Math.max(CONC, Number(process.env.DISCORD_POST_CONCURRENCY_MAX || 24));
// Optional fast-path: allow near-immediate posting per-channel (default ON)
const FAST_POST = String(process.env.FAST_POST || '1') === '1';
const REORDER_WINDOW_MS = FAST_POST ? 0 : Math.max(0, Number(process.env.REORDER_WINDOW_MS || 1000));
// Default: do NOT drop older items unless explicitly enabled via env
const POST_MAX_AGE_MS = (() => {
  const raw = process.env.MAX_POST_AGE_MS ?? process.env.POST_MAX_AGE_MS ?? process.env.DROP_OLD_AFTER_MS;
  if (raw !== undefined) {
    const val = Number(raw);
    if (Number.isFinite(val) && val >= 0) return val;
  }
  return 3 * 60 * 1000;
})();
const BOOTSTRAP_POST_MAX_AGE_MS = Math.max(0, Number(process.env.BOOTSTRAP_POST_MAX_AGE_MS || process.env.BOOTSTRAP_MAX_AGE_MS || 0));
const LOG_DROP_OLD = String(process.env.LOG_DROP_OLD || '1') === '1';

// Micro-batching controls
const BATCH_WINDOW_MS = Math.max(0, Number(process.env.POST_BATCH_WINDOW_MS || 200));
const BATCH_MAX = Math.max(1, Number(process.env.POST_BATCH_EMBEDS_MAX || 2));
// Default batching OFF until per-bucket limiter is stable
const ENABLE_BATCHING = String(process.env.POST_BATCHING || '0') === '1';

// Per-route concurrency guard: Discord webhook buckets behave best with 1 in-flight
// Default to 1 to avoid parallel sends on the same route. Can be raised via env
// if you know your limits.
const ROUTE_MAX_CONC = Math.max(1, Number(process.env.DISCORD_ROUTE_MAX_CONC || 1));

// Simple global token bucket (per-second) as an extra guard layer.
const TB_CAP = Math.max(1, Number(process.env.DISCORD_QPS_MAX || 60));
const TB_REFILL = TB_CAP; // refill full capacity each second
const tokenBucket = { capacity: TB_CAP, tokens: TB_CAP, refillPerSec: TB_REFILL };
setInterval(() => {
  tokenBucket.tokens = Math.min(tokenBucket.capacity, tokenBucket.tokens + tokenBucket.refillPerSec);
}, 1000).unref?.();
async function takeToken() {
  while (tokenBucket.tokens < 1) { await new Promise(r => setTimeout(r, 20)); }
  tokenBucket.tokens -= 1;
}

// Shared HTTP connection pools per-origin for webhook posts (keep-alive)
const dispatcherPools = new Map(); // key(origin|mode) -> dispatcher
const DISCORD_PROXY = process.env.DISCORD_HTTP_PROXY || process.env.HTTPS_PROXY || '';
function originOf(url) {
  try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return null; }
}
function getDispatcher(url) {
  const origin = originOf(url);
  if (!origin) return null;
  const key = DISCORD_PROXY ? 'proxy:' + DISCORD_PROXY : origin;
  let p = dispatcherPools.get(key);
  if (!p) {
    p = DISCORD_PROXY
      ? new ProxyAgent(DISCORD_PROXY)
      : new Pool(origin, {
          connections: Math.max(8, Number(process.env.WEBHOOK_POOL_CONNECTIONS || 32)),
          pipelining: Math.max(1, Number(process.env.WEBHOOK_POOL_PIPELINING || 1)),
          keepAliveTimeout: Math.max(1000, Number(process.env.WEBHOOK_KEEPALIVE_TIMEOUT_MS || 5000)),
          keepAliveMaxTimeout: Math.max(2000, Number(process.env.WEBHOOK_KEEPALIVE_MAX_TIMEOUT_MS || 10000)),
        });
    dispatcherPools.set(key, p);
  }
  return p;
}

// Concurrency-only limiter; no global QPS reservoir
export const postLimiter = new Bottleneck({ maxConcurrent: CONC });
// Track current concurrency for auto-tune adjustments
let currentConc = CONC;

function is429(err) {
  const s = Number(err?.status || err?.httpStatus || 0);
  return s === 429;
}

const MAX_QUEUE = Math.max(2000, Number(process.env.DISCORD_QUEUE_MAX || 5000));
// Backlog purge config
const PURGE_ENABLED = String(process.env.DROP_OLD_WHEN_BACKLOG || '1') === '1';
const PURGE_INTERVAL_MS = Math.max(2000, Number(process.env.BACKLOG_PURGE_INTERVAL_MS || 5000));
const STALE_PURGE_Q_THR = Math.max(200, Number(process.env.STALE_PURGE_QUEUE_THRESHOLD || 400));
const STALE_PURGE_MAX_AGE_MS = Math.max(60_000, Number(process.env.STALE_PURGE_MAX_AGE_MS || 10 * 60 * 1000));
let discordCooldownUntil = 0;
const ensureInFlight = new Set(); // channelId being ensured

// Per-channel reorder buffers
const chanBuf = new Map(); // channelId -> { buf: Array<{discoveredAt, createdAt, firstMatchedAt, channel, payload, itemId}>, timer }
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
  // Neueste zuerst: createdAt, dann firstMatchedAt, dann discoveredAt
  eligible.sort((a, b) =>
    (Number(b.createdAt||0) - Number(a.createdAt||0)) ||
    (Number(b.firstMatchedAt||0) - Number(a.firstMatchedAt||0)) ||
    (b.discoveredAt - a.discoveredAt)
  );
  // Backlog-aware Flushgröße: min( max(POST_BURST_MIN, ceil(queue/10)), POST_BURST_MAX )
  const totalBacklog = eligible.length + st.buf.length;
  const BURST_MIN = Math.max(1, Number(process.env.POST_BURST_MIN || 3));
  const BURST_MAX = Math.max(BURST_MIN, Number(process.env.POST_BURST_MAX || 30));
  let dyn = Math.max(BURST_MIN, Math.ceil(totalBacklog / 10));
  if (totalBacklog > 50) dyn = Math.min(BURST_MAX, dyn + 10); // boost when backlog high
  dyn = Math.min(BURST_MAX, dyn);
  const slice = eligible.slice(0, dyn);
  const keep = eligible.slice(dyn);
  // Nicht geflushedes zurück in Buffer legen
  st.buf = keep.concat(st.buf);
  for (const job of slice) enqueueRoute(job.channel, job.payload, job.discoveredAt, job.createdAt, job.itemId, job.firstMatchedAt);
  if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') {
    console.log(`[post.flush] channel=${id} released=${slice.length} remain=${st.buf.length} backlog=${totalBacklog}`);
  }
}

// Optional webhook fanout config: JSON mapping channelId -> [webhookURL,...]
let WEBHOOK_MAP = null; try { WEBHOOK_MAP = JSON.parse(process.env.DISCORD_WEBHOOKS_JSON || 'null'); } catch {}

// Returns an object describing the enqueue outcome:
// { ok: boolean, reason?: 'queue_full'|'too_old', buffered?: boolean, enqueued?: boolean }
// Compute current queue depth across all buckets and reorder buffers
function _totalRouteDepth() {
  let sum = 0;
  try { for (const b of routeBuckets.values()) sum += (b?.q?.length || 0); } catch {}
  return sum;
}
function _totalReorderDepth() {
  let sum = 0;
  try { for (const st of chanBuf.values()) sum += (st?.buf?.length || 0); } catch {}
  return sum;
}

export async function sendQueued(channel, payload, meta = {}) {
  const ALWAYS_WEBHOOK = String(process.env.ALWAYS_WEBHOOK || process.env.FORCE_WEBHOOKS || '0') === '1';
  // Backpressure: drop tail if combined depth exceeds MAX_QUEUE
  const depth = _totalRouteDepth() + _totalReorderDepth();
  try { metrics.discord_queue_depth.set(depth); } catch {}
  if (depth >= MAX_QUEUE) {
    metrics.discord_dropped_total.inc();
    diag('enqueue', { cid: channel?.id || null, item: meta?.itemId || null, mode: 'drop', reason: 'queue_full', q: depth });
    return { ok: false, reason: 'queue_full' };
  }
  // Optional per-channel reorder window
  const discoveredAt = Number(meta?.discoveredAt || Date.now());
  const createdAt = Number(meta?.createdAt || Date.now());
  const firstMatchedAt = meta?.firstMatchedAt ? Number(meta.firstMatchedAt) : undefined;
  // Drop if too old on enqueue to avoid late spam
  const postLimit = (meta?.isBootstrap && BOOTSTRAP_POST_MAX_AGE_MS > 0) ? BOOTSTRAP_POST_MAX_AGE_MS : POST_MAX_AGE_MS;
  if (postLimit > 0 && createdAt && (Date.now() - createdAt) > postLimit) {
    if (LOG_DROP_OLD) {
      try {
        const age = Date.now() - createdAt;
        console.warn('[post.drop_old]', 'channel=', channel?.id || 'unknown', 'age_ms=', age, 'limit_ms=', postLimit, 'bootstrap=', !!meta?.isBootstrap);
      } catch {}
    }
    diag('enqueue', { cid: channel?.id || null, item: meta?.itemId || null, mode: 'drop', reason: 'too_old', post_max_age_ms: postLimit, bootstrap: !!meta?.isBootstrap });
    return { ok: false, reason: 'too_old' };
  }
  const itemId = meta?.itemId ? String(meta.itemId) : null;
  // Optional: global cross-rule dedupe (process-wide)
  if (itemId && POST_GLOBAL_DEDUPE && _isRecentlyPostedGlobal(itemId)) {
    diag('enqueue', { cid: channel?.id || null, item: itemId, mode: 'drop', reason: 'dup_global' });
    return { ok: true };
  }
  // Use a per-route enqueue timestamp to measure queue latency fairly per channel
  const discoveredAtLocal = Date.now();
  // If channel cannot send and no webhooks configured, emit a clear warning once.
  try {
    const hooks = getWebhooksForChannelId?.(channel?.id) || [];
    if (!hooks.length && !(channel && typeof channel.send === 'function')) {
      console.warn('post channel has no webhooks and does not support send:', String(channel?.id || 'unknown'));
    }
  } catch {}
  // Optional: ensure webhooks synchronously before first enqueue when ALWAYS_WEBHOOK=1
  if (ALWAYS_WEBHOOK && channel?.id) {
    try {
      const curr = getWebhooksForChannelId(channel.id) || [];
      if (!curr.length) { await ensureWebhooksForChannel(channel); diag('webhooks.ensure.sync', { cid: channel.id }); }
    } catch {}
  }
  // Drop at enqueue if recently posted in same channel (cross-rule duplicate)
  try {
    if (itemId && channel?.id && _isRecentlyPosted(channel.id, itemId)) {
      if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log('[post.drop_dup_recent]', 'channel=', channel.id, 'item=', itemId);
      diag('enqueue', { cid: channel?.id || null, item: itemId, mode: 'drop', reason: 'dup_recent' });
      return { ok: true };
    }
  } catch {}
  // Fresh-fast path: bypass reorder buffer for very fresh items
  // Treat very new items as fast-path by default (≤2min)
  const FRESH_FAST_MS = Math.max(0, Number(process.env.FRESH_FASTPATH_MS || 120_000));
  const isFreshFast = FRESH_FAST_MS > 0 && createdAt && (Date.now() - createdAt) <= FRESH_FAST_MS;
  if (!isFreshFast && REORDER_WINDOW_MS > 0 && channel?.id) {
    if (itemId && _isQueued(channel.id, itemId)) return { ok: true, buffered: true };
    const st = ensureChannelBuffer(channel);
    st.buf.push({ discoveredAt: discoveredAtLocal, createdAt, firstMatchedAt, channel, payload, itemId });
    try { metrics.reorder_buffer_depth.set({ channel: channel.id }, st.buf.length); } catch {}
    if (itemId) _markQueued(channel.id, itemId);
    diag('enqueue', { cid: channel?.id || null, item: itemId, mode: 'buffer', reorder_depth: st.buf.length });
    return { ok: true, buffered: true };
  }
  enqueueRoute(channel, payload, discoveredAtLocal, createdAt, itemId, firstMatchedAt);
  diag('enqueue', { cid: channel?.id || null, item: itemId, mode: 'route' });
  return { ok: true, enqueued: true };
}

// Route-aware per-bucket queues (bucket ≈ channel route)
const routeBuckets = new Map(); // key -> { q: Array<{channel,payload,discoveredAt,createdAt,itemId,webhookUrl,_retries?:number}>, cooldownUntil: number, ids:Set<string>, inflight:number, channelId:string, dbKey?:string, db?:DiscordBucket }
const rrByChannel = new Map(); // channelId -> next webhook index (fallback)
// Lightweight per-route header cache to enable proactive rotation when near limit
const routeHdr = new Map(); // routeKey -> { remaining:number, resetUntil:number, bucketId?:string }
// Shared Discord buckets keyed by x-ratelimit-bucket (or temporary route key)
const discordBuckets = new Map(); // dkey -> DiscordBucket
function discordBucketsGet(key) {
  const k = String(key || '');
  let b = discordBuckets.get(k);
  if (!b) { b = new DiscordBucket(k); discordBuckets.set(k, b); }
  return b;
}
function _setHdr(key, { remaining, resetMs, bucketId }) {
  try {
    const until = resetMs > 0 ? Date.now() + resetMs : 0;
    routeHdr.set(String(key), { remaining: Number.isFinite(remaining) ? remaining : undefined, resetUntil: until, bucketId: bucketId || undefined });
  } catch {}
}
function _getHdr(key) { return routeHdr.get(String(key)) || {}; }
const chanQueued = new Map(); // channelId -> Set<itemId>
function _getChanSet(cid) { let s = chanQueued.get(cid); if (!s) { s = new Set(); chanQueued.set(cid, s); } return s; }
function _isQueued(cid, id) { if (!cid || !id) return false; const s = chanQueued.get(cid); return s ? s.has(id) : false; }
function _markQueued(cid, id) { if (!cid || !id) return; _getChanSet(cid).add(id); }
function _unmarkQueued(cid, id) { if (!cid || !id) return; const s = chanQueued.get(cid); if (s) s.delete(id); }
// Recently posted guard (to avoid duplicates across overlapping rules to same channel)
const recentPosted = new Map(); // channelId -> Map<itemId, expireAt>
const DUP_TTL_MS = Math.max(30_000, Number(process.env.DUPLICATE_TTL_MS || 120_000));
function _gcRecent(cid) {
  try {
    const m = recentPosted.get(cid); if (!m) return;
    const now = Date.now();
    for (const [id, exp] of m.entries()) if (!exp || exp <= now) m.delete(id);
    if (m.size === 0) recentPosted.delete(cid);
  } catch {}
}
function _isRecentlyPosted(cid, id) {
  if (!cid || !id) return false;
  _gcRecent(cid);
  const m = recentPosted.get(cid); if (!m) return false;
  return m.has(id);
}
function _markRecentlyPosted(cid, id) {
  if (!cid || !id) return;
  let m = recentPosted.get(cid); if (!m) { m = new Map(); recentPosted.set(cid, m); }
  m.set(id, Date.now() + DUP_TTL_MS);
}

// Optional global cross-rule dedupe (across all channels)
const POST_GLOBAL_DEDUPE = String(process.env.POST_GLOBAL_DEDUPE || '0') === '1';
const GLOBAL_DUP_TTL_MS = Math.max(30_000, Number(process.env.POST_GLOBAL_DUP_TTL_MS || 10 * 60 * 1000));
const recentGlobal = new Map(); // itemId -> expireAt
function _gcGlobal() {
  try {
    const now = Date.now();
    for (const [id, exp] of recentGlobal.entries()) if (!exp || exp <= now) recentGlobal.delete(id);
  } catch {}
}
function _isRecentlyPostedGlobal(id) {
  if (!id) return false;
  _gcGlobal();
  return recentGlobal.has(String(id));
}
function _markRecentlyPostedGlobal(id) {
  if (!id) return;
  recentGlobal.set(String(id), Date.now() + GLOBAL_DUP_TTL_MS);
}
function getBucketByKey(key, channelId) {
  let b = routeBuckets.get(key);
  if (!b) { b = { q: [], cooldownUntil: 0, ids: new Set(), inflight: 0, channelId: String(channelId || ''), key: String(key) }; routeBuckets.set(key, b); }
  return [key, b];
}

function fnv1a32(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h >>> 0) + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)); } return h >>> 0; }

function enqueueRoute(channel, payload, discoveredAt, createdAt) {
  const cid = channel?.id || 'UNKNOWN';
  // Determine item id early for global dedupe
  let itemId = typeof arguments[4] === 'string' ? arguments[4] : null;
  if (!itemId) itemId = payload?.embeds?.[0]?.data?.fields?.find?.(f => /`\d+`/.test(f?.value || ''))?.value?.replace(/`/g,'');
  const firstMatchedAt = typeof arguments[5] === 'number' ? arguments[5] : undefined;
  const idKey = itemId ? String(itemId) : null;
  if (idKey && _isQueued(cid, idKey)) return; // already queued globally for this channel

  // Decide route (per-webhook when available)
  let routeKey = `chan:${cid}`;
  let chosenWebhook = null;
  const webhooks = cid ? getWebhooksForChannelId(cid) : null;
  if (String(process.env.FORCE_CHANNEL_POST || '0') === '1') {
    // bypass webhooks route for debugging/troubleshooting
  } else if (webhooks && webhooks.length) {
    // Deterministic sharding by itemId when available, else round-robin
    let idx = null;
    if (idKey) {
      idx = fnv1a32(idKey) % webhooks.length;
    } else {
      const rr = (rrByChannel.has(cid) ? rrByChannel.get(cid) : Math.floor(Math.random() * webhooks.length));
      idx = rr % webhooks.length;
      rrByChannel.set(cid, (rr + 1) % webhooks.length);
    }
    chosenWebhook = webhooks[idx];
    routeKey = `chan:${cid}:wh:${idx}`;
  } else if (cid && String(process.env.AUTO_WEBHOOKS_ON_POST || '0') === '1') {
    // lazy auto-ensure (non-blocking)
    if (!ensureInFlight.has(cid)) {
      ensureInFlight.add(cid);
      ensureWebhooksForChannel(channel).catch(()=>{}).finally(()=>ensureInFlight.delete(cid));
      if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log(`[webhooks.ensure.lazy] channel=${cid}`);
    }
  }
  const [, b] = getBucketByKey(routeKey, cid);
  // coalesce duplicates per bucket
  if (idKey && b.ids.has(idKey)) return;
  const job = { channel, payload, discoveredAt, createdAt, firstMatchedAt, itemId: idKey };
  if (chosenWebhook) job.webhookUrl = chosenWebhook;
  else if (String(process.env.POST_VIA_WEBHOOK_ONLY || '0') === '1') {
    // When posting strictly via webhooks, skip enqueue if none available
    if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.warn('[post.skip_no_webhook]', 'channel=', cid, 'item=', idKey);
    return;
  }
  b.q.push(job);
  if (idKey) { b.ids.add(idKey); _markQueued(cid, idKey); }
  diag('route.assign', { cid, item: idKey, wh_count: (webhooks||[]).length || 0, route: chosenWebhook ? 'webhook' : 'channel', routeKey });
}

// WFQ-like scheduler: per second serve up to currentQps, 1 msg per bucket per tick
setInterval(() => {
  try {
  let slots = Number.isFinite(currentQps) ? currentQps : QPS_MIN;
  const now = Date.now();
  let keys = Array.from(routeBuckets.keys());
  // Build channel -> bucket list index for potential migration
  const byChannel = new Map();
  for (const k of keys) {
    const b = routeBuckets.get(k); if (!b) continue;
    const cid = String(b.channelId || '');
    if (!byChannel.has(cid)) byChannel.set(cid, []);
    byChannel.get(cid).push(k);
  }
  // dynamic per-bucket sends (burst window)
  const totalQ = keys.reduce((a,k)=> a + (routeBuckets.get(k)?.q?.length||0), 0);
  const cooldown = metrics.discord_cooldown_active.get?.() || 0;
  const MAX_PER_BUCKET = Math.max(1, Number(process.env.MAX_PER_BUCKET || 25));
  const ready = keys.filter(k => (routeBuckets.get(k)?.q?.length||0)>0).length || 1;
  // Distribute work proportionally across buckets: ceil(totalQ/ready)
  let perBucketSends = Math.ceil(totalQ / ready);
  perBucketSends = Math.max(1, Math.min(MAX_PER_BUCKET, perBucketSends));
  // Reduce aggressiveness when cooldown active
  if (cooldown) perBucketSends = Math.max(1, Math.floor(perBucketSends / 2));
  // do up to perBucketSends passes for fairness
  // prioritize buckets with freshest head createdAt when backlog is high
  // Prioritize buckets with freshest heads sooner to reduce tail latencies (hot-lane first)
  if (totalQ > 20) {
    const HOT_AGE_MS = Math.max(0, Number(process.env.HOT_AGE_MS || 20_000));
    const nowMs = Date.now();
    const headCreated = (k)=>{ const b=routeBuckets.get(k); const q=b?.q||[]; if(!q.length) return 0; let m=0; for (const it of q) { const v=Number(it?.createdAt||0); if (v>m) m=v; } return m; };
    const isHot = (k)=>{ const t=headCreated(k); return t>0 && (nowMs - t) <= HOT_AGE_MS; };
    keys = keys.slice().sort((a,b)=> {
      const ha = isHot(a), hb = isHot(b);
      if (ha !== hb) return ha ? -1 : 1; // hot first
      return headCreated(b) - headCreated(a);
    });
  }
  // Do not migrate across webhooks while a bucket is cooling down. When webhooks
  // share a route bucket, migration causes repeated 429s. Default OFF.
  const MIGRATE_ON_COOLDOWN = String(process.env.MIGRATE_ON_COOLDOWN || '1') === '1';
  const PROACTIVE_ROTATE = String(process.env.PROACTIVE_ROTATE || '1') === '1';
  for (let pass = 0; pass < perBucketSends && slots > 0; pass++) {
    for (const key of keys) {
      if (slots <= 0) break;
      const b = routeBuckets.get(key);
      if (!b || b.q.length === 0) continue;
      // Determine Discord bucket object: use learned x-ratelimit-bucket id if available,
      // otherwise use a temporary per-route key to avoid thundering herd until we learn it.
      if (!b.db) {
        const tmpKey = b.dbKey || `route:${key}`;
        b.db = discordBucketsGet(tmpKey);
      }
      // Proactive rotation: if this bucket is near limit (remaining<=1) and we have siblings with headroom, move head job
      if (PROACTIVE_ROTATE && b.q.length > 1) {
        const hdr = _getHdr(key);
        if (hdr && typeof hdr.remaining === 'number' && hdr.remaining <= 1) {
          const sibs = byChannel.get(String(b.channelId || '')) || [];
          const targetKey = sibs.find(k2 => {
            if (k2 === key) return false;
            const hb = routeBuckets.get(k2); if (!hb || hb.cooldownUntil > now) return false;
            const h2 = _getHdr(k2);
            if (typeof h2.remaining === 'number' && h2.remaining >= 2) return true;
            return false;
          });
          if (targetKey) {
            const job = b.q.shift();
            const tb = routeBuckets.get(targetKey);
            if (job && tb) {
              try { if (job?.itemId) b.ids.delete(job.itemId); } catch {}
              tb.q.push(job);
              try { if (job?.itemId) tb.ids.add(job.itemId); } catch {}
              if (String(process.env.LOG_ROUTE || '0') === '1') {
                try { console.log('[post.rotate]', 'cid=', String(b.channelId||''), 'item=', String(job?.itemId||''), 'from=', key, 'to=', targetKey); } catch {}
              }
            }
          }
        }
      }
      // Enforce per-bucket token availability
      if (b.db && !b.db.canSend(now)) {
        // schedule resume at bucket reset; set route cooldown as a hint
        b.cooldownUntil = Math.max(b.cooldownUntil || 0, b.db.resetAt + b.db.safetyMs);
        continue;
      }
      if (b.cooldownUntil > now) {
        if (MIGRATE_ON_COOLDOWN) {
          // try to migrate head job to another webhook bucket of same channel without cooldown
          const sibs = byChannel.get(String(b.channelId || '')) || [];
          const targetKey = sibs.find(k2 => k2 !== key && (routeBuckets.get(k2)?.cooldownUntil || 0) <= now);
          if (targetKey && b.q.length) {
            const job = b.q.shift();
            const tb = routeBuckets.get(targetKey);
            if (job && tb) {
              try { if (job?.itemId) b.ids.delete(job.itemId); } catch {}
              tb.q.push(job);
              try { if (job?.itemId) tb.ids.add(job.itemId); } catch {}
              if (String(process.env.LOG_ROUTE || '0') === '1') {
                try { console.log('[post.migrate]', 'cid=', String(b.channelId||''), 'item=', String(job?.itemId||''), 'from=', key, 'to=', targetKey); } catch {}
              }
            }
          }
        }
        continue;
      }
      // Per-route concurrency: default 1. Discord webhook bucket is not safe to parallelize.
      const CHAN_CONC = ROUTE_MAX_CONC;
      if ((b.inflight || 0) >= CHAN_CONC) continue;
      // priority: createdAt desc, then firstMatchedAt desc, then discoveredAt desc
      b.q.sort((a,bj)=> (Number(bj.createdAt||0) - Number(a.createdAt||0)) || (Number(bj.firstMatchedAt||0) - Number(a.firstMatchedAt||0)) || (bj.discoveredAt - a.discoveredAt));
      // stale deferral when backlog is high
      const STALE_MIN_MS = Math.max(1, Number(process.env.STALE_DEFER_MIN_MS || 10 * 60 * 1000));
      const STALE_Q_THR = Math.max(100, Number(process.env.STALE_DEFER_QUEUE_THRESHOLD || 400));
      let job = b.q[0];
      if (job && totalQ >= STALE_Q_THR && (now - Number(job.createdAt || now)) >= STALE_MIN_MS) { b.q.push(b.q.shift()); job = b.q[0]; }
      job = b.q.shift();
      if (job?.itemId) try { b.ids.delete(job.itemId); } catch {}
      slots--;
      // Virtually take a token before we dispatch to avoid stampedes
      try { b.db?.onRequestQueued(); } catch {}
      b.inflight = (b.inflight || 0) + 1;
      postLimiter.schedule(() => doSend(job, b)).catch(() => {}).finally(() => { b.inflight = Math.max(0, (b.inflight||1) - 1); });
    }
  }
  if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug' || String(process.env.LOG_QUEUE_TICK||'0')==='1') {
    console.log(`[post.tick] bucketsReady=${ready} slotsLeft=${slots} totalQ=${totalQ} perBucket=${perBucketSends}`);
  }
  // per-route depth metric
  try {
    const sums = new Map();
    for (const k of keys) {
      const b = routeBuckets.get(k);
      if (!b) continue;
      const cid = String(b.channelId || '').replace('chan:','');
      const prev = sums.get(cid) || 0;
      sums.set(cid, prev + (b.q?.length || 0));
    }
    for (const [cid, depth] of sums.entries()) metrics.route_queue_depth.set({ channel: cid }, depth);
  } catch {}
  } catch (e) {
    try { console.error('[post.tick.fatal]', e?.stack || e?.message || e); } catch {}
    try { setQps(QPS_MIN); } catch {}
  }
}, 1000);

// Purge all queued posts for a given channel (route + reorder buffer)
export function purgeChannelQueues(channelId) {
  try {
    if (!channelId) return;
    const prefix = `chan:${channelId}`;
    for (const k of Array.from(routeBuckets.keys())) {
      if (!k.startsWith(prefix)) continue;
      const b = routeBuckets.get(k);
      if (b) { b.q = []; b.ids = new Set(); routeBuckets.delete(k); }
    }
    try { const s = chanQueued.get(String(channelId)); if (s) s.clear(); } catch {}
    try { metrics.route_queue_depth.set({ channel: String(channelId) }, 0); } catch {}
    const st = chanBuf.get(channelId);
    if (st) {
      try { clearInterval(st.timer); } catch {}
      chanBuf.delete(channelId);
      try { metrics.reorder_buffer_depth.set({ channel: String(channelId) }, 0); } catch {}
    }
    if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log('[queue.purge]', 'channel=', channelId);
  } catch {}
}

async function doSend(job, bucket) {
  // Global per-second pacing guard; per-bucket pacing still applies below
  try { await takeToken(); } catch {}
  const now = Date.now();
  if (discordCooldownUntil > now) {
    try { metrics.discord_cooldown_active.set(1); } catch {}
    await new Promise(r => setTimeout(r, Math.min(5000, discordCooldownUntil - now)));
  } else {
    try { metrics.discord_cooldown_active.set(0); } catch {}
  }
  try {
    let res;
    const isWebhook = !!job.webhookUrl;
    const cid = job?.channel?.id;
    const sameWebhook = job.webhookUrl || null;

    // Micro-batching: coalesce up to BATCH_MAX embeds for the same route within a short window
    const canBatch = ENABLE_BATCHING && Array.isArray(job?.payload?.embeds);
    if (canBatch) {
      const embeds = [...(job.payload.embeds || [])].slice(0, BATCH_MAX);
      const coalescedIds = [];
      // optional short wait to let near-simultaneous finds coalesce
      if (BATCH_WINDOW_MS > 0) {
        await new Promise(r => setTimeout(r, BATCH_WINDOW_MS));
      }
      // drain compatible items from head of the same bucket (same channel + same webhook)
      while (embeds.length < BATCH_MAX && bucket.q.length) {
        const next = bucket.q[0];
        if (!next) break;
        if ((sameWebhook && next.webhookUrl !== sameWebhook) || next.channel?.id !== cid) break;
        const take = bucket.q.shift();
        if (take?.itemId) try { bucket.ids.delete(take.itemId); } catch {}
        if (take?.itemId) coalescedIds.push(String(take.itemId));
        const e2 = (take?.payload?.embeds || []);
        for (const e of e2) { if (embeds.length < BATCH_MAX) embeds.push(e); else break; }
      }
      const bundlePayload = { embeds };
      if (isWebhook) res = await sendWebhook(job.webhookUrl, bundlePayload, cid);
      else {
        res = await job.channel.send(bundlePayload);
        try { metrics.discord_channel_send_ok_total.inc({ channel: String(cid || '') }); } catch {}
        if (String(process.env.LOG_ROUTE || '0') === '1') {
          try { console.log('[post.send]', 'via=channel', 'channel=', String(cid||''), 'item=', String(job?.itemId||'')); } catch {}
        }
      }
      // After successful send, mark coalesced items as posted in channel/global dedupe
      try {
        for (const id of coalescedIds) {
          if (cid) _unmarkQueued(cid, id);
          _markRecentlyPosted(cid, id);
          if (POST_GLOBAL_DEDUPE) _markRecentlyPostedGlobal(id);
        }
      } catch {}
    } else {
      if (isWebhook) {
        // Send via webhook (route-fanout)
        res = await sendWebhook(job.webhookUrl, job.payload, cid);
      } else {
        if (String(process.env.POST_VIA_WEBHOOK_ONLY || '0') !== '1') {
          res = await job.channel.send(job.payload);
          try { metrics.discord_channel_send_ok_total.inc({ channel: String(cid || '') }); } catch {}
          if (String(process.env.LOG_ROUTE || '0') === '1') {
            try { console.log('[post.send]', 'via=channel', 'channel=', String(cid||''), 'item=', String(job?.itemId||'')); } catch {}
          }
        } else {
          throw new Error('webhook_required');
        }
      }
    }
    const latency = Date.now() - (Number(job.discoveredAt) || now);
    recordPostLatency(latency);
    try { recordQueueAge(job?.channel?.id, latency); } catch {}
    try { metrics.post_age_ms_histogram.set({ channel: String(job?.channel?.id || '') }, Math.max(0, now - Number(job.createdAt || now))); } catch {}
    try { metrics.discord_cooldown_active.set(0); } catch {}
    // Honor x-ratelimit-remaining/reset-after on success to pause precisely per route
    try {
      if (isWebhook && res && typeof res.headers?.get === 'function') {
        const rem = Number(res.headers.get('x-ratelimit-remaining') || '1');
        const resetAfterMs = Math.floor(Number(res.headers.get('x-ratelimit-reset-after') || '0') * 1000);
        const isGlobal = String(res.headers.get('x-ratelimit-global') || '').toLowerCase() === 'true';
        const bucketHdr = res.headers.get('x-ratelimit-bucket') || '';
        // update header cache for proactive rotation
        try { if (bucket?.key) _setHdr(bucket.key, { remaining: rem, resetMs: resetAfterMs, bucketId: bucketHdr }); } catch {}
        // Attach/migrate route to Discord bucket id so limits are shared
        if (bucketHdr) {
          bucket.dbKey = bucketHdr;
          bucket.db = discordBucketsGet(bucketHdr);
        }
        // Update bucket-level token bucket state
        try { bucket.db?.onHeaders(res.headers); } catch {}
        if (Number.isFinite(rem) && rem <= 0 && resetAfterMs > 0) {
          const jitter = Math.floor(Math.random() * 120) + 30;
          const wait = resetAfterMs + jitter;
          bucket.cooldownUntil = Date.now() + wait;
          try { metrics.discord_webhook_cooldowns_total?.inc({ channel: String(job?.channel?.id || '') }); } catch {}
          discordCooldownUntil = Math.max(discordCooldownUntil, bucket.cooldownUntil);
          try { metrics.discord_cooldown_active.set(1); } catch {}
        }
        if (isGlobal && resetAfterMs > 0) {
          const jitter = Math.floor(Math.random() * 120) + 30;
          const wait = resetAfterMs + jitter;
          discordCooldownUntil = Math.max(discordCooldownUntil, Date.now() + wait);
          try { metrics.discord_cooldown_active.set(1); } catch {}
        }
        // optional diagnostic
        if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') {
          try { console.log('[ratelimit.hdr]', 'cid=', String(job?.channel?.id||''), 'bucket=', bucketHdr, 'rem=', rem, 'reset_ms=', resetAfterMs); } catch {}
        }
      }
    } catch {}
    try {
      if (String(process.env.DIAG_TIMING || '0') === '1') {
        const createdAge = Math.max(0, now - Number(job.createdAt || now));
        console.log('[diag.post]', 'channel=', String(job?.channel?.id || ''), 'item=', String(job?.itemId || ''), 'age_listed_ms=', createdAge, 'queued_ms=', latency);
      }
    } catch {}
    diag('send.ok', { cid: String(job?.channel?.id || ''), item: String(job?.itemId || ''), via: job.webhookUrl ? 'webhook' : 'channel', latency_ms: latency, created_age_ms: Math.max(0, now - Number(job.createdAt || now)) });
    // mark channel-level as done and recent to avoid rapid duplicates across overlapping rules
    try { if (job?.itemId && job?.channel?.id) { _unmarkQueued(job.channel.id, job.itemId); _markRecentlyPosted(job.channel.id, job.itemId); } } catch {}
    // optional: mark global recent to avoid cross-rule duplicates across channels
    try { if (POST_GLOBAL_DEDUPE && job?.itemId) _markRecentlyPostedGlobal(job.itemId); } catch {}
    return res;
  } catch (e) {
    if (is429(e)) metrics.discord_rate_limit_hits.inc();
    const retry = Math.max(
      Number(e?.retry_after || e?.data?.retry_after || e?.rawError?.retry_after || 0) * 1000,
      Number(e?.headers?.['x-ratelimit-reset-after'] || 0) * 1000
    );
    if (retry > 0) {
      try { if (bucket?.key) _setHdr(bucket.key, { remaining: 0, resetMs: retry, bucketId: undefined }); } catch {}
      bucket.cooldownUntil = Date.now() + retry;
      discordCooldownUntil = Math.max(discordCooldownUntil, bucket.cooldownUntil);
      try { metrics.discord_cooldown_active.set(1); } catch {}
      try { if (bucket?.db) bucket.db.on429RetryAfter((retry || 0) / 1000); } catch {}
      // Requeue the job to attempt after cooldown, to avoid losing items on 429
      try {
        job._retries = (job._retries || 0) + 1;
        if (job._retries <= Number(process.env.POST_MAX_RETRIES_429 || 3)) {
          bucket.q.unshift(job);
        }
      } catch {}
      diag('send.429', { cid: String(job?.channel?.id || ''), item: String(job?.itemId || ''), via: job.webhookUrl ? 'webhook' : 'channel', retry_ms: retry });
      return null;
    }
    // Non-429 error: if webhook path failed, attempt channel fallback and prune bad webhook
    try {
      if (job?.webhookUrl) {
        try { removeWebhookFromStore(String(job?.channel?.id || ''), String(job.webhookUrl)); } catch {}
        // Self-heal: re-ensure webhooks for this channel when webhook was unknown/removed
        try { await ensureAfter404(String(job?.channel?.id || '')); } catch {}
        if (String(process.env.POST_VIA_WEBHOOK_ONLY || '0') !== '1') {
          try {
            const res2 = await job.channel.send(job.payload);
            try { metrics.discord_channel_send_ok_total.inc({ channel: String(job?.channel?.id || '') }); } catch {}
            try { if (job?.itemId && job?.channel?.id) _unmarkQueued(job.channel.id, job.itemId); } catch {}
            if (String(process.env.LOG_ROUTE || '0') === '1') {
              try { console.log('[post.send]', 'via=fallback-channel', 'channel=', String(job?.channel?.id||''), 'item=', String(job?.itemId||'')); } catch {}
            }
            diag('send.fallback', { cid: String(job?.channel?.id || ''), item: String(job?.itemId || ''), from: 'webhook', to: 'channel' });
            return res2;
          } catch {}
        }
      }
    } catch {}
    // Always log non-429 send errors to surface failures
    try { console.error('[post.error]', 'channel=', String(job?.channel?.id||''), 'item=', String(job?.itemId||''), 'via=', job?.webhookUrl ? 'webhook' : 'channel', 'err=', e?.message || e); } catch {}
    diag('send.error', { cid: String(job?.channel?.id || ''), item: String(job?.itemId || ''), via: job.webhookUrl ? 'webhook' : 'channel', error: String(e?.message || e) });
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
async function sendWebhook(url, payload, channelId) {
  // Discord expects JSON with content/embeds/components; payload passthrough
  try {
    if (payload && typeof payload === 'object') {
      // Always use empty content by default to avoid auto-previews
      if (payload.content == null) payload.content = '';
      // Drop any flags to avoid suppressing embeds accidentally (FORCE_NO_FLAGS)
      if (payload.flags != null && String(process.env.FORCE_NO_FLAGS || '1') === '1') delete payload.flags;
      // Ensure embeds serialized and sanitized
      if (Array.isArray(payload.embeds)) {
        const cleaned = sanitizeEmbeds(payload.embeds);
        payload.embeds = cleaned;
        try { if (cleaned.length) metrics.post_embed_sanitized_total.inc(); } catch {}
      }
      // Ensure components (ActionRowBuilder/ButtonBuilder) are serialized
      if (Array.isArray(payload.components)) {
        payload.components = payload.components.map(c => {
          try { return (c && typeof c.toJSON === 'function') ? c.toJSON() : c; } catch { return c; }
        });
      }
      // Safety: avoid mentions by default
      if (!payload.allowed_mentions) payload.allowed_mentions = { parse: [] };
    }
  } catch {}
  const body = JSON.stringify(payload);
  const dispatcher = getDispatcher(url);
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, dispatcher });
  if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') {
    try {
      console.log('[webhooks.send] channel=%s status=%d reset_after=%s', String(channelId||''), res.status, res.headers.get('x-ratelimit-reset-after'));
    } catch {}
  }
  if (String(process.env.LOG_ROUTE || '0') === '1') {
    try { console.log('[post.send]', 'via=webhook', 'channel=', String(channelId||'')); } catch {}
  }
  if (res.status === 429) {
    metrics.discord_rate_limit_hits.inc();
    try { metrics.discord_webhook_send_429_total.inc({ channel: String(channelId || '') }); } catch {}
    const j = Math.floor(Math.random() * 120) + 30;
    const jbody = await res.json().catch(()=>({}));
    const retryAfterSec = Number(jbody?.retry_after || 0);
    const retryAfter = retryAfterSec * 1000;
    const isGlobal = String(res.headers.get('x-ratelimit-global') || '').toLowerCase() === 'true';
    const wait = retryAfter > 0 ? retryAfter + j : 0;
    if (isGlobal && wait > 0) {
      try { metrics.discord_cooldown_active.set(1); } catch {}
      // set a brief global cooldown to avoid hammering
      const until = Date.now() + wait;
      if (until > discordCooldownUntil) discordCooldownUntil = until;
    }
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const err = new Error('429');
    err.status = 429;
    err.retry_after = retryAfterSec;
    err.headers = { 'x-ratelimit-global': isGlobal ? 'true' : 'false', 'x-ratelimit-reset-after': res.headers.get('x-ratelimit-reset-after') };
    throw err;
  }
  if (!res.ok) {
    const txt = await res.text().catch(()=> '');
    // Try to detect invalid embed payloads for telemetry
    if (res.status === 400) {
      try { metrics.post_embed_invalid_total.inc(); } catch {}
      try { console.warn('[post.embed.invalid]', 'channel=', String(channelId||''), 'body_bytes=', Buffer.byteLength(body), 'resp=', txt.slice(0, 300)); } catch {}
    }
    const err = new Error(`webhook ${res.status} ${txt}`);
    err.status = res.status;
    throw err;
  }
  try { metrics.discord_webhook_send_ok_total.inc({ channel: String(channelId || '') }); } catch {}
  // Heuristic: if we sent embeds but Discord responds 204, we cannot know render; just log payload size for investigation
  try {
    const hadEmbeds = (() => { try { const j = JSON.parse(body); return Array.isArray(j?.embeds) && j.embeds.length > 0; } catch { return false; } })();
    if (hadEmbeds) {
      const sz = Buffer.byteLength(body);
      if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log('[post.embed.sent]', 'channel=', String(channelId||''), 'embeds=', 'yes', 'bytes=', sz);
    }
  } catch {}
  return res;
}

// Auto-tune QPS based on recent 429s
let last429 = 0;
let lastOk = 0;
// Keep gauge update but remove global QPS adaptation
setInterval(() => {
  try {
    const total = metrics.discord_rate_limit_hits.get?.() ?? 0;
    const delta = total - last429;
    last429 = total;
    let okSum = 0;
    try { for (const e of metrics.discord_webhook_send_ok_total.entries()) okSum += Number(e.value || 0); } catch {}
    const okDelta = okSum - lastOk; lastOk = okSum;
    const denom = Math.max(1, okDelta + delta);
    const ratePct = Math.max(0, Math.min(100, Math.round((delta / denom) * 100)));
    try { metrics.discord_http_429_rate_60s?.set(ratePct); } catch {}
  } catch {}
}, 60 * 1000);

// Per-channel queue age p95 (discoveredAt -> send)
const qAgeByChan = new Map(); // channelId -> number[]
function recordQueueAge(channelId, ageMs) {
  if (!channelId) return;
  let arr = qAgeByChan.get(channelId);
  if (!arr) { arr = []; qAgeByChan.set(channelId, arr); }
  arr.push(ageMs);
  if (arr.length > 300) arr.shift();
}
setInterval(() => {
  try {
    for (const [cid, arr] of qAgeByChan.entries()) {
      if (!arr.length) continue;
      const a = arr.slice().sort((x,y)=>x-y);
      const p95 = a[Math.min(a.length - 1, Math.floor(a.length * 0.95))];
      metrics.queue_age_ms_p95.set({ channel: String(cid) }, p95);
      try { metrics.e2e_latency_ms_p95.set({ channel: String(cid) }, p95); } catch {}
    }
  } catch {}
}, 60 * 1000);

// Periodic backlog purge of stale items to cap tail latencies (optional)
if (PURGE_ENABLED) {
  setInterval(() => {
    try {
      const now = Date.now();
      let dropped = 0;
      // Purge per-route queues when deep backlog
      for (const [key, b] of routeBuckets.entries()) {
        const depth = b?.q?.length || 0;
        if (!depth || depth < STALE_PURGE_Q_THR) continue;
        const keep = [];
        for (const job of b.q) {
          const age = now - Number(job?.createdAt || now);
          if (age > STALE_PURGE_MAX_AGE_MS) {
            dropped++;
            try { if (job?.itemId) b.ids.delete(job.itemId); } catch {}
            try { if (job?.channel?.id && job?.itemId) _unmarkQueued(job.channel.id, job.itemId); } catch {}
          } else {
            keep.push(job);
          }
        }
        b.q = keep;
      }
      // Purge reorder buffers as well (lighter threshold)
      for (const [cid, st] of chanBuf.entries()) {
        const depth = st?.buf?.length || 0;
        if (!depth || depth < Math.floor(STALE_PURGE_Q_THR / 2)) continue;
        const keep = [];
        for (const job of st.buf) {
          const age = now - Number(job?.createdAt || now);
          if (age > STALE_PURGE_MAX_AGE_MS) {
            dropped++;
            try { if (job?.itemId) _unmarkQueued(cid, job.itemId); } catch {}
          } else {
            keep.push(job);
          }
        }
        st.buf = keep;
      }
      if (dropped && String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') {
        console.log('[post.purge]', 'dropped=', dropped);
      }
    } catch {}
  }, PURGE_INTERVAL_MS).unref?.();
}

// Fast queue-based QPS boost (10s cadence)
// Disable global QPS boost; token buckets govern pacing
setInterval(() => { try { /* noop */ } catch {} }, 10 * 1000);

// Concurrency auto-tune based on backlog (every 10s)
setInterval(() => {
  try {
    let keys = Array.from(routeBuckets.keys());
    const totalQ = keys.reduce((a,k)=> a + (routeBuckets.get(k)?.q?.length||0), 0);
    const cooldown = metrics.discord_cooldown_active.get?.() || 0;
    if (!cooldown && totalQ > 800 && currentConc < CONC_MAX) {
      currentConc = Math.min(CONC_MAX, currentConc + 4);
      postLimiter.updateSettings({ maxConcurrent: currentConc });
    } else if (!cooldown && totalQ > 300 && currentConc < CONC_MAX) {
      currentConc = Math.min(CONC_MAX, currentConc + 2);
      postLimiter.updateSettings({ maxConcurrent: currentConc });
    } else if ((cooldown || totalQ < 50) && currentConc > CONC) {
      currentConc = Math.max(CONC, currentConc - 1);
      postLimiter.updateSettings({ maxConcurrent: currentConc });
    }
  } catch {}
}, 10 * 1000);
