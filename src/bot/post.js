import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { buildListingEmbed } from '../embeds.js';

const isTextChannelLike = ch => ch && typeof ch.send === "function";
async function sendToTargetsSafely(targets, payload) {
  const list = Array.isArray(targets) ? targets : [targets];
  for (const ch of (list || [])) {
    if (!isTextChannelLike(ch)) {
      console.warn("[post] skip invalid channel", ch?.id ?? "(undefined)");
      continue;
    }
    try {
      await ch.send(payload);
    } catch (e) {
      const code = Number(e?.code || 0);
      if (code === 10003) {
        console.error(`[post] send failed: Unknown Channel (id=${ch?.id ?? 'unknown'}) — wurde der Kanal gelöscht oder fehlt die Berechtigung?`);
      } else {
        console.error("[post] send failed", ch?.id ?? "(unknown)", e);
      }
    }
  }
}
const normKey = s => (s ?? "").toLowerCase().trim().replace(/\s+/g,"").replace(/-+/g,"-");
const singularFallback = k => k.replace(/s$/, "");

export async function postArticles(newArticles, channelToSend, ruleName) {
    const list = Array.isArray(newArticles) ? newArticles.slice(0, 10) : [];
    const targets = Array.isArray(channelToSend) ? channelToSend : [channelToSend];
    if (!list.length) return;

    for (const item of list) {
        const origin = new URL(item.url).origin;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('Details')
                .setEmoji('🗄️')
                .setStyle(ButtonStyle.Link)
                .setURL(`${origin}/items/${item.id}`),
            new ButtonBuilder()
                .setLabel('Message')
                .setEmoji('🪐')
                .setStyle(ButtonStyle.Link)
                .setURL(`${origin}/items/${item.id}/want_it/new?`)
        );

        const ts = item.photo?.high_resolution?.timestamp; // seconds
        const listing = {
            id: item.id,
            title: item.title,
            url: item.url,
            brand: item.brand_title,
            size: item.size_title,
            status: item.status,
            price: item.price?.amount,
            currency: item.price?.currency_code,
            price_eur: item.price?.converted_amount,
            // pass timestamp in milliseconds for embed time rendering
            createdAt: ts ? ts * 1000 : undefined,
            seller_name: item.user?.login,
            seller_avatar: item.user?.profile_picture?.url,
            image_url: item.photo?.url,
            country_code: item.user?.country_code,
            description: item.description,
        };

        const payload = {
            embeds: [buildListingEmbed(listing)],
            components: [row],
        };
        await sendToTargetsSafely(targets, payload);
        try {
          console.log(`[debug][rule:${ruleName || (targets?.[0]?.name ?? 'unknown')}] posted item=${item.id}`);
        } catch {
          // ignore logging failures
        }
    }
}
