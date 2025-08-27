import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { buildListingEmbed } from './embeds.js';

const BATCH = String(process.env.BATCH_POSTING || 'true') === 'true';
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 5);

export async function postItems(client, channelId, filterLabel, items) {
  const channel = await client.channels.fetch(channelId);

  function buildRow(item) {
    const fastbuyUrl = `${item.url}${item.url.includes('?') ? '&' : '?'}fastbuy=1`;
    // Only link buttons to avoid potential invalid form issues
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('FASTBUY').setStyle(ButtonStyle.Link).setURL(fastbuyUrl),
      new ButtonBuilder().setLabel('Zum Angebot').setStyle(ButtonStyle.Link).setURL(item.url)
    );
  }

  if (!BATCH) {
    for (const item of items) {
      const embed = buildListingEmbed(item);
      const row = buildRow(item);
      try {
        await channel.send({ embeds: [embed], components: [row] });
      } catch (e) {
        console.error('[poster] send failed (single)', channelId, e?.code || e?.message || e);
      }
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
  try {
    await channel.send({ embeds, components: rows.length ? [rows[0]] : [] });
  } catch (e) {
    console.error('[poster] send failed (batch)', channelId, e?.code || e?.message || e);
  }
}
