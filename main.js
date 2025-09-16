process.on('unhandledRejection',(reason)=>console.error('Rejection:',reason));
process.on('uncaughtException',(err)=>{
  try { console.error('Uncaught:', err?.stack || err?.message || err); } catch {}
});

import dotenv from 'dotenv';
import http from 'http';
import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import fs from 'fs';
import { channelsPath } from './src/infra/paths.js';
// channelsStore is optional; fall back to legacy loader if module missing
let channelsStore = null;
try {
  channelsStore = await import('./src/config/channelsStore.js');
  try { console.log('[config] channelsStore loaded'); } catch {}
} catch (e) {
  console.warn('[config] channelsStore missing, using legacy path logic (safe fallback)');
  channelsStore = {
    loadChannels: () => {
      try {
        const p = channelsPath();
        const raw = fs.readFileSync(p, 'utf-8');
        const arr = JSON.parse(raw);
        return { list: Array.isArray(arr) ? arr : [], path: p };
      } catch (e2) {
        console.warn('[config] fallback load failed:', e2?.message || e2);
        return { list: [], path: channelsPath() };
      }
    },
  };
}

import { registerCommands, handleCommands } from './src/commands.js';
import { run } from './src/run.js';
import { whitelistCurrentEgressIP } from './src/net/whitelist.js';
import { ensureProxyPool, scheduleProxyRefresh } from './src/infra/proxyPool.js';
import { initProxyPool, startHeartbeat, stopHeartbeat, healthyCount, coolingCount, badCount } from './src/net/proxyHealth.js';
import { state } from './src/state.js';
import { get as httpGet } from './src/net/http.js';
import { metrics, serializeMetrics } from './src/infra/metrics.js';
import { activeSearches, getFamiliesSnapshot } from './src/run.js';
import { EdfGate } from './src/schedule/edf.js';
import { startLoopLagMonitor, getLagP95 } from './src/infra/loopLag.js';
import { rateCtl } from './src/schedule/rateControl.js';
import { ensureWebhooksForChannel } from './src/infra/webhooksManager.js';
import { scheduleEnsureLoop } from './src/discord/webhookEnsure.js';
import { startLocalPoster } from './src/poster/localPoster.js';
import { buildChannelsStore } from './src/bootstrap/channels.js';
import { ChannelType } from 'discord.js';
import { ensureBucket as ensureSearchBucket } from './src/utils/limiter.js';

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

// Acceptance gates
try {
  console.log('[acceptance] post_age_ms_p95 < 15000');
  console.log('[acceptance] match_age_ms_p95 < 45000');
  console.log('[acceptance] http_429_rate_60s < 0.05');
  console.log('[acceptance] parent_child_drift_ms_p95 ≈ 0');
  console.log('[acceptance] no_token_skips_rate_60s ≈ 0');
} catch {}

// Warn if cross-rule dedupe is enabled (can break fanout across channels)
try {
  if (String(process.env.CROSS_RULE_DEDUP || '0') === '1' || String(process.env.DEDUPE_SCOPE || '').toLowerCase() === 'global') {
    console.warn('[warn] CROSS_RULE_DEDUP/DEDUP_SCOPE=global aktiviert — das kann Fanout in Unterkanälen unterdrücken. Empfohlen: DEDUPE_SCOPE=per_rule');
  }
  console.log('[cmd.reply.mode]=flags');
} catch {}

// Mini HTTP keepalive + health endpoint so process never idles out
const PORT = Number(process.env.PORT || 8080);
try {
  http
    .createServer(async (req, res) => {
      try {
        if (req.url === '/healthz') {
          const ok = isHealthy();
          let err60 = 0;
          try { err60 = rateCtl.errorRateSec(60); } catch {}
          const body = JSON.stringify({
            status: ok ? 'ok' : 'stall',
            watchers: state.watchers || 0,
            rules_active: activeSearches?.size || (state.watchers || 0) || 0,
            lastFetchAt: state.lastFetchAt?.toISOString?.() || null,
            lastPostAt: state.lastPostAt?.toISOString?.() || null,
            proxyHealthy: healthyCount?.() ?? null,
            last_60s_429_rate: err60,
            global_rpm_effective: metrics.global_rpm_effective.get?.() ?? null,
            event_loop_lag_ms_p95: getLagP95(),
            version: state.version,
          });
          res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' });
          res.end(body); return;
        }
        if (req.url === '/discordz') {
          const headers = { 'Content-Type': 'application/json' };
          const token = process.env.BOT_TOKEN || '';
          if (!token) {
            res.writeHead(500, headers);
            res.end(JSON.stringify({ ok: false, error: 'BOT_TOKEN missing' }));
            return;
          }
          try {
            const rest = new REST({ version: '10' }).setToken(token);
            const me = await rest.get(Routes.user('@me'));
            res.writeHead(200, headers);
            res.end(JSON.stringify({ ok: true, user_id: me?.id ?? null }));
          } catch (e) {
            res.writeHead(500, headers);
            res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }));
          }
          return;
        }
        if (req.url === '/metrics') {
          try {
            const h = healthyCount?.() ?? 0;
            metrics.proxy_healthy.set(h);
            try { metrics.rules_active.set(activeSearches?.size || (state.watchers || 0) || 0); } catch {}
            try {
              // update aggregate gauges so dashboards can be light
              metrics.http_429_rate_60s.set(rateCtl.errorRateSec(60));
              metrics.global_latency_p95_ms.set(rateCtl.latencyP95Sec(60));
              try {
                const fams = getFamiliesSnapshot();
                metrics.families_count?.set?.(Array.isArray(fams) ? fams.length : 0);
              } catch {}
            } catch {}
          } catch {}
          res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
          res.end(serializeMetrics()); return;
        }
        if (req.url === '/configz') {
          try {
            const p = channelsPath();
            let stat = null; try { stat = fs.statSync(p); } catch {}
            const count = Array.isArray(mySearches) ? mySearches.length : 0;
            const sample = (mySearches || []).slice(0, 5).map(s => ({ name: s.channelName, id: s.channelId }));
            const body = JSON.stringify({ path: p, count, mtime: stat?.mtime?.toISOString?.() || null, sample }, null, 2);
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(body); return;
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e?.message || String(e) })); return;
          }
        }
        if (req.url === '/families') {
          try {
            const list = getFamiliesSnapshot();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ count: list.length, families: list }, null, 2));
            return;
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e?.message || String(e) }));
            return;
          }
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

let mySearches = [];
try {
  const res = channelsStore.loadChannels();
  mySearches = Array.isArray(res?.list) ? res.list : [];
} catch (e) {
  console.warn('[config] channels.json not found or invalid, starting with 0 searches:', e?.message || e);
  mySearches = [];
}

// Pre-create per-host search buckets so the first scheduler tick never sees "no bucket"
try {
  const hosts = new Set();
  for (const rule of mySearches) {
    const url = (() => {
      try { return rule?.url || rule?.channel?.url || null; }
      catch { return null; }
    })();
    if (!url) continue;
    try {
      const h = new URL(url).host;
      if (h) hosts.add(h);
    } catch {}
  }
  if (hosts.size) {
    const defaults = {
      targetRpm: Number(process.env.SEARCH_TARGET_RPM || 300),
      minRpm: Number(process.env.SEARCH_MIN_RPM || 120),
      maxRpm: Number(process.env.SEARCH_MAX_RPM || 2000),
    };
    for (const host of hosts) {
      try { ensureSearchBucket(host, { ...defaults, warmup: true }); }
      catch {}
    }
    try { console.log(`[bootstrap] search buckets prewarmed hosts=${hosts.size}`); } catch {}
  }
} catch (err) {
  try { console.warn('[bootstrap] failed to prewarm search buckets:', err?.message || err); } catch {}
}

// Pre-ack all slash commands as early as possible to avoid 3s timeouts
client.on('interactionCreate', async (interaction) => {
  if (String(process.env.COMMANDS_DISABLE || '0') === '1') return;
  try {
    const isCmd = interaction.isChatInputCommand ? interaction.isChatInputCommand() : interaction.isCommand?.();
    if (!isCmd) return;
    const t0 = Date.now();
    // Ack ASAP: ephemeral defer; fallback to minimal ephemeral reply
    if (!interaction.deferred && !interaction.replied) {
      try { await interaction.deferReply({ ephemeral: true }); }
      catch (e1) { try { await interaction.reply({ content: '…', ephemeral: true }); } catch {}
      }
    }
    // Briefly pause scheduler after ack to favor command edits
    try { EdfGate.pause(Number(process.env.COMMANDS_PAUSE_MS || 1500)); } catch {}
    try {
      const dt = Date.now() - t0;
      const name = (()=>{ try { return String(interaction.commandName || '_'); } catch { return '_'; } })();
      metrics.interaction_defer_latency_ms?.set?.({ command: name }, dt);
    } catch {}
  } catch {}
});

async function startMonitorsOnce(where = 'unknown'){
  if (monitorsStarted) return;
  if (!clientReady) return;
  monitorsStarted = true;
  console.log(`[start] launching monitors/search… (from=${where}, healthy=${healthyCount?.() ?? 'n/a'})`);
  try {
    const WAIT = String(process.env.WAIT_HEALTHY_START || '1') === '1';
    if (WAIT) {
      const t0 = Date.now();
      const DEADLINE = Number(process.env.WAIT_HEALTHY_DEADLINE_SEC || 20) * 1000;
      while ((healthyCount?.() || 0) <= 0 && (Date.now() - t0) < DEADLINE) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
    run(client,mySearches);
  } catch (e) { console.error('[start] run failed', e); }
  try { startHeartbeat(); } catch {}
}

// Enable slash commands by default; can be disabled via COMMANDS_DISABLE=1
const COMMANDS_ENABLED = String(process.env.COMMANDS_DISABLE || '0') !== '1';

async function onClientReady() {
  if (clientReady) return; // guard double-fire between 'ready' and future 'clientReady'
  clientReady = true;
  console.log(`Logged in as ${client.user.tag}!`);
  try { state.watchers = Array.isArray(mySearches) ? mySearches.length : 0; } catch {}
  setTimeout(() => { sendStartupPing().catch(()=>{}); }, 1000);
  // Preflight: build channels store from configured IDs; filter invalid but do not crash unless STRICT_CHANNELS=1
  try {
    const STRICT = String(process.env.STRICT_CHANNELS || '0') === '1';
    const ids = Array.from(new Set((Array.isArray(mySearches) ? mySearches : []).map(x => String(x?.channelId || '')).filter(Boolean)));
    const { store, invalid } = await buildChannelsStore(client, ids, STRICT);
    globalThis.channelsStore = store; // Map<channelId, Array<{id,token}>>
    // Build name->id map for families routing
    try {
      const m = new Map();
      for (const it of (Array.isArray(mySearches) ? mySearches : [])) {
        if (it?.channelName && it?.channelId) m.set(String(it.channelName), String(it.channelId));
      }
      globalThis.ruleChannelIdMap = m;
      try { console.log('[families.map] rules=', m.size); } catch {}
    } catch {}
    const validSet = new Set(store.keys());
    // Filter searches to valid channels to avoid blind posts
    mySearches = (Array.isArray(mySearches) ? mySearches : []).filter(x => validSet.has(String(x?.channelId || '')));
    if (invalid?.length) {
      console.warn(`[preflight] filtered ${invalid.length} invalid channel(s); continuing with ${store.size}`);
    }
  } catch (e) {
    console.error('[preflight] failed — aborting startup:', e?.message || e);
    process.exit(1);
  }
  // Commands registration (Singleton)
  if (COMMANDS_ENABLED) {
    try { const res = await registerCommands(client); console.log('[commands.ready]', 'guilds=', (res?.guilds?.length||'global'), 'registered=', res?.registered || 0); } catch (e) { console.warn('[commands.init] failed:', e?.message || e); }
  } else {
    console.log('[commands.disabled]', 'disable=', process.env.COMMANDS_DISABLE || '0');
  }
  try {
    const GRACE = Math.max(0, Number(process.env.COMMANDS_BOOT_GRACE_MS || 3000));
    setTimeout(() => startMonitorsOnce('ready_grace'), GRACE);
  } catch { startMonitorsOnce('ready'); }
  // Start periodic webhook ensure loop (boot + interval with jitter) using valid channels only
  try {
    const ids = Array.from(globalThis.channelsStore?.keys?.() || []);
    scheduleEnsureLoop(ids);
  } catch {}

  // Start Redis Streams poster worker if enabled (dynamic import to avoid hard Redis dep)
  try {
    if (String(process.env.POST_VIA_STREAMS || '0') === '1') {
      const { startPosterWorker } = await import('./src/poster/worker.js');
      await startPosterWorker();
    }
  } catch (e) {
    console.warn('[streams.worker.init] failed:', e?.message || e);
  }

  // Start local spool poster if enabled
  try {
    if (String(process.env.POST_VIA_LOCAL_SPOOL || '0') === '1') {
      startLocalPoster();
      console.log('[localPoster] started');
    }
  } catch (e) {
    console.warn('[localPoster.init] failed:', e?.message || e);
  }
}
client.on('ready', onClientReady);
// Prepare for discord.js v15 rename (clientReady)
try { client.on('clientReady', onClientReady); } catch {}
// Always handle interactions when commands are enabled
client.on('interactionCreate',interaction=>{
  if (!COMMANDS_ENABLED) return;
  if (interaction.isChatInputCommand ? interaction.isChatInputCommand() : interaction.isCommand()) {
    handleCommands(interaction,mySearches);
  }
});

(async function boot(){
  // Kick off proxy setup in parallel to avoid long pre-login stalls
  try { await whitelistCurrentEgressIP(); } catch {}
  try {
    const list = await ensureProxyPool(console);
    const min = Math.max(0, Number(process.env.MIN_PROXIES_AT_BOOT || 5));
    if (Array.isArray(list)) {
      console.log(`[proxy.boot] pool ready: ${list.length} proxies`);
      if (min > 0 && list.length < min) {
        console.error(`[proxy.boot] insufficient proxies (${list.length} < ${min}) — check PROXY_LIST_URL(S) or provider; refusing DIRECT fallback`);
        process.exit(1);
      }
    }
  } catch (e) { console.error('[proxy.boot] failed:', e?.message || e); process.exit(1); }
  try { scheduleProxyRefresh(console); } catch {}
  const poolInit = initProxyPool().catch(err => {
    console.error('[proxy.init] failed:', err?.message || err);
    process.exit(1);
  });
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
  try { startLoopLagMonitor(1000); } catch {}
  startStallDetector();
})();

function isHealthy() {
  const now = Date.now();
  const lastOk = state.lastFetchSuccessAt ? state.lastFetchSuccessAt.getTime() : 0;
  const tooOld = lastOk && (now - lastOk > 10 * 60 * 1000);
  const tooManyErrors = (state.consecutiveErrors || 0) >= 10;
  return !(tooOld || tooManyErrors);
}

function startStallDetector() {
  const chId = process.env.DISCORD_PING_CHANNEL_ID;
  setInterval(async () => {
    const now = Date.now();
    const lastOk = state.lastFetchSuccessAt ? state.lastFetchSuccessAt.getTime() : 0;
    const tooOld = lastOk && (now - lastOk > 10 * 60 * 1000);
    const tooManyErrors = (state.consecutiveErrors || 0) >= 10;
    if (tooOld || tooManyErrors) {
      console.warn('[stall] detected — reloading searches from disk');
      try { const mod = await import('./src/run.js'); await mod.rebuildFromDisk?.(client); } catch {}
      if (chId) {
        try {
          const ch = await client.channels.fetch(chId).catch(()=>null) || client.channels.cache.get(chId);
          if (ch && typeof ch.send === 'function') {
            await ch.send({
              embeds: [{
                color: 0xf59e0b,
                title: 'Watcher neu gestartet (Stall-Detector)',
                description: tooOld ? 'No fetch success > 10min' : 'Consecutive errors >= 10',
                timestamp: new Date().toISOString(),
              }]
            });
          }
        } catch {}
      }
    }
  }, 60 * 1000);
}

// Commands heartbeat (leader only)
setInterval(() => {
  try { metrics.commands_heartbeat.set(Date.now()); } catch {}
}, 30 * 1000);

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

// (unused) old preflightTargets removed in favor of buildChannelsStore

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





