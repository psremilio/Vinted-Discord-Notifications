import { buildItemEmbed } from './embeds.js';

const BATCH = String(process.env.BATCH_POSTING || 'true') === 'true';
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 5);

export async function postItems(client, channelId, filterLabel, items) {
  const channel = await client.channels.fetch(channelId);
  if (!BATCH) {
    for (const item of items) {
      const { embed, row } = buildItemEmbed(item, filterLabel);
      await channel.send({ embeds: [embed], components: [row] });
    }
    return;
  }
  const chunk = items.slice(0, BATCH_SIZE);
  const embeds = [];
  const rows = [];
  for (const item of chunk) {
    const { embed, row } = buildItemEmbed(item, filterLabel);
    embeds.push(embed);
    rows.push(row);
  }
  await channel.send({ embeds, components: rows.length ? [rows[0]] : [] });
}
