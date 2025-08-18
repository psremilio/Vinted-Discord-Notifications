import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

const DEFAULT_COLOR = Number(process.env.EMBED_COLOR || 0x2b6cb0);

export function buildItemEmbed(item, filterLabel) {
  const embed = new EmbedBuilder()
    .setTitle(item.title?.slice(0, 240) || 'Neues Angebot')
    .setURL(item.url)
    .setThumbnail(item.images?.[0] || null)
    .setDescription([
      item.brand ? `**Marke:** ${item.brand}` : null,
      item.size ? `**Größe:** ${item.size}` : null,
      item.condition ? `**Zustand:** ${item.condition}` : null,
      item.location ? `**Ort:** ${item.location}` : null,
      item.seller?.name ? `**Verkäufer:** ${item.seller.name} (${item.seller?.rating ?? '—'}⭐)` : null,
    ].filter(Boolean).join('\n'))
    .addFields(
      { name: 'Preis', value: `${item.price} ${item.currency}`, inline: true },
      item.shipping ? { name: 'Versand', value: String(item.shipping), inline: true } : null
    ).setColor(DEFAULT_COLOR)
     .setFooter({ text: filterLabel ? `Filter: ${filterLabel}` : 'Vinted' })
     .setTimestamp(new Date(item.createdAt || Date.now()));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Zum Angebot').setStyle(ButtonStyle.Link).setURL(item.url),
    new ButtonBuilder().setCustomId(`save_${item.id}`).setLabel('Merken').setStyle(ButtonStyle.Secondary)
  );

  return { embed, row };
}
