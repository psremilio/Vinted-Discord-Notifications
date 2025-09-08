import { SlashCommandBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildParentKey } from '../rules/urlNormalizer.js';
import { tombstoneRule } from '../run.js';
import { purgeChannelQueues } from '../infra/postQueue.js';
import { metrics } from '../infra/metrics.js';
import { enqueueMutation, pendingMutations } from '../infra/mutationQueue.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const filePath = path.resolve(__dirname, '../../config/channels.json');

export const data = new SlashCommandBuilder()
    .setName('delete_search')
    .setDescription('Start receiving notifications for this Vinted channel.')
    .addStringOption(option =>
        option.setName('name')
            .setDescription('The name of your new search.')
            .setRequired(false))
    .addStringOption(option =>
        option.setName('url')
            .setDescription('The URL of the Vinted search to delete (optional; canonical match).')
            .setRequired(false));

export const execute = async (interaction) => {
    const t0 = Date.now();
    // Ensure we have an ack to be able to editReply
    try {
      if (!interaction.deferred && !interaction.replied) {
        try { await interaction.deferReply({ ephemeral: true }); } catch { try { await interaction.reply({ content: '…', ephemeral: true }); } catch {} }
      }
    } catch {}

    async function safeEdit(contentOrOptions) {
      try {
        if (interaction.deferred || interaction.replied) return await interaction.editReply(contentOrOptions);
        return await interaction.reply(typeof contentOrOptions === 'string' ? { content: contentOrOptions, ephemeral: true } : { ...contentOrOptions, ephemeral: true });
      } catch (e) {
        try { return await interaction.followUp(typeof contentOrOptions === 'string' ? { content: contentOrOptions } : { ...contentOrOptions }); } catch {}
      }
    }
    if (!interaction) {
      try { console.error('[cmd.error] /delete_search interaction=undefined'); } catch {}
      return;
    }
    const name = interaction.options?.getString?.('name');
    const urlRaw = interaction.options?.getString?.('url');
    let key = null;
    let keyNoPrice = null;
    try { if (urlRaw) { key = buildParentKey(urlRaw); keyNoPrice = buildParentKey(urlRaw, { stripPrice: true }); } } catch {}

    try {
        const queued = pendingMutations();
        if (queued > 0) {
          try { await safeEdit(`⏳ Eingereiht… (${queued} vor dir)`); } catch {}
        }
        enqueueMutation('delete_search', async () => {
          try { console.log('[cmd.enqueued.mutation]', 'name=', name || '(by_url)', 'op=delete_search'); } catch {}
          let beforeRules = null, afterRules = null;
          try { const mod = await import('../run.js'); beforeRules = mod.activeSearches?.size ?? null; } catch {}
          const searches = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
          let searchIndex = -1;
          if (key) {
              for (let i = 0; i < searches.length; i++) {
                  const s = searches[i] || {};
                  const k = s.canonicalKey || buildParentKey(String(s.url || ''));
                  if (k === key) { searchIndex = i; break; }
              }
              if (searchIndex === -1 && keyNoPrice) {
                  for (let i = 0; i < searches.length; i++) {
                      const s = searches[i] || {};
                      const k2 = buildParentKey(String(s.url || ''), { stripPrice: true });
                      if (k2 === keyNoPrice) { searchIndex = i; break; }
                  }
              }
          }
          if (searchIndex === -1 && name) {
              searchIndex = searches.findIndex(search => String(search.channelName) === String(name));
          }
          if (searchIndex === -1) {
              const msg = key ? `No search matched key ${key}${keyNoPrice ? ` (or no_price=${keyNoPrice})` : ''}` : `No search found with the name ${name}`;
              await safeEdit({ content: msg });
              return;
          }
          const removed = searches[searchIndex];
          const removedName = String(removed?.channelName || name || '');
          searches.splice(searchIndex, 1);
          // Immediate in-memory stop to unblock quickly
          try {
            const mod = await import('../run.js');
            try { mod.removeJob?.(removedName); } catch {}
            try { if (removed?.channelId) purgeChannelQueues(removed.channelId); } catch {}
            try { afterRules = mod.activeSearches?.size ?? null; } catch {}
          } catch {}
        const tag = name ? `name=\`${name}\`` : (key ? `key=\`${key}\`` : '');
        const commitMs = Date.now() - t0;
        try {
          const nameKey = '/delete_search';
          const k = nameKey;
          const arr = (global.__cmd_exec_samples = global.__cmd_exec_samples || new Map());
          let list = arr.get(k); if (!list) { list = []; arr.set(k, list); }
          list.push(commitMs); if (list.length > 300) list.shift();
          const a = list.slice().sort((x,y)=>x-y); const p95 = a[Math.min(a.length - 1, Math.floor(a.length * 0.95))];
          metrics.cmd_exec_ms_p95?.set({ command: nameKey }, p95);
        } catch {}
          try { await fs.promises.writeFile(filePath, JSON.stringify(searches, null, 2)); } catch (e) { console.warn('[cmd] save after delete failed:', e?.message || e); }
          try { tombstoneRule(removedName, removed?.url); } catch {}
          try { const mod = await import('../run.js'); if (typeof mod.incrementalRebuildFromDisk === 'function') mod.incrementalRebuildFromDisk(interaction.client); else if (typeof mod.rebuildFromDisk === 'function') mod.rebuildFromDisk(interaction.client); } catch (e) { console.warn('[cmd] rebuild after delete failed:', e?.message || e); }
          try { await safeEdit({ content: `✅ Search ${tag} deleted (commit_ms=${commitMs}, rules_before=${beforeRules}, rules_after=${afterRules})` }); } catch {}
          try { console.log('[cmd.result] /delete_search ok %s', tag); } catch {}
          try { console.log('[cmd.latency] /delete_search exec_ms=%d', Date.now() - t0); } catch {}
        }, async (error) => {
          console.error('\nError deleting the search:', error);
          try { await safeEdit({ content: 'There was an error deleting the search.'}); } catch {}
        });
    } catch (error) {
        console.error('\nError deleting the search:', error);
        try { await safeEdit({ content: 'There was an error deleting the search.'}); } catch {}
    }
}
