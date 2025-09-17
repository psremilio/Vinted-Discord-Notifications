import { REST, Routes } from 'discord.js';

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN || '');

const ENSURE_MS = Math.max(60_000, Number(process.env.WEBHOOK_ENSURE_INTERVAL_MS || 15 * 60_000));
const JITTER_MS = Math.max(0, Number(process.env.WEBHOOK_ENSURE_JITTER_MS || 30_000));
const WANT = Math.max(1, Number(process.env.WEBHOOKS_PER_CHANNEL || 6));
const NAME_PREFIX = String(process.env.WEBHOOK_NAME_PREFIX || 'snipe-webhook');

const lastEnsure = new Map(); // channelId -> epoch ms
const backoffUntil = new Map(); // channelId -> epoch ms

async function listWebhooks(channelId) {
  try {
    const hooks = await rest.get(Routes.channelWebhooks(channelId));
    return Array.isArray(hooks) ? hooks : [];
  } catch (e) {
    try { console.warn('[webhooks.ensure.list] failed', channelId, e?.message || e); } catch {}
    throw e;
  }
}

export async function ensureChannelWebhooks(channelId, namePrefix = NAME_PREFIX) {
  const now = Date.now();
  const until = Number(backoffUntil.get(channelId) || 0);
  if (until && now < until) return;
  const last = lastEnsure.get(channelId) || 0;
  // Debounce using interval minus a bit of jitter to spread load
  const threshold = ENSURE_MS - Math.floor(Math.random() * (JITTER_MS + 1));
  if (now - last < threshold) return;
  lastEnsure.set(channelId, now);

  let hooks = [];
  try {
    hooks = await listWebhooks(channelId);
    backoffUntil.delete(channelId);
  } catch (e) {
    const msg = String(e?.message || e || '');
    if (/tls|socket disconnected|econnreset|timeout/i.test(msg)) {
      const waitMs = Math.max(10 * 60_000, Number(process.env.WEBHOOK_ENSURE_ERR_BACKOFF_MS || 900_000));
      backoffUntil.set(channelId, now + waitMs);
      try { console.warn('[webhooks.ensure.backoff]', channelId, 'ms=', waitMs, 'reason=', msg); } catch {}
    }
    return;
  }

  const mine = hooks.filter(h => String(h?.name || '').startsWith(namePrefix));
  const missing = Math.max(0, WANT - mine.length);
  if (missing <= 0) return;
  for (let i = mine.length; i < WANT; i++) {
    try {
      await rest.post(Routes.channelWebhooks(channelId), { body: { name: `${namePrefix}-${i + 1}` } });
    } catch (e) {
      try { console.warn('[webhooks.ensure.create] failed', channelId, e?.message || e); } catch {}
      break;
    }
  }
}

export function scheduleEnsureLoop(channelIds = []) {
  // Boot-ensure
  (async () => {
    for (const id of (Array.isArray(channelIds) ? channelIds : [])) {
      try { await ensureChannelWebhooks(id); } catch {}
    }
  })();
  // Periodic
  const base = Math.max(ENSURE_MS, 60_000);
  setInterval(async () => {
    const list = Array.isArray(channelIds) ? channelIds : [];
    for (const id of list) {
      try { await ensureChannelWebhooks(id); } catch {}
    }
  }, base + Math.floor(Math.random() * (JITTER_MS + 1))).unref?.();
}

// Immediate ensure after 404/Unknown Webhook; resets debounce timer
export async function ensureAfter404(channelId) {
  try { lastEnsure.set(channelId, 0); } catch {}
  try { backoffUntil.delete(channelId); } catch {}
  try { await ensureChannelWebhooks(channelId); } catch {}
}

