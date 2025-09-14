import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { buildListingEmbed } from '../embeds.js';
import { sanitizeEmbed } from '../discord/ensureValidEmbed.js';
import { stats } from '../utils/stats.js';
import { markPosted } from '../state.js';
import { sendQueued } from '../infra/postQueue.js';
import { metrics } from '../infra/metrics.js';
import { setIfAbsent as postedSetIfAbsent } from '../infra/postedStore.js';
import { xaddPostTask } from '../queue/streams.js';

const isTextChannelLike = ch => ch && typeof ch.send === 'function';

// Simple TTL cache for recently built/sanitized embeds per itemId
const EMBED_CACHE_TTL_MS = Math.max(10_000, Number(process.env.EMBED_CACHE_TTL_MS || 60_000));
const embedCache = new Map(); // itemId -> { embedJson, expireAt }
function getCachedEmbed(itemId) {
  if (!itemId) return null;
  const e = embedCache.get(String(itemId));
  if (!e) return null;
  if (e.expireAt && e.expireAt <= Date.now()) { embedCache.delete(String(itemId)); return null; }
  return e.embedJson || null;
}
function setCachedEmbed(itemId, embedJson) {
  if (!itemId || !embedJson) return;
  embedCache.set(String(itemId), { embedJson, expireAt: Date.now() + EMBED_CACHE_TTL_MS });
}

async function sendToTargetsSafely(targets, payload, meta = {}) {
  const list = Array.isArray(targets) ? targets : [targets];
  const promises = [];
  for (const ch of (list || [])) {
    promises.push((async () => {
      if (!isTextChannelLike(ch)) {
        console.warn('[post] skip invalid channel', ch?.id ?? '(undefined)');
        return { ok: false, reason: 'invalid_channel' };
      }
      try {
        const res = await sendQueued(ch, payload, meta);
        return res || { ok: true };
      } catch (e) {
        const code = Number(e?.code || 0);
        if (code === 10003) {
          console.error(`[post] send failed: Unknown Channel (id=${ch?.id ?? 'unknown'}) — wurde der Kanal gelöscht oder fehlt die Berechtigung?`);
        } else {
          console.error('[post] send failed', ch?.id ?? '(unknown)', e);
        }
        return { ok: false, reason: 'exception' };
      }
    })());
  }
  return Promise.all(promises);
}

export async function postArticles(newArticles, channelToSend, ruleName) {
  const LIMIT = Math.max(0, Number(process.env.POST_BATCH_LIMIT || 0));
  const list = Array.isArray(newArticles) ? (LIMIT > 0 ? newArticles.slice(0, LIMIT) : newArticles) : [];
  const targets = Array.isArray(channelToSend) ? channelToSend : [channelToSend];
  if (!list.length) return;

  for (const item of list) {
    try {
      const POST_MAX_AGE_MS = Math.max(0, Number(process.env.POST_MAX_AGE_MS || 0));
      if (POST_MAX_AGE_MS > 0) {
        const createdMs0 = Number(((item.created_at_ts || 0) * 1000)) || Number((item.photo?.high_resolution?.timestamp || 0) * 1000) || 0;
        if (createdMs0 && (Date.now() - createdMs0) > POST_MAX_AGE_MS) {
          if (String(process.env.LOG_LEVEL || '').toLowerCase() === 'debug') {
            try { console.log('[post.skip_old.pre]', 'item=', item.id, 'age_ms=', (Date.now() - createdMs0)); } catch {}
          }
          continue;
        }
      }
    } catch {}

    const origin = new URL(item.url).origin;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Details').setEmoji('🔎').setStyle(ButtonStyle.Link).setURL(`${origin}/items/${item.id}`),
      new ButtonBuilder().setLabel('Message').setEmoji('✉️').setStyle(ButtonStyle.Link).setURL(`${origin}/items/${item.id}/want_it/new?`),
    );

    const ts = (item.created_at_ts != null ? item.created_at_ts : item.photo?.high_resolution?.timestamp); // seconds
    const listing = {
      id: item.id,
      title: (item.__priceDrop ? '[PRICE DROP] ' : '') + (item.title || ''),
      url: item.url,
      brand: item.brand_title,
      size: item.size_title,
      status: item.status,
      price: item.price?.amount,
      currency: item.price?.currency_code,
      price_eur: item.price?.converted_amount,
      createdAt: ts ? ts * 1000 : undefined,
      seller_name: item.user?.login,
      seller_avatar: item.user?.profile_picture?.url,
      image_url: item.photo?.url,
      country_code: item.user?.country_code,
      description: item.description,
    };

    // Build and sanitize embed; fallback to content-only when empty
    // Build embed once per item and cache shortly to speed up fanout
    let embedJson = getCachedEmbed(listing.id);
    if (!embedJson) {
      const rawEmbed = buildListingEmbed(listing);
      embedJson = sanitizeEmbed(rawEmbed);
      if (embedJson) setCachedEmbed(listing.id, embedJson);
    }
    let payload;
    if (!embedJson || (typeof embedJson === 'object' && Object.keys(embedJson).length === 0)) {
      const title = String(listing.title || 'Item');
      const price = (listing.price != null && listing.currency) ? `${listing.price} ${listing.currency}` : '';
      const link = String(listing.url || '');
      const pieces = [title, price, link].filter(Boolean);
      payload = { content: pieces.join(' — '), components: [row] };
    } else {
      payload = { embeds: [embedJson], components: [row] };
    }
    const meta = {
      discoveredAt: item.discoveredAt || Date.now(),
      createdAt: listing.createdAt || Date.now(),
      firstMatchedAt: Number(item.__firstMatchedAt || 0) || undefined,
      itemId: String(item.id),
    };
    try {
      if (meta.firstMatchedAt) {
        const age = Math.max(0, Date.now() - Number(meta.firstMatchedAt));
        metrics.match_age_ms_histogram?.set({ rule: String(ruleName || '') }, age);
      }
    } catch {}
    const VIA_STREAMS = String(process.env.POST_VIA_STREAMS || '0') === '1';
    if (VIA_STREAMS) {
      // Publish one task per channel into Redis Streams; worker posts it
      const createdAtMs = listing.createdAt || Date.now();
      const compJson = (payload.components || []).map(c => (typeof c.toJSON === 'function' ? c.toJSON() : c));
      for (const ch of targets) {
        const cid = String(ch?.id || ''); if (!cid) continue;
        await xaddPostTask(cid, {
          itemId: String(item.id),
          rule: String(ruleName || ''),
          createdAtMs: String(createdAtMs),
          embed: payload.embeds ? payload.embeds[0] : null,
          components: compJson && compJson.length ? compJson : null,
          content: payload.content || '',
        });
      }
      continue; // defer actual sending to worker
    } else {
      // Per-target idempotency in-process: allow cross-posting across channels
      const ttlSec = Math.max(60, Number(process.env.DEDUPE_TTL_SEC || 86400));
      const planned = [];
      for (const ch of targets) {
        try {
          const cid = String(ch?.id || '');
          if (!cid) continue;
          const key = `posted:${String(ruleName||'')}:${String(item.id)}:${cid}`;
          const ok = await postedSetIfAbsent(key, ttlSec);
          if (ok) planned.push(ch);
        } catch { planned.push(ch); }
      }
      const rlist = await sendToTargetsSafely(planned, payload, meta);
      const anyOk = Array.isArray(rlist) ? rlist.some(r => r && r.ok) : false;
      if (anyOk) {
        try {
          console.log(`[debug][rule:${ruleName || (targets?.[0]?.name ?? 'unknown')}] posted item=${item.id}`);
          stats.posted += 1;
          markPosted();
        } catch {}
      } else {
        if (String(process.env.LOG_LEVEL || '').toLowerCase() === 'debug') {
          try { console.log('[post.skip]', 'item=', item.id, 'reasons=', JSON.stringify(rlist)); } catch {}
        }
      }
    }
  }
}
