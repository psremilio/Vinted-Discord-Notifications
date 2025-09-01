import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { loadProxies } from './proxies.js';

// Configuration with sensible defaults and backwards compatibility
const CAPACITY = Number(process.env.PROXY_CAPACITY || process.env.PROXY_HEALTHY_CAP || 60);
const CHECK_CONCURRENCY = Number(process.env.PROXY_CHECK_CONCURRENCY || process.env.PROXY_TEST_CONCURRENCY || 8);
const CHECK_TIMEOUT_SEC = Number(process.env.PROXY_CHECK_TIMEOUT_SEC || 8);
const COOLDOWN_MIN = Number(process.env.PROXY_COOLDOWN_MIN || 30);
const FAIL_MAX = Number(process.env.PROXY_FAIL_MAX || 3);
const WARMUP_MIN = Number(process.env.PROXY_WARMUP_MIN || 40);

// Data structures
const healthyMap = new Map(); // proxy -> { lastOkAt, okCount, score }
const cooldown = new Map();   // proxy -> timestamp when usable again
const failCounts = new Map(); // proxy -> fails since last ok

let allProxies = [];
let scanOffset = 0;

function classifyStatus(code) {
  if ([200, 301, 302].includes(code)) return 'ok';
  if ([401, 403, 429].includes(code)) return 'rate_limited';
  if (code >= 500) return 'failed';
  return 'blocked';
}

// Utility: add healthy entry with hard capacity cap (LRU eviction)
function addHealthy(proxy, { status } = {}) {
  // Reset cooldown and failure score
  cooldown.delete(proxy);
  failCounts.set(proxy, 0);
  if (healthyMap.has(proxy)) healthyMap.delete(proxy); // move to end
  const prev = healthyMap.get(proxy);
  healthyMap.set(proxy, { lastOkAt: Date.now(), okCount: (prev?.okCount || 0) + 1, score: 0 });
  // Enforce capacity strictly
  while (healthyMap.size > CAPACITY) {
    const oldest = healthyMap.keys().next().value;
    healthyMap.delete(oldest);
  }
  if (status) console.log(`[proxy] Healthy proxy added: ${proxy} (status: ${status})`);
}

async function twoPhaseCheck(proxy, base) {
  const [host, portStr] = proxy.split(':');
  const port = Number(portStr);
  const agent = new HttpsProxyAgent(`http://${host}:${port}`);
  const t = CHECK_TIMEOUT_SEC * 1000;
  // Phase A: httpbin reachability
  const a = await axios.get('http://httpbin.org/ip', {
    proxy: false,
    httpAgent: agent,
    httpsAgent: agent,
    timeout: t,
    validateStatus: () => true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
      'Connection': 'keep-alive',
    }
  });
  if (a.status !== 200) return { ok: false, reason: `httpbin:${a.status}` };

  // Phase B: Vinted reachability (lightweight GET with Range)
  const b = await axios.get(base, {
    proxy: false,
    httpAgent: agent,
    httpsAgent: agent,
    timeout: t,
    maxRedirects: 0,
    validateStatus: () => true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
      'Connection': 'keep-alive',
      'Range': 'bytes=0-0',
    }
  });
  const cls = classifyStatus(b.status);
  return { ok: cls === 'ok', reason: `${cls}:${b.status}`, status: b.status };
}

async function testOne(proxy, base, stats) {
  stats.tested++;
  const coolUntil = cooldown.get(proxy) || 0;
  if (coolUntil > Date.now()) return; // still cooling down
  try {
    const res = await twoPhaseCheck(proxy, base);
    if (res.ok) {
      addHealthy(proxy, { status: res.status });
      stats.successful++;
    } else {
      const [cls] = String(res.reason || '').split(':');
      if (cls === 'rate_limited') {
        stats.rateLimited++;
        const f = (failCounts.get(proxy) || 0) + 1;
        failCounts.set(proxy, f);
        if (healthyMap.has(proxy)) healthyMap.delete(proxy);
        const baseMin = Math.max(5, COOLDOWN_MIN);
        const jitter = 5 + Math.floor(Math.random() * 10);
        const mins = f >= FAIL_MAX ? baseMin + jitter : Math.floor(baseMin / 2) + Math.floor(Math.random() * 5);
        cooldown.set(proxy, Date.now() + mins * 60 * 1000);
      } else if (cls === 'blocked') {
        stats.blocked++;
      } else {
        stats.failed++;
      }
    }
  } catch {
    stats.failed++;
  }
}

export async function initProxyPool() {
  healthyMap.clear();
  const file =
    process.env.PROXY_LIST_FILE ||
    (process.env.RAILWAY_ENVIRONMENT ? '/app/config/proxies.txt' : 'config/proxies.txt');
  try {
    allProxies = loadProxies(file);
    scanOffset = 0;
    console.log(`[proxy] Loaded ${allProxies.length} proxies from ${file}`);
  } catch (err) {
    console.warn('[proxy] proxy list not found:', err.message);
    allProxies = [];
    return;
  }
  const base = (process.env.VINTED_BASE_URL || process.env.LOGIN_URL || 'https://www.vinted.de/').replace(/\/$/, '/');
  console.log(`[proxy] Testing proxies against: ${base}`);

  const stats = { tested: 0, successful: 0, blocked: 0, failed: 0, rateLimited: 0 };
  const started = Date.now();
  const DEADLINE_MS = Number(process.env.PROXY_INIT_DEADLINE_MS || 30000);
  const FAST_MIN = Math.max(1, Number(process.env.PROXY_FAST_START_MIN || 20));
  const FAST_ENABLED = String(process.env.PROXY_FAST_START || '1') === '1';

  while (healthyMap.size < CAPACITY && scanOffset < allProxies.length) {
    const batch = allProxies.slice(scanOffset, scanOffset + 200);
    scanOffset += batch.length;
    for (let i = 0; i < batch.length && healthyMap.size < CAPACITY; i += CHECK_CONCURRENCY) {
      const slice = batch.slice(i, i + CHECK_CONCURRENCY);
      await Promise.allSettled(slice.map(p => testOne(p, base, stats)));
      if (FAST_ENABLED && healthyMap.size >= Math.min(FAST_MIN, CAPACITY)) {
        console.log(`[proxy] fast-start with ${healthyMap.size} healthy → continue filling in background`);
        setTimeout(() => { refillIfBelowCap().catch(() => {}); }, 0);
        console.log(`[proxy] Healthy proxies: ${healthyMap.size}/${CAPACITY}`);
        return;
      }
      if (Date.now() - started > DEADLINE_MS) {
        console.log(`[proxy] init deadline reached (${DEADLINE_MS}ms), continuing fill in background`);
        setTimeout(() => { refillIfBelowCap().catch(() => {}); }, 0);
        console.log(`[proxy] Healthy proxies: ${healthyMap.size}/${CAPACITY}`);
        return;
      }
    }
  }
  console.log(`[proxy] Proxy test results: ${stats.tested} tested, ${stats.successful} healthy, ${stats.blocked} blocked, ${stats.rateLimited} rate limited (401/403/429), ${stats.failed} failed`);
  console.log(`[proxy] Healthy proxies: ${healthyMap.size}/${CAPACITY}`);
}

async function refillIfBelowCap() {
  if (healthyMap.size >= CAPACITY) return;
  const file =
    process.env.PROXY_LIST_FILE ||
    (process.env.RAILWAY_ENVIRONMENT ? '/app/config/proxies.txt' : 'config/proxies.txt');
  if (!allProxies.length) {
    try {
      allProxies = loadProxies(file);
      scanOffset = 0;
    } catch {
      return;
    }
  }
  const base = (process.env.VINTED_BASE_URL || process.env.LOGIN_URL || 'https://www.vinted.de/').replace(/\/$/, '/');
  const start = healthyMap.size;
  while (healthyMap.size < CAPACITY && scanOffset < allProxies.length) {
    const batch = allProxies.slice(scanOffset, scanOffset + 200);
    scanOffset += batch.length;
    for (let i = 0; i < batch.length && healthyMap.size < CAPACITY; i += CHECK_CONCURRENCY) {
      const slice = batch.slice(i, i + CHECK_CONCURRENCY);
      await Promise.allSettled(slice.map(p => testOne(p, base, { tested: 0, successful: 0, blocked: 0, failed: 0, rateLimited: 0 })));
    }
  }
  const delta = healthyMap.size - start;
  if (delta > 0) {
    console.log(`[proxy] Top-up added ${delta} → now ${healthyMap.size}/${CAPACITY}`);
  }
}

export function startAutoTopUp() {
  const mins = Number(process.env.PROXY_TOPUP_MIN || 0);
  if (!mins) return;
  setInterval(() => { refillIfBelowCap().catch(() => {}); }, mins * 60 * 1000);
}

export function getProxy() {
  const now = Date.now();
  const candidates = [];
  for (const [p] of healthyMap.entries()) {
    if ((cooldown.get(p) ?? 0) <= now) candidates.push(p);
  }
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

export function markBadInPool(p) {
  if (!p) return;
  if (healthyMap.has(p)) healthyMap.delete(p);
  const f = (failCounts.get(p) || 0) + 1;
  failCounts.set(p, f);
  const baseMin = Math.max(5, COOLDOWN_MIN);
  const jitter = 5 + Math.floor(Math.random() * 10);
  const mins = f >= FAIL_MAX ? baseMin + jitter : Math.floor(baseMin / 2) + Math.floor(Math.random() * 5);
  cooldown.set(p, Date.now() + mins * 60 * 1000);
}

// Heartbeat for observability
let hbTimer = null;
export function startHeartbeat() {
  if (hbTimer) return;
  const every = Number(process.env.HEARTBEAT_SEC || 30) * 1000;
  hbTimer = setInterval(() => {
    const healthy = healthyMap.size;
    const cooling = [...cooldown.values()].filter(ts => ts > Date.now()).length;
    const bad = [...failCounts.values()].filter(v => v > 0).length;
    console.log(`[hb] alive | healthy=${healthy} | cooling=${cooling} | bad=${bad}`);
  }, every);
}

export function stopHeartbeat() {
  if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
}

