process.on('unhandledRejection',(reason)=>console.error('Rejection:',reason));
process.on('uncaughtException',(err)=>{
  try { console.error('Uncaught:', err?.stack || err?.message || err); } catch {}
});

import dotenv from 'dotenv';
import http from 'http';
import { Client, GatewayIntentBits } from 'discord.js';
import fs from 'fs';

import { registerCommands, handleCommands } from './src/commands.js';
import { run } from './src/run.js';
import { whitelistCurrentEgressIP } from './src/net/whitelist.js';
import { ensureProxyList, startProxyRefreshLoop } from './src/net/ensureProxyList.js';
import { initProxyPool, startHeartbeat, stopHeartbeat, healthyCount, coolingCount, badCount } from './src/net/proxyHealth.js';
import { state } from './src/state.js';
import { get as httpGet } from './src/net/http.js';

dotenv.config();

// Boot marker: verify correct entry file is running
try { console.log('[BOOT] entry', import.meta.url, 'ts=', new Date().toISOString()); } catch {}

// Quick env readiness log (without secrets)
function logEnvReadiness() {
  try {
    const hasToken = !!process.env.BOT_TOKEN;
    const proxyViaUrl = !!process.env.PROXY_LIST_URL;
    const proxyViaFile = !!process.env.PROXY_LIST_FILE;
    const proxyViaPS = !!(process.env.PS_API_KEY && process.env.SERVICE_ID);
    const proxyMode = proxyViaUrl ? 'URL' : proxyViaFile ? 'FILE' : proxyViaPS ? 'PS_API' : 'NONE';
    console.log(`[env] BOT_TOKEN=${hasToken ? 'set' : 'missing'} | proxies=${proxyMode}`);
  } catch {}
}
logEnvReadiness();

// Mini HTTP keepalive + health endpoint so process never idles out
const PORT = Number(process.env.PORT || 8080);
try {
  http
    .createServer(async (req, res) => {
      try {
        if (req.url === '/healthz') {
          const ok = isHealthy();
          const body = JSON.stringify({
            status: ok ? 'ok' : 'stall',
            watchers: state.watchers || 0,
            lastFetchAt: state.lastFetchAt?.toISOString?.() || null,
            lastPostAt: state.lastPostAt?.toISOString?.() || null,
            proxyHealthy: healthyCount?.() ?? null,
            version: state.version,
          });
          res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' });
          res.end(body); return;
        }
        if (req.url === '/metrics') {
          const lines = [];
          const h = healthyCount?.() ?? 0;
          lines.push(`# HELP proxy_pool_healthy Number of healthy proxies`);
          lines.push(`# TYPE proxy_pool_healthy gauge`);
          lines.push(`proxy_pool_healthy ${h}`);
          // We proxy stats via logs each minute; expose last-minute totals via env-less counters
          // Not perfect Prometheus semantics, but provides quick visibility
          res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
          res.end(lines.join('\n')); return;
        }
      } catch {}
      res.writeHead(204); res.end();
    })
    .listen(PORT, () => console.log(`[svc] listening on ${PORT}`));
} catch (e) {
  console.warn('[svc] http server failed:', e?.message || e);
}

process.on('beforeExit', (code) => console.warn('[proc] beforeExit', code));

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
let clientReady = false;
let monitorsStarted = false;
const mySearches = JSON.parse(fs.readFileSync('./config/channels.json','utf-8'));

function startMonitorsOnce(where = 'unknown'){
  if (monitorsStarted) return;
  if (!clientReady) return;
  monitorsStarted = true;
  console.log(`[start] launching monitors/search… (from=${where}, healthy=${healthyCount?.() ?? 'n/a'})`);
  try { registerCommands(client); } catch {}
  try { run(client,mySearches); } catch (e) { console.error('[start] run failed', e); }
  try { startHeartbeat(); } catch {}
}

client.on('ready',async()=>{
  clientReady = true;
  console.log(`Logged in as ${client.user.tag}!`);
  try { state.watchers = Array.isArray(mySearches) ? mySearches.length : 0; } catch {}
  setTimeout(() => { sendStartupPing().catch(()=>{}); }, 1000);
  startMonitorsOnce('ready');
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
  const DEADLINE_SEC = Number(process.env.STARTUP_DEADLINE_SEC || 60);
  const t0 = Date.now();

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
  // Nuclear: start monitors immediately (without warmup gate) and add watchdog
  setImmediate(() => startMonitorsOnce('immediate'));
  setTimeout(() => {
    if (!monitorsStarted) {
      console.warn('[start] watchdog fired → forcing start');
      startMonitorsOnce('watchdog');
    }
  }, DEADLINE_SEC * 1000);
})();

function isHealthy() {
  const now = Date.now();
  const lastOk = state.lastFetchSuccessAt ? state.lastFetchSuccessAt.getTime() : 0;
  const tooOld = lastOk && (now - lastOk > 10 * 60 * 1000);
  const tooManyErrors = (state.consecutiveErrors || 0) >= 10;
  return !(tooOld || tooManyErrors);
}

async function sendStartupPing() {
  const chId = process.env.DISCORD_PING_CHANNEL_ID;
  if (!chId) return;
  try {
    const ch = await client.channels.fetch(chId).catch(()=>null) || client.channels.cache.get(chId);
    if (!ch || typeof ch.send !== 'function') return;
    // quick probe
    let code = null, ms = null;
    try {
      const t0 = Date.now();
      const r = await httpGet(process.env.VINTED_BASE_URL || 'https://www.vinted.de/', { validateStatus: () => true });
      ms = Date.now() - t0;
      code = r?.status || null;
      state.lastProbe = { code, ms };
    } catch {}
    const healthy = healthyCount?.() ?? 0;
    const watchers = state.watchers || 0;
    const embed = {
      color: 0x22c55e,
      title: 'Vinted Bot gestartet ✅',
      description: `Commit ${state.commit} • Version ${state.version}`,
      fields: [
        { name: 'Watcher', value: String(watchers), inline: true },
        { name: 'Proxies', value: `${healthy}`, inline: true },
        { name: 'Probe', value: code ? `${code} • ${ms}ms` : '—', inline: true },
      ],
      timestamp: new Date().toISOString(),
    };
    await ch.send({ embeds: [embed] });
  } catch (e) {
    console.warn('[ping] failed:', e?.message || e);
  }
}

// Graceful shutdown
function shutdown(signal){
  console.log(`[shutdown] received ${signal}, cleaning up…`);
  try { stopHeartbeat(); } catch {}
  try { client.destroy(); } catch {}
  try { import('./src/run.js').then(m=>m.stopAll && m.stopAll()); } catch {}
  setTimeout(()=>process.exit(0), 25000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
