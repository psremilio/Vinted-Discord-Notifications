import { SlashCommandBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const filePath = path.resolve(__dirname, '../../config/channels.json');

export const data = new SlashCommandBuilder()
    .setName('delete_search')
    .setDescription('Start receiving notifications for this Vinted channel.')
    .addStringOption(option =>
        option.setName('name')
            .setDescription('The name of your new search.')
            .setRequired(true));

export const execute = async (interaction) => {
    const name = interaction.options.getString('name');

    try {
        //delete the search that has 'name' as name
        const searches = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        const searchIndex = searches.findIndex(search => search.channelName === name);
        if (searchIndex === -1) {
            await interaction.editReply({ content: 'No search found with the name ' + name });
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
            try { await interaction.editReply({ content: `✅ Search \`${name}\` deleted and schedule rebuild triggered.` }); } catch { try { await interaction.followUp({ content: `✅ Search \`${name}\` deleted and schedule rebuild triggered.`, ephemeral: true }); } catch {} }
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
