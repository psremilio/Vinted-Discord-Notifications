import { SlashCommandBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { addSearch, removeJob, restartAll } from '../run.js';
import { channelsPath } from '../infra/paths.js';

// Use centralized resolver
function resolveChannelsPath() { return channelsPath(); }

async function ack(interaction){
  try {
    if (!interaction?.deferred && !interaction?.replied) {
      try { await interaction.deferReply({ flags: 1 << 6 }); }
      catch { try { await interaction.reply({ content: '…', flags: 1 << 6 }); } catch {} }
    }
  } catch {}
}

export const data = new SlashCommandBuilder()
  .setName('reschedule')
  .setDescription('Reschedule rules without recreating them')
  .addSubcommand(sc =>
    sc.setName('all')
      .setDescription('Rebuild and reschedule all rules from disk'))
  .addSubcommand(sc =>
    sc.setName('rule')
      .setDescription('Reschedule a single rule by name')
      .addStringOption(o => o.setName('name').setDescription('Rule name').setRequired(true))
  );

export const execute = async (interaction) => {
  await ack(interaction);
  const sub = interaction.options.getSubcommand();
  try {
    if (sub === 'all') {
      await restartAll(interaction.client);
      try { await interaction.editReply({ content: 'Rescheduled all rules from disk.' }); } catch {}
      return;
    }
    if (sub === 'rule') {
      const name = String(interaction.options.getString('name'));
      const filePath = resolveChannelsPath();
      let list = [];
      try { list = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch {}
      const found = (list || []).find(s => String(s.channelName) === name);
      if (!found) {
        try { await interaction.editReply({ content: `Rule "${name}" not found in ${filePath}` }); } catch {}
        return;
      }
      try { removeJob(name); } catch {}
      try { await addSearch(interaction.client, found); } catch {}
      try { await interaction.editReply({ content: `Rescheduled: ${name}` }); } catch {}
      return;
    }
  } catch (e) {
    try { await interaction.editReply({ content: `Reschedule failed: ${e?.message || e}` }); } catch {}
  }
};

