import { PermissionsBitField } from 'discord.js';
import { get as getStore, add as addStore, load as loadStore } from './webhooksStore.js';

const AUTO_ON = String(process.env.AUTO_WEBHOOKS_ON_COMMAND || '1') === '1';
// Default more aggressive webhook fanout per channel to raise posting throughput
const WEBHOOKS_PER_CHANNEL = Math.max(1, Number(process.env.WEBHOOKS_PER_CHANNEL || 6));
const WEBHOOK_NAME_PREFIX = String(process.env.WEBHOOK_NAME_PREFIX || 'snipe-webhook');

let ENV_MAP = null;
try { ENV_MAP = JSON.parse(process.env.DISCORD_WEBHOOKS_JSON || 'null'); } catch { ENV_MAP = null; }

await loadStore().catch(()=>{});

export async function ensureWebhooksForChannel(channel, count = WEBHOOKS_PER_CHANNEL, namePrefix = WEBHOOK_NAME_PREFIX) {
  if (!AUTO_ON) return getWebhooksForChannelId(channel?.id);
  if (!channel) return [];
  // Guard: Some channel types (e.g., forum threads) don't support webhooks
  if (typeof channel.createWebhook !== 'function') {
    try { console.warn('webhooks.ensure unsupported channel type for webhooks:', String(channel?.id || 'unknown')); } catch {}
    return getWebhooksForChannelId(channel.id);
  }
  try {
    const me = channel.guild?.members?.me;
    const perms = channel.permissionsFor?.(me);
    if (!perms || !perms.has(PermissionsBitField.Flags.ManageWebhooks)) return getWebhooksForChannelId(channel.id);
  } catch { return getWebhooksForChannelId(channel.id); }

  const want = Math.max(1, Number(count || 1));
  let urls = getStore(channel.id) || [];
  try {
    const hooks = await channel.fetchWebhooks();
    const mine = hooks?.filter(h => String(h.name || '').startsWith(namePrefix)) || [];
    urls = urls.concat(mine.map(h => h.url)).filter(Boolean);
    urls = Array.from(new Set(urls));
    // create missing
    const need = Math.max(0, want - urls.length);
    for (let i = 0; i < need; i++) {
      const wh = await channel.createWebhook({ name: `${namePrefix}-${i+1}` }).catch(()=>null);
      if (wh?.url) urls.push(wh.url);
    }
    // persist
    if (urls.length) addStore(channel.id, urls[0]); // add ensures dedupe + write; then set others
    for (let i = 1; i < urls.length; i++) addStore(channel.id, urls[i]);
    console.log(`[webhooks.ensure] channel=${channel.id} want=${want} total=${urls.length}`);
    if (String(process.env.DIAG_ALL||'0')==='1') {
      try { console.log('[diag.webhooks.ensure]', JSON.stringify({ cid: channel.id, want, total: urls.length })); } catch {}
    }
  } catch (e) {
    console.warn('[webhooks.ensure] failed:', e?.message || e);
  }
  return urls;
}

export function getWebhooksForChannelId(channelId) {
  if (!channelId) return [];
  const storeUrls = getStore(channelId) || [];
  // Include preflight-built channelsStore if available (id+token -> URL)
  let built = [];
  try {
    const gs = globalThis.channelsStore;
    if (gs && typeof gs.get === 'function') {
      const entries = gs.get(String(channelId)) || [];
      built = (entries || []).map(e => {
        try {
          const id = String(e.id); const token = String(e.token);
          return `https://discord.com/api/v10/webhooks/${id}/${token}`;
        } catch { return null; }
      }).filter(Boolean);
    }
  } catch {}
  const envUrls = ENV_MAP && Array.isArray(ENV_MAP[channelId]) ? ENV_MAP[channelId] : [];
  return Array.from(new Set([...storeUrls, ...built, ...envUrls])).filter(Boolean);
}
