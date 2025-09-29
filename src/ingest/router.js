import fs from 'fs';
import path from 'path';
import { channelsPath } from '../infra/paths.js';
import { parseRuleFilters, itemMatchesFilters } from '../rules/urlNormalizer.js';
import { createProcessedStore, dedupeKeyForChannel, ttlMs } from '../utils/dedupe.js';
import { postItems } from '../poster.js';

const processed = createProcessedStore();
const CHANNEL_RELOAD_INTERVAL_MS = Math.max(30_000, Number(process.env.PUSH_CHANNEL_RELOAD_MS || 60_000));

function hydrateChannel(ch) {
  const filters = parseRuleFilters(ch?.url || '');
  return {
    ...ch,
    channelId: ch.channelId || ch.channel_id || ch.id,
    channelName: ch.channelName || ch.name || '',
    _filters: filters,
  };
}

function loadChannelsSafe() {
  try {
    const filePath = channelsPath();
    const raw = fs.readFileSync(filePath, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map(hydrateChannel).filter(ch => ch.channelId);
  } catch (err) {
    console.warn('[push.router] failed to load channels:', err?.message || err);
    return [];
  }
}

let channels = loadChannelsSafe();

function refreshChannels() {
  const next = loadChannelsSafe();
  if (!next.length) return;
  channels = next;
  try { console.log('[push.router] channels loaded', channels.length); } catch {}
}

export function startRouterReloadLoop() {
  refreshChannels();
  setInterval(() => {
    try { refreshChannels(); processed.purgeExpired?.(); } catch {}
  }, CHANNEL_RELOAD_INTERVAL_MS).unref?.();

  // Optional: reload on file change (best effort)
  try {
    const watchPath = channelsPath();
    fs.watch(watchPath, { persistent: false }, () => {
      setTimeout(refreshChannels, 250);
    });
  } catch {}
}

export async function routeListing(discordClient, listing) {
  if (!discordClient || !listing) return;
  const matches = [];
  for (const ch of channels) {
    try {
      if (!ch?._filters) continue;
      if (!itemMatchesFilters(listing, ch._filters)) continue;
      matches.push(ch);
    } catch (err) {
      console.warn('[push.router] match failed:', err?.message || err);
    }
  }
  if (!matches.length) return;

  const posts = [];
  for (const ch of matches) {
    try {
      const key = dedupeKeyForChannel(ch, listing.id);
      if (processed.has(key)) continue;
      processed.set(key, true, { ttl: ttlMs });
      posts.push(ch);
    } catch (err) {
      console.warn('[push.router] dedupe error:', err?.message || err);
    }
  }
  if (!posts.length) return;

  for (const ch of posts) {
    try {
      const label = ch.channelName || ch.name || '';
      await postItems(discordClient, ch.channelId, label, [listing]);
    } catch (err) {
      console.warn('[push.router] post failed:', err?.message || err);
    }
  }
}
