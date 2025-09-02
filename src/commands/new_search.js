import { SlashCommandBuilder, EmbedBuilder, ChannelType, PermissionsBitField } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { addSearch } from '../run.js';
import { ensureWebhooksForChannel } from '../infra/webhooksManager.js';
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
        // Accept any vinted.* host and any path containing "/catalog"
        const isVinted = /(^|\.)vinted\./i.test(u.host);
        const hasCatalog = /\/catalog(\/|$)/i.test(u.pathname);
        const hasParams = u.search && u.searchParams.toString().length > 0;
        if (!isVinted || !hasCatalog) return 'invalid-url-with-example';
        if (!hasParams) return 'must-have-query-params';
        return true;
    } catch (error) {
        return 'invalid-url';
    }
}

export const execute = async (interaction) => {
    const t0 = Date.now();
    let acked = false;
    try {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ ephemeral: true });
            acked = true;
        } else {
            acked = true;
        }
    } catch (e) {
        // Fallback: try an immediate ephemeral reply via flags
        try {
            await interaction.reply({ content: '⏳ wird angelegt…', flags: 1 << 6 });
            acked = true;
        } catch (e2) {
            console.warn('[cmd.ack.fail] new_search', e?.message || e, e2?.message || e2);
        }
    }
    try { console.log('[cmd.latency] /new_search ack_ms=%d', Date.now() - t0); } catch {}

    async function safeEdit(contentOrOptions) {
        try {
            if (interaction.deferred || interaction.replied) return await interaction.editReply(contentOrOptions);
            return await interaction.reply(typeof contentOrOptions === 'string' ? { content: contentOrOptions, flags: 1 << 6 } : { ...contentOrOptions, flags: 1 << 6 });
        } catch {}
    }

    const url = interaction.options.getString('url');
    const banned_keywords = interaction.options.getString('banned_keywords') ? interaction.options.getString('banned_keywords').split(',').map(keyword => keyword.trim()) : [];
    // Normalize and clamp frequency to avoid too aggressive polling
    const freqRaw = interaction.options.getString('frequency');
    let frequency = Number.parseInt(freqRaw ?? '10', 10);
    if (!Number.isFinite(frequency)) frequency = 10;
    frequency = Math.min(Math.max(frequency, 5), 3600); // 5s–1h
    const name = interaction.options.getString('name');
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
            await safeEdit('Dieser Kanal ist für Benachrichtigungen ungeeignet. Bitte führe den Befehl in einem Textkanal aus, in dem der Bot schreiben darf.');
            return;
        }
    } catch {}

    // validate the URL
    const validation = validateUrl(url);
    if (validation !== true) {
        await safeEdit(String(validation));
        return;
    }

    try {
        // optionally create webhooks for this channel
        const WANT_AUTO = (interaction.options.getBoolean('auto_webhooks') ?? (String(process.env.AUTO_WEBHOOKS_ON_COMMAND || '1') === '1'));
        let createdHooks = 0;
        if (WANT_AUTO) {
            try {
                const urls = await ensureWebhooksForChannel(ch, Number(process.env.WEBHOOKS_PER_CHANNEL || 3), String(process.env.WEBHOOK_NAME_PREFIX || 'snipe-webhook'));
                createdHooks = Array.isArray(urls) ? urls.length : 0;
            } catch (e) {
                console.warn('[webhooks] auto failed:', e?.message || e);
            }
        }

        //register the search into the json file
        const searches = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        if (searches.some(search => search.channelName === name)) {
            await safeEdit('A search with the name ' + name + ' already exists.');
            return;
        }

        const search = {
            "channelId": channel_id,
            "channelName": name,
            "url": url,
            "frequency": Number(frequency),
            "titleBlacklist": banned_keywords
        };
        searches.push(search);

        try{
            fs.writeFileSync(filePath, JSON.stringify(searches, null, 2));
        } catch (error) {
            console.error('\nError saving new search:', error);
            await safeEdit('There was an error starting the monitoring.');
        }

        // schedule immediately using the in-memory scheduler
        try {
            addSearch(interaction.client, search);
        } catch (err) {
            console.error('Live scheduling failed:', err);
        }

        const embed = new EmbedBuilder()
            .setTitle("Search saved!")
            .setDescription("Monitoring for " + name + " is now live!")
            .setColor(0x00FF00);

        if (createdHooks) {
            embed.addFields({ name: 'Webhooks', value: `Aktiviert (${createdHooks})`, inline: true });
        }

        await safeEdit({ embeds: [embed]});

    } catch (error) {
        console.error('Error starting monitoring:', error);
        await safeEdit('There was an error starting the monitoring.');
    }
}
