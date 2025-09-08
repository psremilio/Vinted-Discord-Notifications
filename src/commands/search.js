import { SlashCommandBuilder, EmbedBuilder, ChannelType, PermissionsBitField } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { addSearch } from '../run.js';
import { buildParentKey, canonicalizeUrl } from '../rules/urlNormalizer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
function resolveChannelsPath() {
  try {
    const pData = path.resolve(__dirname, '../../data/channels.json');
    // ensure /data dir exists when writable
    try { fs.mkdirSync(path.resolve(__dirname, '../../data'), { recursive: true }); } catch {}
    return pData;
  } catch {}
  return path.resolve(__dirname, '../../config/channels.json');
}
const filePath = resolveChannelsPath();

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
  if (!interaction?.deferred && !interaction?.replied) {
    try { await interaction.deferReply({ ephemeral: true }); }
    catch { try { await interaction.reply({ content: '…', ephemeral: true }); } catch {} }
  }

  async function safeEdit(contentOrOptions) {
    try {
      if (interaction.deferred || interaction.replied) return await interaction.editReply(contentOrOptions);
      return await interaction.reply(typeof contentOrOptions === 'string' ? { content: contentOrOptions, ephemeral: true } : { ...contentOrOptions, ephemeral: true });
    } catch (e) {
      try { return await interaction.followUp(typeof contentOrOptions === 'string' ? { content: contentOrOptions } : { ...contentOrOptions }); } catch {}
    }
  }

  const urlRaw = interaction.options.getString('url');
  const banned_keywords = interaction.options.getString('banned_keywords') ? interaction.options.getString('banned_keywords').split(',').map(s => s.trim().toLowerCase()) : [];
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
      try { console.warn('[cmd.warn] /search invalid_channel', { id: channel_id || null, type: ch?.type, canSend }); } catch {}
      await safeEdit({ content: 'Dieser Kanal ist ungeeignet. Bitte nutze einen Textkanal, in dem der Bot schreiben darf.' });
      return;
    }
  } catch {}

  const validation = validateUrl(urlRaw);
  if (validation !== true) {
    await safeEdit({ content: validation });
    return;
  }

  try {
    const searches = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const canonicalUrl = canonicalizeUrl(urlRaw);
    const canonicalKey = buildParentKey(canonicalUrl);
    const findByKey = (list, key) => {
      if (!Array.isArray(list)) return -1;
      for (let i = 0; i < list.length; i++) {
        const s = list[i] || {};
        const k = s.canonicalKey || buildParentKey(String(s.url || ''));
        if (k === key) return i;
      }
      return -1;
    };
    const idxByKey = findByKey(searches, canonicalKey);
    const idxByName = searches.findIndex(s => String(s.channelName) === String(name));
    const next = {
      channelId: channel_id,
      channelName: name,
      url: canonicalUrl,
      frequency: Number(frequency),
      titleBlacklist: banned_keywords,
      canonicalKey,
    };
    let op = 'created';
    if (idxByKey !== -1) {
      const prev = searches[idxByKey] || {};
      if (idxByName !== -1 && idxByName !== idxByKey) next.channelName = prev.channelName;
      searches[idxByKey] = { ...prev, ...next };
      op = 'updated';
    } else if (idxByName !== -1) {
      const prev = searches[idxByName] || {};
      searches[idxByName] = { ...prev, ...next };
      op = 'updated';
    } else {
      searches.push(next);
    }
    try {
      fs.writeFileSync(filePath, JSON.stringify(searches, null, 2));
      // best effort: also mirror to config path for compatibility
      try { fs.writeFileSync(path.resolve(__dirname, '../../config/channels.json'), JSON.stringify(searches, null, 2)); } catch {}
    } catch (e) {
      console.error('\nError saving new search (alias):', e);
      await safeEdit({ content: 'There was an error starting the monitoring.' });
    }
    try {
      // Prefer incremental rebuild so updates apply immediately
      const mod = await import('../run.js');
      setTimeout(() => {
        try {
          if (typeof mod.incrementalRebuildFromDisk === 'function') mod.incrementalRebuildFromDisk(interaction.client);
          else if (typeof mod.rebuildFromDisk === 'function') mod.rebuildFromDisk(interaction.client);
          else if (typeof mod.addSearch === 'function') mod.addSearch(interaction.client, next);
        } catch {}
      }, 0);
    } catch (err) {
      console.error('Live scheduling rebuild failed (alias):', err);
    }

    const embed = new EmbedBuilder()
      .setTitle(op === 'created' ? 'Search created' : 'Search updated')
      .setDescription(`Monitoring for ${next.channelName} is now ${op === 'created' ? 'live' : 'updated'}!`)
      .setColor(0x00FF00);
    embed.addFields({ name: 'Key', value: `parent=${canonicalKey}`, inline: false });
    await safeEdit({ embeds: [embed] });
    try { console.log('[cmd.result] /search op=%s name=%s key=%s', op, next.channelName, canonicalKey); } catch {}
  } catch (err) {
    console.error('Error starting monitoring (alias):', err);
    await safeEdit({ content: 'There was an error starting the monitoring.' });
  }
};
