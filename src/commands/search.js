import { SlashCommandBuilder, EmbedBuilder, ChannelType, PermissionsBitField } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { addSearch } from '../run.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const filePath = path.resolve(__dirname, '../../config/channels.json');

// Keep this as an alias of new_search but registered under name "search"
export const data = new SlashCommandBuilder()
  .setName('search')
  .setDescription('Start receiving notifications for this Vinted channel (alias of new_search).')
  .addStringOption(option =>
    option.setName('name')
      .setDescription('The name of your new search.')
      .setRequired(true))
  .addStringOption(option =>
    option.setName('url')
      .setDescription('The URL of the Vinted product page.')
      .setRequired(true))
  .addStringOption(option =>
    option.setName('banned_keywords')
      .setDescription('Comma-separated keywords to filter from titles (e.g., "fake, kids")')
      .setRequired(false))
  .addStringOption(option =>
    option.setName('frequency')
      .setDescription('Polling frequency in seconds (defaults to 10s).')
      .setRequired(false));

const validateUrl = (url) => {
  try {
    const u = new URL(url);
    const isVinted = /(^|\.)vinted\./i.test(u.host);
    const hasCatalog = /\/catalog(\/|$)/i.test(u.pathname);
    const hasParams = u.search && u.searchParams.toString().length > 0;
    if (!isVinted || !hasCatalog) return 'invalid-url-with-example';
    if (!hasParams) return 'must-have-query-params';
    return true;
  } catch {
    return 'invalid-url';
  }
};

export const execute = async (interaction) => {
  if (!interaction.deferred && !interaction.replied) {
    try { await interaction.deferReply({ ephemeral: true }); } catch {}
  }

  const url = interaction.options.getString('url');
  const banned_keywords = interaction.options.getString('banned_keywords') ? interaction.options.getString('banned_keywords').split(',').map(s => s.trim()) : [];
  let frequency = Number.parseInt(interaction.options.getString('frequency') ?? '10', 10);
  if (!Number.isFinite(frequency)) frequency = 10;
  frequency = Math.min(Math.max(frequency, 5), 3600);
  const name = interaction.options.getString('name');
  const ch = interaction.channel;
  const channel_id = ch?.id;

  try {
    const allowedTypes = new Set([
      ChannelType.GuildText,
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
      ChannelType.AnnouncementThread,
    ]);
    const isAllowedType = allowedTypes.has(ch?.type);
    const canSend = !!ch?.permissionsFor?.(interaction.client.user)?.has?.(PermissionsBitField.Flags.SendMessages);
    if (!channel_id || !isAllowedType || !canSend) {
      await interaction.followUp({ content: 'Dieser Kanal ist ungeeignet. Bitte nutze einen Textkanal, in dem der Bot schreiben darf.' });
      return;
    }
  } catch {}

  const validation = validateUrl(url);
  if (validation !== true) {
    await interaction.followUp({ content: validation });
    return;
  }

  try {
    const searches = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (searches.some(s => s.channelName === name)) {
      await interaction.followUp({ content: 'A search with the name ' + name + ' already exists.' });
      return;
    }
    const search = {
      channelId: channel_id,
      channelName: name,
      url,
      frequency: Number(frequency),
      titleBlacklist: banned_keywords,
    };
    searches.push(search);
    try {
      fs.writeFileSync(filePath, JSON.stringify(searches, null, 2));
    } catch (e) {
      console.error('\nError saving new search (alias):', e);
      await interaction.followUp({ content: 'There was an error starting the monitoring.' });
    }
    try {
      addSearch(interaction.client, search);
    } catch (err) {
      console.error('Live scheduling failed (alias):', err);
    }

    const embed = new EmbedBuilder()
      .setTitle('Search saved!')
      .setDescription('Monitoring for ' + name + ' is now live!')
      .setColor(0x00FF00);
    await interaction.followUp({ embeds: [embed] });
  } catch (err) {
    console.error('Error starting monitoring (alias):', err);
    await interaction.followUp({ content: 'There was an error starting the monitoring.' });
  }
};

