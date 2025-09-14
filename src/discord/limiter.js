import { getWebhooksForChannelId } from '../infra/webhooksManager.js';

const PER_CH_INFLIGHT = Math.max(1, Number(process.env.POSTER_PER_CHANNEL_MAX_INFLIGHT || 1));

const limiters = new Map(); // channelId -> ChannelLimiter
const webhookCache = new Map(); // channelId -> url

function limiterFor(ch) { let l = limiters.get(ch); if (!l) { l = new ChannelLimiter(); limiters.set(ch, l); } return l; }
function webhookUrlFor(ch) {
  const cid = String(ch);
  let u = webhookCache.get(cid);
  if (!u) {
    const arr = getWebhooksForChannelId(cid) || [];
    u = arr[0] || null;
    if (u) webhookCache.set(cid, u);
  }
  return u;
}

export class ChannelLimiter {
  constructor() { this.tokens = 1; this.resetAt = 0; this.inflight = 0; }
  canSend() { const now = Date.now(); return (this.inflight < PER_CH_INFLIGHT) && (this.tokens > 0 || now >= this.resetAt); }
  async admit() {
    while (!this.canSend()) {
      const wait = Math.max(20, this.resetAt - Date.now());
      await new Promise(r => setTimeout(r, wait));
    }
    this.inflight += 1; this.tokens = Math.max(0, this.tokens - 1);
  }
  release() { this.inflight = Math.max(0, this.inflight - 1); }
  updateFromHeaders(h) {
    const g = (k) => (h?.get ? h.get(k) : h?.[k]);
    const rem = Number(g('x-ratelimit-remaining') ?? g('X-RateLimit-Remaining'));
    const ra = Number(g('x-ratelimit-reset-after') ?? g('X-RateLimit-Reset-After'));
    if (Number.isFinite(rem)) this.tokens = Math.max(0, rem);
    if (Number.isFinite(ra)) this.resetAt = Date.now() + Math.ceil(ra * 1000);
  }
}

export async function sendDiscordWebhook(channelId, payload) {
  const url = webhookUrlFor(channelId);
  if (!url) throw new Error('no_webhook');
  const body = JSON.stringify(payload);
  const l = limiterFor(channelId);
  await l.admit();
  try {
    const res = await fetch(url + '?wait=false', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (res.status === 429) {
      let j = {}; try { j = await res.json(); } catch {}
      const ra = Number(j?.retry_after || 1);
      l.updateFromHeaders(res.headers);
      l.release();
      await new Promise(r => setTimeout(r, Math.ceil(ra * 1000)));
      throw new Error('rate limited');
    }
    if (!res.ok && res.status !== 204 && res.status !== 200) {
      const txt = await res.text().catch(()=> '');
      l.updateFromHeaders(res.headers);
      l.release();
      throw new Error('webhook failed: ' + res.status + ' ' + txt);
    }
    l.updateFromHeaders(res.headers);
    l.release();
    return true;
  } catch (e) {
    l.release();
    throw e;
  }
}

