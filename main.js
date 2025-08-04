process.on('unhandledRejection',(reason)=>console.error('Rejection:',reason));

import dotenv from 'dotenv';
import { Client, GatewayIntentBits } from 'discord.js';
import fs from 'fs';

import { run } from './src/run.js';
import { registerCommands, handleCommands } from './src/commands.js';

dotenv.config();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const mySearches = JSON.parse(fs.readFileSync('./config/channels.json','utf-8'));

client.on('ready',async()=>{
  console.log(`Logged in as ${client.user.tag}`);
  registerCommands(client);
  run(client,mySearches);
});
client.on('interactionCreate',interaction=>{
  if(interaction.isCommand()) handleCommands(interaction,mySearches);
});

(async function loginWithRetry(){
  while(true){
    try {
      await client.login(process.env.BOT_TOKEN);
      break;
    } catch(err){
      const m = err.message.match(/resets at (.*)$/);
      const wait = m ? Math.max(new Date(m[1])-Date.now(),5000) : 5000;
      console.error(`[login] erneut in ${Math.ceil(wait/1000)}s`);
      await new Promise(r=>setTimeout(r,wait));
    }
  }
})();
