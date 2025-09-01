process.on('unhandledRejection',(reason)=>console.error('Rejection:',reason));

import dotenv from 'dotenv';
import { Client, GatewayIntentBits } from 'discord.js';
import fs from 'fs';

import { registerCommands, handleCommands } from './src/commands.js';
import { run } from './src/run.js';
import { whitelistCurrentEgressIP } from './src/net/whitelist.js';
import { ensureProxyList, startProxyRefreshLoop } from './src/net/ensureProxyList.js';
import { initProxyPool } from './src/net/proxyHealth.js';

dotenv.config();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const mySearches = JSON.parse(fs.readFileSync('./config/channels.json','utf-8'));

client.on('ready',async()=>{
  console.log(`Logged in as ${client.user.tag}!`);
  registerCommands(client);
  run(client,mySearches);
});
client.on('interactionCreate',interaction=>{
  if (interaction.isChatInputCommand ? interaction.isChatInputCommand() : interaction.isCommand()) {
    handleCommands(interaction,mySearches);
  }
});

(async function boot(){
  // Kick off proxy setup in parallel to avoid long pre-login stalls
  try { await whitelistCurrentEgressIP(); } catch {}
  try { await ensureProxyList(); } catch {}
  startProxyRefreshLoop();
  const poolInit = initProxyPool().catch(()=>{});

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
  // Best-effort: wait briefly for pool to have some entries, but don't block forever
  try { await Promise.race([poolInit, new Promise(r=>setTimeout(r, 5000))]); } catch {}
})();
