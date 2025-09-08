import Bottleneck from 'bottleneck';
import { metrics } from './metrics.js';
import { getWebhooksForChannelId, ensureWebhooksForChannel } from './webhooksManager.js';

const QPS = Math.max(1, Number(process.env.DISCORD_QPS || process.env.DISCORD_QPS_MAX || 50));
const CONC = Math.max(1, Number(process.env.DISCORD_POST_CONCURRENCY || 4));
const CONC_MAX = Math.max(CONC, Number(process.env.DISCORD_POST_CONCURRENCY_MAX || 12));
// Optional fast-path: allow near-immediate posting per-channel
const FAST_POST = String(process.env.FAST_POST || '0') === '1';
const REORDER_WINDOW_MS = FAST_POST ? 0 : Math.max(0, Number(process.env.REORDER_WINDOW_MS || 2000));
// Default: do NOT drop older items unless explicitly enabled via env
const POST_MAX_AGE_MS = Math.max(0, Number(process.env.POST_MAX_AGE_MS || 0));
const LOG_DROP_OLD = String(process.env.LOG_DROP_OLD || '1') === '1';

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
const ensureInFlight = new Set(); // channelId being ensured

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
export async function sendQueued(channel, payload, meta = {}) {
  // Simple backpressure: drop tail if queue exceeds MAX_QUEUE
  try { metrics.discord_queue_depth.set(queue.length); } catch {}
  if (queue.length >= MAX_QUEUE) {
    metrics.discord_dropped_total.inc();
    return { ok: false, reason: 'queue_full' };
  }
  // Optional per-channel reorder window
  const discoveredAt = Number(meta?.discoveredAt || Date.now());
  const createdAt = Number(meta?.createdAt || Date.now());
  const firstMatchedAt = meta?.firstMatchedAt ? Number(meta.firstMatchedAt) : undefined;
  // Drop if too old on enqueue to avoid late spam
  if (POST_MAX_AGE_MS > 0 && createdAt && (Date.now() - createdAt) > POST_MAX_AGE_MS) {
    if (LOG_DROP_OLD) {
      try {
        const age = Date.now() - createdAt;
        console.warn('[post.drop_old]', 'channel=', channel?.id || 'unknown', 'age_ms=', age);
      } catch {}
    }
    return { ok: false, reason: 'too_old' };
  }
  const itemId = meta?.itemId ? String(meta.itemId) : null;
  // Fresh-fast path: bypass reorder buffer for very fresh items
  const FRESH_FAST_MS = Math.max(0, Number(process.env.FRESH_FASTPATH_MS || 60_000));
  const isFreshFast = FRESH_FAST_MS > 0 && createdAt && (Date.now() - createdAt) <= FRESH_FAST_MS;
  if (!isFreshFast && REORDER_WINDOW_MS > 0 && channel?.id) {
    if (itemId && _isQueued(channel.id, itemId)) return { ok: true, buffered: true };
    const st = ensureChannelBuffer(channel);
    st.buf.push({ discoveredAt, createdAt, firstMatchedAt, channel, payload, itemId });
    try { metrics.reorder_buffer_depth.set({ channel: channel.id }, st.buf.length); } catch {}
    if (itemId) _markQueued(channel.id, itemId);
    return { ok: true, buffered: true };
  }
  enqueueRoute(channel, payload, discoveredAt, createdAt, itemId, firstMatchedAt);
  return { ok: true, enqueued: true };
}

// Route-aware per-bucket queues (bucket ≈ channel route)
const routeBuckets = new Map(); // key -> { q: Array<{channel,payload,discoveredAt,createdAt,itemId,webhookUrl,_retries?:number}>, cooldownUntil: number, ids:Set<string>, inflight:number, channelId:string }
const rrByChannel = new Map(); // channelId -> next webhook index
const chanQueued = new Map(); // channelId -> Set<itemId>
function _getChanSet(cid) { let s = chanQueued.get(cid); if (!s) { s = new Set(); chanQueued.set(cid, s); } return s; }
function _isQueued(cid, id) { if (!cid || !id) return false; const s = chanQueued.get(cid); return s ? s.has(id) : false; }
function _markQueued(cid, id) { if (!cid || !id) return; _getChanSet(cid).add(id); }
function _unmarkQueued(cid, id) { if (!cid || !id) return; const s = chanQueued.get(cid); if (s) s.delete(id); }
function getBucketByKey(key, channelId) {
  let b = routeBuckets.get(key);
  if (!b) { b = { q: [], cooldownUntil: 0, ids: new Set(), inflight: 0, channelId: String(channelId || '') }; routeBuckets.set(key, b); }
  return [key, b];
}

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
  if (webhooks && webhooks.length) {
    const rr = rrByChannel.get(cid) || 0;
    chosenWebhook = webhooks[rr % webhooks.length];
    rrByChannel.set(cid, (rr + 1) % webhooks.length);
    routeKey = `chan:${cid}:wh:${rr % webhooks.length}`;
  } else if (cid && String(process.env.AUTO_WEBHOOKS_ON_POST || '1') === '1') {
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
  b.q.push(job);
  if (idKey) { b.ids.add(idKey); _markQueued(cid, idKey); }
}

// WFQ-like scheduler: per second serve up to currentQps, 1 msg per bucket per tick
setInterval(() => {
  let slots = currentQps;
  const now = Date.now();
  let keys = Array.from(routeBuckets.keys());
  // dynamic per-bucket sends (burst window)
  const totalQ = keys.reduce((a,k)=> a + (routeBuckets.get(k)?.q?.length||0), 0);
  const cooldown = metrics.discord_cooldown_active.get?.() || 0;
  const perBucketSends = (!cooldown && totalQ > 800) ? 6 : (!cooldown && totalQ > 400) ? 5 : (!cooldown && totalQ > 200) ? 4 : (!cooldown && totalQ > 60) ? 3 : (!cooldown && totalQ > 20) ? 2 : 1;
  // do up to perBucketSends passes for fairness
  // prioritize buckets with freshest head createdAt when backlog is high
  if (totalQ > 100) {
    const headCreated = (k)=>{ const b=routeBuckets.get(k); const q=b?.q||[]; if(!q.length) return 0; let m=0; for (const it of q) { const v=Number(it?.createdAt||0); if (v>m) m=v; } return m; };
    keys = keys.slice().sort((a,b)=> headCreated(b)-headCreated(a));
  }
  for (let pass = 0; pass < perBucketSends && slots > 0; pass++) {
    for (const key of keys) {
      if (slots <= 0) break;
      const b = routeBuckets.get(key);
      if (!b || b.q.length === 0) continue;
      if (b.cooldownUntil > now) continue;
      // per-bucket dynamic concurrency: 1–4 depending on backlog and cooldown (more aggressive when backlog high)
      const CHAN_CONC = (!cooldown && b.q.length > 120) ? 6 : (!cooldown && b.q.length > 60) ? 5 : (!cooldown && b.q.length > 30) ? 4 : (!cooldown && b.q.length > 10) ? 3 : (!cooldown && b.q.length > 3) ? 2 : 1;
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
      b.inflight = (b.inflight || 0) + 1;
      postLimiter.schedule(() => doSend(job, b)).catch(() => {}).finally(() => { b.inflight = Math.max(0, (b.inflight||1) - 1); });
    }
  }
  if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug' || String(process.env.LOG_QUEUE_TICK||'0')==='1') {
    const ready = keys.filter(k => (routeBuckets.get(k)?.q?.length||0)>0).length;
    console.log(`[post.tick] qps=${currentQps} bucketsReady=${ready} slotsLeft=${slots} totalQ=${totalQ} perBucket=${perBucketSends}`);
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
  const now = Date.now();
  if (discordCooldownUntil > now) {
    try { metrics.discord_cooldown_active.set(1); } catch {}
    await new Promise(r => setTimeout(r, Math.min(5000, discordCooldownUntil - now)));
  } else {
    try { metrics.discord_cooldown_active.set(0); } catch {}
  }
  try {
    let res;
    // Bundling: if backlog high, bundle up to 10 embeds for same route
    const BUNDLE = (bucket?.q?.length || 0) > 10 && Array.isArray(job?.payload?.embeds);
    if (BUNDLE) {
      const embeds = [...(job.payload.embeds || [])].slice(0, 10);
      const cid = job?.channel?.id;
      const sameWebhook = job.webhookUrl || null;
      while (embeds.length < 10 && bucket.q.length) {
        const next = bucket.q[0];
        if (!next) break;
        if ((sameWebhook && next.webhookUrl !== sameWebhook) || next.channel?.id !== cid) break;
        const take = bucket.q.shift();
        if (take?.itemId) try { bucket.ids.delete(take.itemId); } catch {}
        const e2 = (take?.payload?.embeds || []);
        for (const e of e2) { if (embeds.length < 10) embeds.push(e); else break; }
      }
      const bundlePayload = { embeds };
      if (job.webhookUrl) res = await sendWebhook(job.webhookUrl, bundlePayload, job.channel?.id);
      else res = await job.channel.send(bundlePayload);
    } else {
      if (job.webhookUrl) {
        // Send via webhook (route-fanout)
        res = await sendWebhook(job.webhookUrl, job.payload, job.channel?.id);
      } else {
        res = await job.channel.send(job.payload);
      }
    }
    const latency = Date.now() - (Number(job.discoveredAt) || now);
    recordPostLatency(latency);
    try { recordQueueAge(job?.channel?.id, latency); } catch {}
    try { metrics.post_age_ms_histogram.set({ channel: String(job?.channel?.id || '') }, Math.max(0, now - Number(job.createdAt || now))); } catch {}
    try { metrics.discord_cooldown_active.set(0); } catch {}
    try {
      if (String(process.env.DIAG_TIMING || '0') === '1') {
        const createdAge = Math.max(0, now - Number(job.createdAt || now));
        console.log('[diag.post]', 'channel=', String(job?.channel?.id || ''), 'item=', String(job?.itemId || ''), 'age_listed_ms=', createdAge, 'queued_ms=', latency);
      }
    } catch {}
    // mark channel-level as done
    try { if (job?.itemId && job?.channel?.id) _unmarkQueued(job.channel.id, job.itemId); } catch {}
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
      // Requeue the job to attempt after cooldown, to avoid losing items on 429
      try {
        job._retries = (job._retries || 0) + 1;
        if (job._retries <= Number(process.env.POST_MAX_RETRIES_429 || 3)) {
          bucket.q.unshift(job);
        }
      } catch {}
      return null;
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
async function sendWebhook(url, payload, channelId) {
  // Discord expects JSON with content/embeds/components; payload passthrough
  const body = JSON.stringify(payload);
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') {
    try {
      console.log('[webhooks.send] channel=%s status=%d reset_after=%s', String(channelId||''), res.status, res.headers.get('x-ratelimit-reset-after'));
    } catch {}
  }
  if (res.status === 429) {
    metrics.discord_rate_limit_hits.inc();
    try { metrics.discord_webhook_send_429_total.inc({ channel: String(channelId || '') }); } catch {}
    const retryAfter = Number((await res.json().catch(()=>({})))?.retry_after || 0) * 1000;
    if (retryAfter > 0) await new Promise(r => setTimeout(r, retryAfter));
    throw new Error('429');
  }
  if (!res.ok) {
    const txt = await res.text().catch(()=> '');
    throw new Error(`webhook ${res.status} ${txt}`);
  }
  try { metrics.discord_webhook_send_ok_total.inc({ channel: String(channelId || '') }); } catch {}
  return res;
}

// Auto-tune QPS based on recent 429s
let last429 = 0;
let currentQps = QPS;
const MAX_QPS = Math.max(QPS, Number(process.env.DISCORD_QPS_MAX || 120));
const MIN_QPS = Math.max(5, Number(process.env.DISCORD_QPS_MIN || 60));
const INC_STEP = Math.max(1, Number(process.env.DISCORD_QPS_INC || 8));
const DEC_FACTOR = Number(process.env.DISCORD_QPS_DEC_FACTOR || 0.92);

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

// Fast queue-based QPS boost (10s cadence)
setInterval(() => {
  try {
    let keys = Array.from(routeBuckets.keys());
    const totalQ = keys.reduce((a,k)=> a + (routeBuckets.get(k)?.q?.length||0), 0);
    const cooldown = metrics.discord_cooldown_active.get?.() || 0;
    if (!cooldown && totalQ > 500) {
      const boost = Math.floor(MAX_QPS * 0.9);
      if (currentQps < boost) {
        currentQps = Math.min(MAX_QPS, boost);
        postLimiter.updateSettings({ reservoir: currentQps, reservoirRefreshAmount: currentQps });
      }
    }
  } catch {}
}, 10 * 1000);

// Concurrency auto-tune based on backlog (every 10s)
setInterval(() => {
  try {
    let keys = Array.from(routeBuckets.keys());
    const totalQ = keys.reduce((a,k)=> a + (routeBuckets.get(k)?.q?.length||0), 0);
    const cooldown = metrics.discord_cooldown_active.get?.() || 0;
    if (!cooldown && totalQ > 800 && currentConc < CONC_MAX) {
      currentConc = Math.min(CONC_MAX, currentConc + 1);
      postLimiter.updateSettings({ maxConcurrent: currentConc });
    } else if ((cooldown || totalQ < 50) && currentConc > CONC) {
      currentConc = Math.max(CONC, currentConc - 1);
      postLimiter.updateSettings({ maxConcurrent: currentConc });
    }
  } catch {}
}, 10 * 1000);
