import fs from 'fs';
import dotenv from 'dotenv';
import { Client, GatewayIntentBits } from 'discord.js';

import { run } from "./src/run.js";
import { registerCommands, handleCommands } from "./src/commands.js";

const mySearches = JSON.parse(fs.readFileSync('./config/channels.json', 'utf8'));
dotenv.config();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

//launch the bot
client.on("ready", async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    registerCommands(client);
    run(client, mySearches);
});

//listen to buy button clicks
client.on('interactionCreate', async (interaction) => {
    if (interaction.isCommand()) {
        handleCommands(interaction, mySearches);
    } else {
        console.log('Unknown interaction type');
    }
});

//connect the bot to the server with retry on session limit
async function loginWithRetry() {
    while (true) {
        try {
            await client.login(process.env.BOT_TOKEN);
            break;
        } catch (err) {
            const match = err.message.match(/resets at (.*)$/);
            if (match) {
                const reset = new Date(match[1]);
                const wait = Math.max(reset.getTime() - Date.now(), 5000);
                console.error(`[login] session limit hit; retrying in ${Math.ceil(wait/1000)}s`);
                await new Promise(r => setTimeout(r, wait));
            } else {
                console.error('[login] unexpected error:', err);
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    }
}

loginWithRetry();
