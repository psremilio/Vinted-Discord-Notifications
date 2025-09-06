import { SlashCommandBuilder } from 'discord.js';
import { getFamiliesSnapshot } from '../run.js';
import { canonicalizeUrl } from '../rules/urlNormalizer.js';

export const data = new SlashCommandBuilder()
  .setName('families')
  .setDescription('Listet aktuell gebildete Familien (Parent -> Kinder).')
  .addStringOption(o => o.setName('filter').setDescription('Optional: Textfilter auf Parent/Kinder-Namen').setRequired(false))
  .addBooleanOption(o => o.setName('verbose').setDescription('Mehr Details (Keys/URLs)').setRequired(false))
  .addIntegerOption(o => o.setName('limit').setDescription('Max. Familien (Default 10)').setRequired(false))
  .setDMPermission(false);

async function ack(interaction) {
  try {
    if (!interaction?.deferred && !interaction?.replied) {
      try { await interaction.deferReply({ ephemeral: true }); }
      catch { try { await interaction.reply({ content: '⏳', ephemeral: true }); } catch {} }
    }
  } catch {}
}

async function edit(interaction, contentOrOptions) {
  try {
    if (interaction.deferred || interaction.replied) return await interaction.editReply(contentOrOptions);
    return await interaction.reply(typeof contentOrOptions === 'string' ? { content: contentOrOptions, ephemeral: true } : { ...contentOrOptions, ephemeral: true });
  } catch (e) {
    try { return await interaction.followUp(typeof contentOrOptions === 'string' ? { content: contentOrOptions } : { ...contentOrOptions }); } catch {}
  }
}

export const execute = async (interaction) => {
  await ack(interaction);
  try {
    const filt = String(interaction.options.getString('filter') || '').toLowerCase();
    const limit = Number(interaction.options.getInteger('limit') || 10);
    const verbose = Boolean(interaction.options.getBoolean('verbose') || false);
    let fams = getFamiliesSnapshot();
    if (filt) {
      fams = fams.filter(f =>
        String(f.parent.name).toLowerCase().includes(filt) ||
        (f.children || []).some(c => String(c.name).toLowerCase().includes(filt))
      );
    }
    fams = fams.slice(0, Math.max(1, Math.min(50, limit)));
    if (!fams.length) {
      await edit(interaction, 'Keine Familien aktiv.');
      return;
    }
    const lines = [];
    for (const f of fams) {
      if (!verbose) {
        const childNames = (f.children || []).map(c => c.name).join(', ') || '—';
        lines.push(`• ${f.parent.name} → [${childNames}]`);
      } else {
        const childLines = (f.children || []).map(c => `   - ${c.name} :: ${canonicalizeUrl(c.url)}`);
        lines.push([`• ${f.parent.name}`, `   parentKey=${f.parentKey || ''}`, `   familyKey=${f.familyKey || ''}`, `   url=${canonicalizeUrl(f.parent.url)}`, ...childLines].join('\n'));
      }
    }
    const text = lines.join('\n');
    await edit(interaction, text.length > 1900 ? text.slice(0, 1900) + '\n…' : text);
  } catch (e) {
    console.error('[cmd.families] failed', e);
    await edit(interaction, 'Fehler beim Auflisten der Familien.');
  }
};
