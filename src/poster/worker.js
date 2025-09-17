import { xreadGroupBatch, xack, ensureGroup } from '../queue/streams.js';
import { getWebhooksForChannelId } from '../infra/webhooksManager.js';
import { setIfAbsent as postedSetIfAbsent } from '../infra/postedStore.js';

const GROUP = String(process.env.POST_GROUP || 'poster');
const STREAM_BATCH = Math.max(1, Number(process.env.STREAM_BATCH || 10));
const STREAM_BLOCK_MS = Math.max(500, Number(process.env.STREAM_BLOCK_MS || 2000));
const SHARDS = Math.max(1, Number(process.env.SHARDS || 1));
const SHARD_INDEX = Math.max(0, Number(process.env.SHARD_INDEX || 0)) % SHARDS;
const GLOBAL_MAX_INFLIGHT = Math.max(1, Number(process.env.POSTER_MAX_INFLIGHT || 64));
const PER_CHAN_MAX_INFLIGHT = Math.max(1, Number(process.env.POSTER_PER_CHANNEL_MAX_INFLIGHT || 1));
const SAFETY_MS = Math.max(50, Number(process.env.DISCORD_SAFE_GAP_MS || 150));

function shardOwns(channelId) {
  const s = [...String(channelId)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0);
  return (s % SHARDS) === SHARD_INDEX;
}

class ChannelLimiter {
  constructor() { this.remaining = 5; this.resetAt = 0; this.inflight = 0; }
  async admit() {
    while (true) {
      const now = Date.now();
      if (this.inflight < PER_CHAN_MAX_INFLIGHT) {
        if (this.remaining > 0 || now >= this.resetAt) { this.inflight++; this.remaining = Math.max(0, this.remaining - 1); return; }
      }
      const wait = Math.max(20, (this.resetAt || now + 200) - now + SAFETY_MS);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  onHeaders(h) {
    const rem = Number(h.get ? h.get('x-ratelimit-remaining') : h['x-ratelimit-remaining']);
    const ra = Number(h.get ? h.get('x-ratelimit-reset-after') : h['x-ratelimit-reset-after']);
    if (Number.isFinite(rem)) this.remaining = Math.max(0, rem);
    if (Number.isFinite(ra)) this.resetAt = Date.now() + Math.floor(ra * 1000) + SAFETY_MS;
    this.inflight = Math.max(0, this.inflight - 1);
  }
  on429(retryAfterSec) {
    const ms = Math.max(500, Math.floor(Number(retryAfterSec || 1) * 1000));
    this.resetAt = Date.now() + ms + SAFETY_MS; this.remaining = 0; this.inflight = Math.max(0, this.inflight - 1);
  }
}

const chanState = new Map(); // channelId -> { limiter, webhook }
function getState(cid) {
  let st = chanState.get(cid);
  if (!st) { st = { limiter: new ChannelLimiter(), webhook: null }; chanState.set(cid, st); }
  return st;
}

async function sendWebhook(webhookUrl, payload) {
  const body = JSON.stringify(payload);
  const res = await fetch(webhookUrl + '?wait=false', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  return res;
}

async function processOne(task) {
  const cid = task.channelId;
  const st = getState(cid);
  // Idempotency per (rule,item,channel)
  try {
    const ttl = Math.max(60, Number(process.env.DEDUPE_TTL_SEC || 86400));
    const k = `posted:${String(task.fields.rule || '')}:${String(task.fields.itemId || '')}:${String(cid)}`;
    const ok = await postedSetIfAbsent(k, ttl);
    if (!ok) return 'dup';
  } catch {}
  // choose webhook
  if (!st.webhook) {
    const urls = getWebhooksForChannelId(cid) || [];
    st.webhook = urls[0] || null;
    if (!st.webhook) throw new Error('no_webhook');
  }
  // Build payload
  let embed = null, comps = undefined, content = '';
  try { embed = JSON.parse(task.fields.embed); } catch { embed = null; }
  try { comps = JSON.parse(task.fields.components || 'null') || undefined; } catch {}
  if (task.fields.content) content = String(task.fields.content);
  const payload = { content, embeds: embed ? [embed] : undefined, components: comps, allowed_mentions: { parse: [] } };
  // Admit per-channel token
  await st.limiter.admit();
  const res = await sendWebhook(st.webhook, payload);
  if (res.status === 429) {
    let j = {}; try { j = await res.json(); } catch {}
    st.limiter.on429(j?.retry_after);
    throw new Error('429');
  }
  if (!res.ok) {
    const txt = await res.text().catch(()=> '');
    throw new Error(`webhook ${res.status} ${txt}`);
  }
  st.limiter.onHeaders(res.headers);
  return 'ok';
}

export async function startPosterWorker() {
  const ids = Array.from(globalThis.channelsStore?.keys?.() || []);
  const mine = ids.filter(shardOwns);
  for (const id of mine) await ensureGroup(id, GROUP);
  const consumer = String(process.env.CONSUMER_NAME || `c-${process.pid}-${Math.random().toString(36).slice(2,6)}`);
  let inflight = 0;
  async function loop() {
    try {
      const batch = await xreadGroupBatch(mine, GROUP, consumer, { count: STREAM_BATCH, blockMs: STREAM_BLOCK_MS });
      if (!batch.length) return;
      for (const t of batch) {
        if (inflight >= GLOBAL_MAX_INFLIGHT) break;
        inflight++;
        (async () => {
          try { await processOne(t); } catch {}
          try { await xack(t.channelId, GROUP, t.id); } catch {}
          inflight = Math.max(0, inflight - 1);
        })();
      }
    } catch (e) {
      try { console.warn('[streams.worker]', e?.message || e); } catch {}
    }
  }
  setInterval(loop, 100).unref?.();
  console.log(`[streams.worker] started; channels=${mine.length} group=${GROUP} consumer=${consumer}`);
}

