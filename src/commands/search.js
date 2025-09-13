import { SlashCommandBuilder, EmbedBuilder, ChannelType, PermissionsBitField } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildParentKey, canonicalizeUrl } from '../rules/urlNormalizer.js';
import { channelsPath } from '../infra/paths.js';
import { writeJsonAtomic, appendWal } from '../infra/atomicJson.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const filePath = channelsPath();

export const data = new SlashCommandBuilder()
  .setName('search')
  .setDescription('Manage Vinted searches (add/delete/list/show).')
  .addSubcommand(sc =>
    sc.setName('add')
      .setDescription('Create or update a search for this channel.')
      .addStringOption(o => o.setName('name').setDescription('Name for this search').setRequired(true))
      .addStringOption(o => o.setName('url').setDescription('Vinted catalog URL with query').setRequired(true))
      .addStringOption(o => o.setName('banned_keywords').setDescription('Comma-separated title filters').setRequired(false))
      .addStringOption(o => o.setName('frequency').setDescription('Polling interval in seconds (default 10)').setRequired(false))
      .addBooleanOption(o => o.setName('auto_webhooks').setDescription('Create webhooks for faster posting').setRequired(false))
  )
  .addSubcommand(sc =>
    sc.setName('delete')
      .setDescription('Delete a search by name or URL.')
      .addStringOption(o => o.setName('name').setDescription('Search name').setRequired(false))
      .addStringOption(o => o.setName('url').setDescription('Vinted URL (canonical match)').setRequired(false))
  )
  .addSubcommand(sc =>
    sc.setName('list')
      .setDescription('List all searches for this server.')
  )
  .addSubcommand(sc =>
    sc.setName('show')
      .setDescription('Show details for one search.')
      .addStringOption(o => o.setName('name').setDescription('Search name').setRequired(true))
  );

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
    try { await interaction.deferReply({ flags: 1 << 6 }); }
    catch { try { await interaction.reply({ content: '✅', flags: 1 << 6 }); } catch {} }
  }

  async function safeEdit(contentOrOptions) {
    try {
      if (interaction.deferred || interaction.replied) return await interaction.editReply(contentOrOptions);
      return await interaction.reply(typeof contentOrOptions === 'string' ? { content: contentOrOptions, flags: 1 << 6 } : { ...contentOrOptions, flags: 1 << 6 });
    } catch (e) {
      try { return await interaction.followUp(typeof contentOrOptions === 'string' ? { content: contentOrOptions, flags: 1 << 6 } : { ...contentOrOptions, flags: 1 << 6 }); } catch {}
    }
  }

  const sub = interaction.options.getSubcommand ? interaction.options.getSubcommand() : 'add';

  const ch = interaction.channel;
  const channel_id = ch?.id;
  function chanOk() {
    try {
      const allowedTypes = new Set([
        ChannelType.GuildText,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ]);
      const isAllowedType = allowedTypes.has(ch?.type);
      const canSend = !!ch?.permissionsFor?.(interaction.client.user)?.has?.(PermissionsBitField.Flags.SendMessages);
      return !!channel_id && isAllowedType && canSend;
    } catch { return true; }
  }
  function parseKeywords(s) { return String(s || '').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean).slice(0,100); }
  function loadSearches() { try { return JSON.parse(fs.readFileSync(filePath,'utf8')); } catch { return []; } }
  async function saveSearches(arr) { writeJsonAtomic(filePath, arr); }

  if (sub === 'list') {
    const arr = loadSearches();
    const lines = arr.map(s => `• ${s.channelName} (${s.channelId}) → ${s.url}`);
    await safeEdit(lines.length ? lines.join('\n') : 'Keine Suchen konfiguriert.');
    return;
  }
  if (sub === 'show') {
    const name = interaction.options.getString('name');
    const arr = loadSearches();
    const it = arr.find(s => String(s.channelName) === String(name));
    if (!it) { await safeEdit(`Suche "${name}" nicht gefunden.`); return; }
    const eb = new EmbedBuilder().setTitle(it.channelName).setColor(0x00AAFF);
    eb.addFields(
      { name: 'URL', value: it.url || '-', inline: false },
      { name: 'Channel', value: it.channelId || '-', inline: true },
      { name: 'Freq(s)', value: String(it.frequency ?? '10'), inline: true },
      { name: 'Blacklist', value: (Array.isArray(it.titleBlacklist) && it.titleBlacklist.length) ? it.titleBlacklist.join(', ') : '—', inline: false },
    );
    await safeEdit({ embeds: [eb] });
    return;
  }

  if (sub === 'delete') {
    const name = interaction.options.getString('name');
    const urlRaw = interaction.options.getString('url');
    if (!name && !urlRaw) { await safeEdit('Bitte gib entweder name oder url an.'); return; }
    let key = null, keyNoPrice = null;
    try { if (urlRaw) { key = buildParentKey(urlRaw); keyNoPrice = buildParentKey(urlRaw, { stripPrice: true }); } } catch {}
    const arr = loadSearches();
    let idx = -1;
    if (key) {
      for (let i=0;i<arr.length;i++){ const s=arr[i]||{}; const k=s.canonicalKey || buildParentKey(String(s.url||'')); if (k===key) { idx=i; break; } }
      if (idx === -1 && keyNoPrice) { for (let i=0;i<arr.length;i++){ const s=arr[i]||{}; const k2 = buildParentKey(String(s.url||''),{stripPrice:true}); if (k2===keyNoPrice){ idx=i; break; } } }
    }
    if (idx === -1 && name) idx = arr.findIndex(s => String(s.channelName) === String(name));
    if (idx === -1) { await safeEdit(key ? `Kein Treffer für key ${key}${keyNoPrice?` (no_price=${keyNoPrice})`:''}` : `Suche "${name}" nicht gefunden.`); return; }
    const removed = arr[idx];
    arr.splice(idx,1);
    await saveSearches(arr);
    try { appendWal('search_delete', { name, key, keyNoPrice }); } catch {}
    try { const mod = await import('../run.js'); if (removed?.channelName) mod.removeJob?.(removed.channelName); await mod.incrementalRebuildFromDisk?.(interaction.client); } catch {}
    await safeEdit(`OK. Search ${removed?.channelName || name || key} gelöscht.`);
    return;
  }

  // Default: add/update
  if (!chanOk()) {
    try { console.warn('[cmd.warn] /search invalid_channel', { id: channel_id || null, type: ch?.type }); } catch {}
    await safeEdit({ content: 'Dieser Kanal ist ungeeignet. Bitte nutze einen Textkanal, in dem der Bot schreiben darf.' });
    return;
  }

  const name = interaction.options.getString('name');
  const urlRaw = interaction.options.getString('url');
  const banned_keywords = parseKeywords(interaction.options.getString('banned_keywords'));
  let frequency = Number.parseInt(interaction.options.getString('frequency') ?? '10', 10);
  if (!Number.isFinite(frequency)) frequency = 10;
  frequency = Math.min(Math.max(frequency, 5), 3600);

  const validation = validateUrl(urlRaw);
  if (validation !== true) { await safeEdit({ content: validation }); return; }

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
    await saveSearches(searches);
    try { appendWal('search_add', { name: next.channelName, url: next.url, channelId: next.channelId }); } catch {}

    try {
      const mod = await import('../run.js');
      setTimeout(() => {
        try {
          if (typeof mod.incrementalRebuildFromDisk === 'function') mod.incrementalRebuildFromDisk(interaction.client);
          else if (typeof mod.rebuildFromDisk === 'function') mod.rebuildFromDisk(interaction.client);
          else if (typeof mod.addSearch === 'function') mod.addSearch(interaction.client, next);
        } catch {}
      }, 0);
    } catch {}

    const WANT_AUTO = (interaction.options.getBoolean?.('auto_webhooks') ?? (String(process.env.AUTO_WEBHOOKS_ON_COMMAND || '1') === '1'));
    if (WANT_AUTO) {
      try {
        const { ensureWebhooksForChannel } = await import('../infra/webhooksManager.js');
        await ensureWebhooksForChannel(ch, Number(process.env.WEBHOOKS_PER_CHANNEL || 3), String(process.env.WEBHOOK_NAME_PREFIX || 'snipe-webhook'));
      } catch (e) {
        try { await safeEdit({ content: 'Suche angelegt. Hinweis: Keine Webhook-Rechte, poste direkt in den Kanal.' }); } catch {}
      }
    }

    const embed = new EmbedBuilder()
      .setTitle(op === 'created' ? 'Search created' : 'Search updated')
      .setDescription(`Monitoring for ${next.channelName} is now ${op === 'created' ? 'live' : 'updated'}!`)
      .setColor(0x00FF00);
    embed.addFields({ name: 'Key', value: `parent=${canonicalKey}`, inline: false });
    await safeEdit({ embeds: [embed] });
    try { console.log('[cmd.result] /search %s name=%s key=%s', op, next.channelName, canonicalKey); } catch {}
  } catch (err) {
    console.error('Error starting monitoring:', err);
    await safeEdit({ content: 'Fehler beim Starten der Überwachung.' });
  }
};
