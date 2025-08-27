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

        // Stop active polling job immediately if present (optional)
        let stopped = false;
        try {
            const mod = await import('../run.js');
            if (typeof mod.removeJob === 'function') {
                stopped = mod.removeJob(name);
            }
        } catch {}
        if (stopped) {
            await interaction.editReply({ content: `✅ Search \`${name}\` deleted and stopped immediately.` });
        } else {
            await interaction.editReply({ content: `✅ Search \`${name}\` deleted. It will stop after next restart (no running job found).` });
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
