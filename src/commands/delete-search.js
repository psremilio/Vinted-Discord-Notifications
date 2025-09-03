import { SlashCommandBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildParentKey } from '../rules/urlNormalizer.js';
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
    const name = interaction.options.getString('name');
    const urlRaw = interaction.options.getString('url');
    let key = null;
    let keyNoPrice = null;
    try { if (urlRaw) { key = buildParentKey(urlRaw); keyNoPrice = buildParentKey(urlRaw, { stripPrice: true }); } } catch {}

    try {
        //delete the search that has 'name' as name
        const searches = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        let searchIndex = -1;
        if (key) {
            for (let i = 0; i < searches.length; i++) {
                const s = searches[i] || {};
                const k = s.canonicalKey || buildParentKey(String(s.url || ''));
                if (k === key) { searchIndex = i; break; }
            }
            // Fuzzy: ignore price bounds if exact key not found
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
            await interaction.editReply({ content: msg });
            return;
        }
        searches.splice(searchIndex, 1);

        await fs.promises.writeFile(filePath, JSON.stringify(searches, null, 2));

        // Rebuild full scheduling non-blocking to ensure families/jobs update
        try {
            const mod = await import('../run.js');
            setTimeout(() => { try {
              if (typeof mod.incrementalRebuildFromDisk === 'function') mod.incrementalRebuildFromDisk(interaction.client);
              else if (typeof mod.rebuildFromDisk === 'function') mod.rebuildFromDisk(interaction.client);
            } catch {} }, 0);
            const tag = name ? `name=\`${name}\`` : (key ? `key=\`${key}\`` : '');
            try { await interaction.editReply({ content: `✅ Search ${tag} deleted and schedule rebuild triggered.` }); } catch { try { await interaction.followUp({ content: `✅ Search ${tag} deleted and schedule rebuild triggered.`, ephemeral: true }); } catch {} }
            try { console.log('[cmd.result] /delete_search ok %s', tag); } catch {}
            try { console.log('[cmd.latency] /delete_search exec_ms=%d', Date.now() - t0); } catch {}
        } catch (e) {
            console.warn('[cmd] rebuild after delete failed:', e?.message || e);
            try { await interaction.editReply({ content: `✅ Search \`${name}\` deleted. (Rebuild failed, restart may be needed)` }); } catch { try { await interaction.followUp({ content: `✅ Search \`${name}\` deleted. (Rebuild failed, restart may be needed)`, ephemeral: true }); } catch {} }
        }

    } catch (error) {
        console.error('\nError deleting the search:', error);
        try {
            await interaction.followUp({ content: 'There was an error deleting the search.'});
        } catch {
            try { await interaction.editReply({ content: 'There was an error deleting the search.'}); } catch {}
        }
    }
}
