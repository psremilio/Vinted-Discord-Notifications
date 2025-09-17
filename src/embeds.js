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
    ? `${base}\n(~ ${Number(eurApprox).toLocaleString('de-DE', { maximumFractionDigits: 2 })} EUR)`
    : base;
}

export function buildListingEmbed(i) {
  const created = i.createdAt || i.created_at || Date.now();
  const postedUnix = Math.floor(created / 1000);
  const condition =
    CONDITION_MAP[i.status] ||
    CONDITION_MAP[i.condition] ||
    i.condition ||
    i.status ||
    '-';

  const emb = new EmbedBuilder()
    .setColor(0xeab308)
    .setTitle(`${i.title ?? 'Item'}${i.size ? ` • ${i.size}` : ''}`)
    .setURL(i.url)
    .addFields(
      { name: 'Price', value: fmtPrice(i.price, i.currency, i.price_eur) || '-', inline: true },
      { name: 'Size', value: i.size || '-', inline: true },
      { name: 'Condition', value: String(condition), inline: true },
      { name: 'Listed', value: time(postedUnix, 'R'), inline: true },
      { name: 'Brand', value: i.brand || '-', inline: true },
      { name: 'Item ID', value: `\`${i.id}\``, inline: true },
    )
    .setFooter({ text: i.location ? `${i.location} • Vinted` : 'Vinted' })
    .setTimestamp(new Date(created));

  if (i.discoveredAt) {
    const lagSec = Math.max(0, Math.round((Date.now() - Number(i.discoveredAt)) / 1000));
    emb.addFields({ name: 'Discovered In', value: `${lagSec}s`, inline: true });
  }

  const desc = [i.brand && `**${i.brand}**`, i.description && trunc(i.description)]
    .filter(Boolean)
    .join('\n');
  if (desc) emb.setDescription(desc);

  const img = i.images?.[0] || i.image_url;
  if (img) emb.setImage(img);

  const sellerName = i.seller?.name || i.seller_name;
  const sellerAvatar = i.seller?.avatar || i.seller_avatar;
  if (sellerName) emb.setAuthor({ name: String(sellerName), iconURL: sellerAvatar || undefined });

  return emb;
}

// Backwards compatibility: legacy imports may expect buildItemEmbed
export { buildListingEmbed as buildItemEmbed };

