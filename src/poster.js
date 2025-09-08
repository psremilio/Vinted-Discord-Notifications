import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { buildListingEmbed } from './embeds.js';

const BATCH = String(process.env.BATCH_POSTING || 'true') === 'true';
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 5);

export async function postItems(client, channelId, filterLabel, items) {
  const channel = await client.channels.fetch(channelId);

  function buildRow(item) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Zum Angebot').setStyle(ButtonStyle.Link).setURL(item.url),
      new ButtonBuilder().setCustomId(`save_${item.id}`).setLabel('Merken').setStyle(ButtonStyle.Secondary)
    );
  }

  if (!BATCH) {
    for (const item of items) {
      const embed = buildListingEmbed(item);
      const row = buildRow(item);
      await channel.send({ embeds: [embed], components: [row] });
    }
    return;
  }
  const chunk = items.slice(0, BATCH_SIZE);
  const embeds = [];
  const rows = [];
  for (const item of chunk) {
    const embed = buildListingEmbed(item);
    const row = buildRow(item);
    embeds.push(embed);
    rows.push(row);
  }
  await channel.send({ embeds, components: rows.length ? [rows[0]] : [] });
}
