import { SlashCommandBuilder, EmbedBuilder, ChannelType, PermissionsBitField } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { addSearch } from '../run.js';
import { buildParentKey, canonicalizeUrl } from '../rules/urlNormalizer.js';
import { ensureWebhooksForChannel } from '../infra/webhooksManager.js';
import { metrics } from '../infra/metrics.js';
import { enqueueMutation, pendingMutations } from '../infra/mutationQueue.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const filePath = path.resolve(__dirname, '../../config/channels.json');

export const data = new SlashCommandBuilder()
    .setName('new_search')
    .setDescription('Start receiving notifications for this Vinted channel. Duplicate names are ignored.')
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
            .setDescription('Keywords to ban from the title of the search results. (separate with commas -> "keyword1, keyword2")')
            .setRequired(false))
    .addStringOption(option =>
        option.setName('frequency')
            .setDescription('The frequency of the search in seconds. (defaults to 10s)')
            .setRequired(false))
    .addBooleanOption(option =>
        option.setName('auto_webhooks')
            .setDescription('Create and use webhooks for this channel for faster posting (requires Manage Webhooks)')
            .setRequired(false));

// validate that the URL is a Vinted catalog URL with at least one query parameter
const validateUrl = (url) => {
    try {
        const u = new URL(url);
        // Accept any vinted.* host and require at least one query parameter
        const isVinted = /(^|\.)vinted\./i.test(u.host);
        const hasParams = u.search && u.searchParams.toString().length > 0;
        if (!isVinted) return 'invalid-url';
        if (!hasParams) return 'must-have-query-params';
        return true;
    } catch (error) {
        return 'invalid-url';
    }
}

export const execute = async (interaction) => {
    const t0 = Date.now();
    // Ensure we have an ack to enable editReply/followUp safely
    try {
      if (!interaction?.deferred && !interaction?.replied) {
        try { await interaction.deferReply({ ephemeral: true }); }
        catch { try { await interaction.deferReply({ ephemeral: true }); } catch { try { await interaction.reply({ content: '⏳ …', flags: 1 << 6 }); } catch {} } }
      }
    } catch (e) {
      try { console.warn('[cmd.warn] /new_search failed to defer:', e?.message || e); } catch {}
    }
    try { console.log('[cmd.latency] /new_search ack_ms=%d', 0); } catch {}

    async function safeEdit(contentOrOptions) {
        try {
            if (interaction.deferred || interaction.replied) return await interaction.editReply(contentOrOptions);
            return await interaction.reply(typeof contentOrOptions === 'string' ? { content: contentOrOptions, ephemeral: true } : { ...contentOrOptions, ephemeral: true });
        } catch (e) {
            try { return await interaction.followUp(typeof contentOrOptions === 'string' ? { content: contentOrOptions, ephemeral: true } : { ...contentOrOptions, ephemeral: true }); } catch {}
        }
    }

    if (!interaction) {
      try { console.error('[cmd.error] /new_search interaction=undefined'); } catch {}
      return;
    }
    const urlRaw = interaction.options?.getString?.('url');
    const banned_keywords = interaction.options.getString('banned_keywords') ? interaction.options.getString('banned_keywords').split(',').map(keyword => keyword.trim()) : [];
    // Normalize and clamp frequency to avoid too aggressive polling
    const freqRaw = interaction.options.getString('frequency');
    let frequency = Number.parseInt(freqRaw ?? '10', 10);
    if (!Number.isFinite(frequency)) frequency = 10;
    frequency = Math.min(Math.max(frequency, 5), 3600); // 5s–1h
    const name = interaction.options?.getString?.('name');
    const ch = interaction.channel;
    const channel_id = ch?.id;

    // Validate channel type and send permission to avoid Unknown Channel at post time
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
            try { console.warn('[cmd.warn] /new_search invalid_channel', { id: channel_id || null, type: ch?.type, canSend }); } catch {}
            await safeEdit('Dieser Kanal ist für Benachrichtigungen ungeeignet. Bitte führe den Befehl in einem Textkanal aus, in dem der Bot schreiben darf.');
            return;
        }
    } catch {}

    // validate the URL
    const validation = validateUrl(urlRaw);
    if (validation !== true) {
        await safeEdit(String(validation));
        return;
    }

    try {
        const canonicalUrl = canonicalizeUrl(urlRaw);
        const canonicalKey = buildParentKey(canonicalUrl);

        // Enqueue mutation to serialize writes and rebuilds
        const queued = pendingMutations();
        if (queued > 0) {
          try { await safeEdit(`⏳ Eingereiht… (${queued} vor dir)`); } catch {}
        }

        enqueueMutation('new_search', async () => {
          try { console.log('[cmd.enqueued.mutation]', 'name=', name, 'op=new_search'); } catch {}
          let op = 'created';
          const searches = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
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

          if (idxByKey !== -1) {
              const prev = searches[idxByKey] || {};
              if (idxByName !== -1 && idxByName !== idxByKey) {
                  next.channelName = prev.channelName;
              }
              searches[idxByKey] = { ...prev, ...next };
              op = 'updated';
          } else if (idxByName !== -1) {
              const prev = searches[idxByName] || {};
              searches[idxByName] = { ...prev, ...next };
              op = 'updated';
          } else {
              searches.push(next);
              op = 'created';
          }

          try { await fs.promises.writeFile(filePath, JSON.stringify(searches, null, 2)); } catch (error) { console.error('[cmd] error saving new search:', error?.message || error); }

          // Apply in-memory update to scheduler
          try { await addSearch(interaction.client, next); } catch (e) { console.warn('[cmd] addSearch immediate failed, will rely on rebuild:', e?.message || e); }

          // Auto webhooks
          const WANT_AUTO = (interaction.options.getBoolean('auto_webhooks') ?? (String(process.env.AUTO_WEBHOOKS_ON_COMMAND || '1') === '1'));
          if (WANT_AUTO) {
            try { await ensureWebhooksForChannel(ch, Number(process.env.WEBHOOKS_PER_CHANNEL || 3), String(process.env.WEBHOOK_NAME_PREFIX || 'snipe-webhook')); } catch (e) { console.warn('[webhooks] auto failed:', e?.message || e); }
          }

          // Non-blocking diff rebuild to refresh families
          try {
            const mod = await import('../run.js');
            if (typeof mod.incrementalRebuildFromDisk === 'function') mod.incrementalRebuildFromDisk(interaction.client);
            else if (typeof mod.rebuildFromDisk === 'function') mod.rebuildFromDisk(interaction.client);
          } catch (err) {
            console.error('[cmd] rebuild after create failed:', err?.message || err);
          }

          // Respond when done
        const exec = Date.now() - t0;
        try {
          const nameKey = '/new_search';
          const k = nameKey;
          const arr = (global.__cmd_exec_samples = global.__cmd_exec_samples || new Map());
          let list = arr.get(k); if (!list) { list = []; arr.set(k, list); }
          list.push(exec); if (list.length > 300) list.shift();
          const a = list.slice().sort((x,y)=>x-y); const p95 = a[Math.min(a.length - 1, Math.floor(a.length * 0.95))];
          metrics.cmd_exec_ms_p95?.set({ command: nameKey }, p95);
        } catch {}
        const embed = new EmbedBuilder()
            .setTitle(op === 'created' ? 'Search created' : 'Search updated')
            .setDescription(`Monitoring for ${next.channelName} is now ${op === 'created' ? 'live' : 'updated'}!`)
            .setColor(0x00FF00);
        embed.addFields({ name: 'Key', value: `parent=${canonicalKey}`, inline: false });
        await safeEdit({ embeds: [embed]});
        try { console.log('[cmd.result] /new_search op=%s name=%s key=%s', op, next.channelName, canonicalKey); } catch {}
        try { console.log('[cmd.latency] /new_search exec_ms=%d', exec); } catch {}
        }, async (e) => {
          console.error('Error starting monitoring:', e);
          await safeEdit('There was an error starting the monitoring.');
        });
    } catch (error) {
        console.error('Error starting monitoring:', error);
        await safeEdit('There was an error starting the monitoring.');
    }
}
