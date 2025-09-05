import { SlashCommandBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { enqueueMutation, pendingMutations } from '../infra/mutationQueue.js';
import { activeSearches } from '../run.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const filePath = path.resolve(__dirname, '../../config/channels.json');

export const data = new SlashCommandBuilder()
  .setName('filter')
  .setDescription('Verwalte Titel-Filter (Blacklist) für vorhandene Suchen.')
  .setDMPermission(false)
  .addSubcommand(sc =>
    sc.setName('create')
      .setDescription('Filter für eine bestehende Suche anlegen/ergänzen.')
      .addStringOption(o => o.setName('name').setDescription('Name der Suche').setRequired(true))
      .addStringOption(o => o.setName('keywords').setDescription('Komma-separierte Keywords').setRequired(true))
      .addStringOption(o => o.setName('mode').setDescription('append|replace').setRequired(false))
  )
  .addSubcommand(sc =>
    sc.setName('list')
      .setDescription('Alle Filter (Blacklist) im Server auflisten.'))
  .addSubcommand(sc =>
    sc.setName('show')
      .setDescription('Filter einer Suche anzeigen.')
      .addStringOption(o => o.setName('name').setDescription('Name der Suche').setRequired(true))
  )
  .addSubcommand(sc =>
    sc.setName('delete')
      .setDescription('Filter einer Suche löschen (oder einzelne Keywords entfernen).')
      .addStringOption(o => o.setName('name').setDescription('Name der Suche').setRequired(true))
      .addStringOption(o => o.setName('keywords').setDescription('Optionale Komma-Liste; leer = alles löschen').setRequired(false))
  );

function parseKeywords(s) {
  return String(s || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)
    .filter(x => x.length <= 80)
    .slice(0, 100);
}

async function ack(interaction) {
  try {
    if (!interaction?.deferred && !interaction?.replied) {
      try { await interaction.deferReply({ flags: 1 << 6 }); }
      catch { try { await interaction.reply({ content: '...', flags: 1 << 6 }); } catch {} }
    }
  } catch {}
}

async function edit(interaction, contentOrOptions) {
  try {
    if (interaction.deferred || interaction.replied) return await interaction.editReply(contentOrOptions);
    return await interaction.reply(typeof contentOrOptions === 'string' ? { content: contentOrOptions, flags: 1 << 6 } : { ...contentOrOptions, flags: 1 << 6 });
  } catch (e) {
    try { return await interaction.followUp(typeof contentOrOptions === 'string' ? { content: contentOrOptions, flags: 1 << 6 } : { ...contentOrOptions, flags: 1 << 6 }); } catch {}
  }
}

function loadSearches() {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return []; }
}
async function saveSearches(arr) {
  try { await fs.promises.writeFile(filePath, JSON.stringify(arr, null, 2)); } catch (e) { console.warn('[cmd.filter] save failed:', e?.message || e); }
}

function ensureSearchExists(searches, name) {
  let idx = searches.findIndex(s => String(s.channelName) === String(name));
  if (idx !== -1) return idx;
  try {
    const rule = activeSearches?.get?.(String(name));
    if (rule) {
      const toInsert = {
        channelName: String(rule.channelName || name),
        channelId: rule.channelId || '',
        url: rule.url || rule.link || '',
      };
      searches.push(toInsert);
      return searches.length - 1;
    }
  } catch {}
  return -1;
}

export const execute = async (interaction) => {
  try { console.log('[cmd.filter]', 'user=', interaction?.user?.id, 'guild=', interaction?.guildId, 'sub=', interaction?.options?.getSubcommand?.()); } catch {}
  const sub = interaction.options.getSubcommand();
  await ack(interaction);
  const queued = pendingMutations();
  if (queued > 0) { try { await edit(interaction, `Warteschlange... (${queued} vor dir)`); } catch {} }

  if (sub === 'list') {
    enqueueMutation('filter_list', async () => {
      const searches = loadSearches();
      const lines = [];
      for (const s of (searches || [])) {
        const list = Array.isArray(s.titleBlacklist) ? s.titleBlacklist : [];
        if (!list.length) continue;
        lines.push(`• ${s.channelName}: ${list.join(', ')}`);
      }
      await edit(interaction, lines.length ? lines.join('\n') : 'Keine Filter gefunden.');
      try { console.log('[cmd.filter] list ok count=%d', lines.length); } catch {}
    }, async (e) => { console.error('[cmd.filter] list error', e); await edit(interaction, 'Fehler beim Anzeigen der Filter.'); });
    return;
  }

  if (sub === 'show') {
    const name = interaction.options.getString('name');
    enqueueMutation('filter_show', async () => {
      const searches = loadSearches();
      const idx = searches.findIndex(s => String(s.channelName) === String(name));
      if (idx === -1) { await edit(interaction, `Suche "${name}" nicht gefunden.`); return; }
      const list = Array.isArray(searches[idx].titleBlacklist) ? searches[idx].titleBlacklist : [];
      await edit(interaction, list.length ? `${name}: ${list.join(', ')}` : `${name}: —`);
      try { console.log('[cmd.filter] show ok name=%s size=%d', name, list.length); } catch {}
    }, async (e) => { console.error('[cmd.filter] show error', e); await edit(interaction, 'Fehler beim Anzeigen des Filters.'); });
    return;
  }

  if (sub === 'create') {
    const name = interaction.options.getString('name');
    const kw = parseKeywords(interaction.options.getString('keywords'));
    const mode = String(interaction.options.getString('mode') || 'append').toLowerCase();
    enqueueMutation('filter_create', async () => {
      const searches = loadSearches();
      let idx = ensureSearchExists(searches, name);
      if (idx === -1) { await edit(interaction, `Suche "${name}" nicht gefunden.`); return; }
      const prev = Array.isArray(searches[idx].titleBlacklist) ? searches[idx].titleBlacklist : [];
      let next = prev.slice();
      if (mode === 'replace') next = [];
      next = Array.from(new Set([...next, ...kw])).slice(0, 200).sort((a,b)=>a.localeCompare(b));
      searches[idx].titleBlacklist = next;
      await saveSearches(searches);
      await edit(interaction, `✅ Filter ${mode === 'replace' ? 'gesetzt' : 'ergänzt'}: ${name} → ${next.join(', ') || '—'}`);
      try { console.log('[cmd.filter] create ok name=%s delta=%d size=%d', name, kw.length, next.length); } catch {}
    }, async (e) => { console.error('[cmd.filter] create error', e); await edit(interaction, 'Fehler beim Anlegen des Filters.'); });
    return;
  }

  if (sub === 'delete') {
    const name = interaction.options.getString('name');
    const kwRaw = interaction.options.getString('keywords');
    const kw = parseKeywords(kwRaw || '');
    enqueueMutation('filter_delete', async () => {
      const searches = loadSearches();
      let idx = ensureSearchExists(searches, name);
      if (idx === -1) { await edit(interaction, `Suche "${name}" nicht gefunden.`); return; }
      if (!kw.length) {
        searches[idx].titleBlacklist = [];
        await saveSearches(searches);
        await edit(interaction, `🗑️ Filter gelöscht: ${name}`);
      } else {
        const prev = Array.isArray(searches[idx].titleBlacklist) ? searches[idx].titleBlacklist : [];
        const remove = new Set(kw);
        const next = prev.filter(x => !remove.has(x));
        searches[idx].titleBlacklist = next;
        await saveSearches(searches);
        await edit(interaction, `🧹 Entfernt: ${kw.join(', ')} | übrig: ${next.join(', ') || '—'}`);
      }
      try { console.log('[cmd.filter] delete ok name=%s removed=%d', name, kw.length); } catch {}
    }, async (e) => { console.error('[cmd.filter] delete error', e); await edit(interaction, 'Fehler beim Löschen des Filters.'); });
    return;
  }

  await edit(interaction, 'Unbekannter Subcommand.');
};

