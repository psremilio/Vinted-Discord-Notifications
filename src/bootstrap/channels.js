import { ChannelType } from 'discord.js';

// Build a channels store of usable webhooks per text channel.
// Returns Map<channelId, Array<{id:string, token:string}>> and a list of invalids.
export async function buildChannelsStore(client, channelIds, strict = false) {
  const store = new Map();
  const invalid = [];
  const ids = Array.from(new Set((Array.isArray(channelIds) ? channelIds : []).map(x => String(x || '')).filter(Boolean)));
  for (const cid of ids) {
    let ch = null;
    try { ch = await client.channels.fetch(cid).catch(() => null) || client.channels.cache.get(cid) || null; } catch { ch = null; }
    if (!ch) { invalid.push({ id: cid, reason: 'not_found' }); continue; }
    const isText = (typeof ch.send === 'function') || ch.type === ChannelType.GuildText || ch.type === 0;
    if (!isText) { invalid.push({ id: cid, reason: `invalid_type_${ch.type}` }); continue; }
    try {
      const hooks = await ch.fetchWebhooks();
      const usable = Array.from(hooks.values ? hooks.values() : hooks).filter(h => !!h?.token).map(h => ({ id: String(h.id), token: String(h.token) }));
      if (!usable.length) { invalid.push({ id: cid, reason: 'no_webhook' }); continue; }
      store.set(cid, usable);
    } catch (e) {
      invalid.push({ id: cid, reason: e?.message || 'fetch_failed' });
    }
  }
  if (invalid.length) {
    try { console.error('preflight.channels filtered_invalid', invalid); } catch {}
    if (strict) throw new Error(`Invalid target channels (${invalid.length})`);
  }
  if (store.size === 0) throw new Error('No valid text channels with webhooks');
  return { store, invalid };
}

