import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { REST, Routes } from 'discord.js';
import { isAuthorized, isAdmin } from './utils/authz.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const commands = [];
const commandFiles = fs.readdirSync(path.join(__dirname, 'commands')).filter(file => file.endsWith('.js'));

//load command modules
const loadCommands = async () => {
    for (const file of commandFiles) {
        const module = await import(`./commands/${file}`);
        commands.push(module.data.toJSON());
    }
}

//register commands with Discord to (refreshes them if necessary)
export const registerCommands = async (client) => {
    await loadCommands();

    const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
    const guildIds = (process.env.COMMAND_GUILD_IDS || process.env.COMMAND_GUILD_ID || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    try {
        if (guildIds.length > 0) {
            console.log(`[cmd.sync] registering ${commands.length} command(s) for guild(s): ${guildIds.join(', ')}`);
            for (const gid of guildIds) {
                await rest.put(
                    Routes.applicationGuildCommands(client.user.id, gid),
                    { body: commands }
                );
            }
            console.log('[cmd.sync] guild scope ok');
            // Always clear global commands when guild-scoped is configured
            try {
                console.log('[cmd.sync] clearing global commands (guild IDs present)…');
                await rest.put(
                    Routes.applicationCommands(client.user.id),
                    { body: [] }
                );
                console.log('[cmd.sync] cleared global commands');
            } catch (e) {
                console.warn('[cmd.sync] failed to clear global commands:', e.message || e);
            }
        } else {
            console.log('[cmd.sync] registering global (/) commands (may take up to 1h)…');
            await rest.put(
                Routes.applicationCommands(client.user.id),
                { body: commands }
            );
            console.log('[cmd.sync] global scope ok');
        }
    } catch (error) {
        console.error('[cmd.sync] error reloading commands:', error);
    }
}

//handle command interactions
export const handleCommands = async (interaction, mySearches) => {
    console.log(`[cmd.interaction] ${interaction.commandName}`);
    try {
        // Ack ASAP before any heavy work
        if (!interaction.deferred && !interaction.replied) {
            try { await interaction.deferReply({ ephemeral: true }); } catch (e) {
                try { await interaction.reply({ content: '⏳ …', ephemeral: true }); } catch {}
            }
        }
        const name = interaction.commandName;

        // Authorization: Admins always allowed. Others must be in allowlist.
        if (name !== 'bot_roles') {
            if (!isAuthorized(interaction)) {
                try { await interaction.followUp({ content: 'Du darfst diesen Befehl nicht verwenden (Rollen-Whitelist).', ephemeral: true }); } catch {}
                return;
            }
        } else {
            // bot_roles itself is admin-only
            if (!isAdmin(interaction)) {
                try { await interaction.followUp({ content: 'Nur Admins dürfen diesen Befehl verwenden.', ephemeral: true }); } catch {}
                return;
            }
        }
        let module;
        const attempts = [
          `./commands/${name}.js`,
          `./commands/${name.replace(/_/g, '-')}.js`,
          `./commands/${name.replace(/-/g, '_')}.js`,
        ];
        for (const p of attempts) {
          try {
            module = await import(p);
            if (module) break;
          } catch {}
        }
        if (!module) {
            const msg = `Befehl "${name}" ist (noch) nicht verfügbar.`;
            try {
                await interaction.followUp({ content: msg, ephemeral: true });
            } catch {
                try { await interaction.reply({ content: msg, ephemeral: true }); } catch {}
            }
            return;
        }
        if (!module || typeof module.execute !== 'function') {
            const msg = `Befehl "${name}" ist (noch) nicht verfügbar.`;
            try { await interaction.followUp({ content: msg, ephemeral: true }); } catch {}
            return;
        }
        // Execute command; ensure any long work runs after ack
        setTimeout(() => { module.execute(interaction, mySearches).catch(err => console.error('\nError handling command (async):', err)); }, 0);
    } catch (error) {
        console.error('\nError handling command:', error);
        try {
            await interaction.followUp({ content: 'There was an error while executing this command!', ephemeral: true });
        } catch {
            try { await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true }); } catch {}
        }
    }
}
