import { EmbedBuilder, time } from 'discord.js';

const CONDITION_MAP = {
  new: 'Neu',
  like_new: 'Wie neu',
  very_good: 'Sehr gut',
  good: 'Gut',
  satisfactory: 'Okay',
};

function trunc(s, n = 160) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function fmtPrice(value, currency = 'EUR', eurApprox) {
  if (value == null) return '';
  const base = `${Number(value).toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${currency}`;
  return eurApprox && currency !== 'EUR'
    ? `${base}\n(≈ ${Number(eurApprox).toLocaleString('de-DE', { maximumFractionDigits: 2 })} EUR)`
    : base;
}

export function buildListingEmbed(i) {
  const postedUnix = Math.floor((i.createdAt ?? Date.now()) / 1000);
  const condition =
    CONDITION_MAP[i.status] ||
    CONDITION_MAP[i.condition] ||
    i.condition ||
    i.status ||
    '—';

  const emb = new EmbedBuilder()
    .setColor(0xeab308)
    .setTitle(`${i.title ?? 'Artikel'}${i.size ? ` — ${i.size}` : ''}`)
    .setURL(i.url)
    .setDescription(i.brand ? `**${i.brand}**` : null)
    .addFields(
      { name: '💰 Price', value: fmtPrice(i.price, i.currency, i.price_eur) || '—', inline: true },
      { name: '📏 Size', value: i.size || '—', inline: true },
      { name: '🌟 Status', value: String(condition), inline: true },
      { name: '⏱️ Time', value: time(postedUnix, 'R'), inline: true },
      { name: '🏷️ Brand', value: i.brand || '—', inline: true },
      { name: '🔢 ID', value: `\`${i.id}\``, inline: true },
    )
    .setImage(i.images?.[0] || i.image_url || null)
    .setFooter({ text: i.location ? `${i.location} • Vinted` : 'Vinted' })
    .setTimestamp(new Date(i.createdAt || Date.now()));

  if (i.description) {
    const current = emb.data.description || '';
    emb.setDescription([current, trunc(i.description)].filter(Boolean).join('\n'));
  }

  if (i.seller?.name) {
    emb.setAuthor({ name: i.seller.name, iconURL: i.seller.avatar || undefined });
  }

  return emb;
}

// Backwards compatibility: legacy imports may expect buildItemEmbed
export { buildListingEmbed as buildItemEmbed };
