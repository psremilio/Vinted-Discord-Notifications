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
    // Register commands strictly for this guild for instant visibility
    const guildIds = ['1387184320883458129'];
    let registered = 0;
    try {
        if (guildIds.length > 0) {
            console.log(`[cmd.sync] registering ${commands.length} command(s) for guild(s): ${guildIds.join(', ')}`);
            for (const gid of guildIds) {
                await rest.put(
                    Routes.applicationGuildCommands(client.user.id, gid),
                    { body: commands }
                );
                registered += commands.length;
                console.log(`[cmd.register] guild=${gid} count=${commands.length}`);
            }
            console.log('[cmd.sync] guild scope ok');
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
            registered = commands.length;
            console.log('[cmd.sync] global scope ok');
        }
        try { console.log('[commands.ready]', 'guilds=', guildIds.length || 'global', 'registered=', registered, 'names=', commands.map(c=>c.name).join(',')); } catch {}
    } catch (error) {
        console.error('[cmd.sync] error reloading commands:', error);
    }
    return { guilds: guildIds, registered };
}

//handle command interactions
export const handleCommands = async (interaction, mySearches) => {
    try { console.log('[cmd.interaction]', 'name=', interaction.commandName, 'user=', interaction.user?.id, 'guild=', interaction.guildId); } catch {}
    try {
        // Ack ASAP before any heavy work (flags-based)
        if (!interaction.deferred && !interaction.replied) {
            try { await interaction.deferReply({ flags: 1 << 6 }); }
            catch (e1) { try { await interaction.reply({ content: '⏳ …', flags: 1 << 6 }); } catch {} }
        }
        const name = interaction.commandName;

        // Authorization: Admins always allowed. Others must be in allowlist.
        if (name !== 'bot_roles') {
            if (!isAuthorized(interaction)) {
            try { await interaction.followUp({ content: 'Du darfst diesen Befehl nicht verwenden (Rollen-Whitelist).', flags: 1 << 6 }); } catch {}
            return;
        }
        } else {
            // bot_roles itself is admin-only
            if (!isAdmin(interaction)) {
            try { await interaction.followUp({ content: 'Nur Admins dürfen diesen Befehl verwenden.', flags: 1 << 6 }); } catch {}
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
                await interaction.followUp({ content: msg, flags: 1 << 6 });
            } catch {
                try { await interaction.reply({ content: msg, flags: 1 << 6 }); } catch {}
            }
            return;
        }
        if (!module || typeof module.execute !== 'function') {
            const msg = `Befehl "${name}" ist (noch) nicht verfügbar.`;
            try { await interaction.followUp({ content: msg, flags: 1 << 6 }); } catch {}
            return;
        }
        // Execute command; ensure any long work runs after ack
        setTimeout(() => {
          try { console.log('[cmd.enqueued]', 'name=', name); } catch {}
          module.execute(interaction, mySearches).catch(err => console.error('\nError handling command (async):', err));
        }, 0);
    } catch (error) {
        console.error('\nError handling command:', error);
        try {
            await interaction.followUp({ content: 'There was an error while executing this command!', flags: 1 << 6 });
        } catch {
            try { await interaction.reply({ content: 'There was an error while executing this command!', flags: 1 << 6 }); } catch {}
        }
    }
}
