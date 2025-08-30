import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { addAllowed, removeAllowed, listAllowed, resetAllowed, isAdmin } from '../utils/authz.js';

export const data = new SlashCommandBuilder()
  .setName('bot_roles')
  .setDescription('Verwalte Rollen, die Bot-Befehle verwenden dürfen (nur Admins).')
  .setDMPermission(false)
  .addSubcommand(sc => sc.setName('add').setDescription('Rolle erlauben').addRoleOption(o => o.setName('role').setDescription('Rolle').setRequired(true)))
  .addSubcommand(sc => sc.setName('remove').setDescription('Rolle entfernen').addRoleOption(o => o.setName('role').setDescription('Rolle').setRequired(true)))
  .addSubcommand(sc => sc.setName('list').setDescription('Erlaubte Rollen anzeigen'))
  .addSubcommand(sc => sc.setName('reset').setDescription('Alle erlaubten Rollen löschen'))
  // Setting default perms to Admin reduces visibility in some clients, but we still enforce in handler.
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export const execute = async (interaction) => {
  if (!interaction.deferred && !interaction.replied) {
    try { await interaction.deferReply({ ephemeral: true }); } catch {}
  }
  if (!isAdmin(interaction)) {
    try { await interaction.followUp({ content: 'Nur Admins dürfen diese Aktion ausführen.', ephemeral: true }); } catch {}
    return;
  }

  const sub = interaction.options.getSubcommand();
  try {
    if (sub === 'add') {
      const role = interaction.options.getRole('role');
      const after = addAllowed(role.id);
      await interaction.followUp({ content: `Rolle <@&${role.id}> hinzugefügt. Aktuell erlaubt: ${after.map(id => `<@&${id}>`).join(', ') || '—'}`, ephemeral: true });
    } else if (sub === 'remove') {
      const role = interaction.options.getRole('role');
      const after = removeAllowed(role.id);
      await interaction.followUp({ content: `Rolle <@&${role.id}> entfernt. Aktuell erlaubt: ${after.map(id => `<@&${id}>`).join(', ') || '—'}`, ephemeral: true });
    } else if (sub === 'list') {
      const list = listAllowed();
      await interaction.followUp({ content: `Erlaubte Rollen: ${list.map(id => `<@&${id}>`).join(', ') || '—'}`, ephemeral: true });
    } else if (sub === 'reset') {
      resetAllowed();
      await interaction.followUp({ content: 'Alle erlaubten Rollen wurden gelöscht. Nur Admins dürfen Befehle nutzen.', ephemeral: true });
    } else {
      await interaction.followUp({ content: 'Unbekannter Unterbefehl.', ephemeral: true });
    }
  } catch (e) {
    await interaction.followUp({ content: `Fehler: ${e?.message || e}`, ephemeral: true });
  }
};

