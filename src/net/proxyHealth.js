import axios from 'axios';
import { EventEmitter } from 'events';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { loadProxies } from './proxies.js';
import { ensureProxySession, withCsrf } from './tokens.js';

// Configuration with sensible defaults and backwards compatibility
const CAPACITY = Number(process.env.PROXY_CAPACITY || process.env.PROXY_HEALTHY_CAP || 800);
const CHECK_CONCURRENCY = Number(process.env.PROXY_CHECK_CONCURRENCY || process.env.PROXY_TEST_CONCURRENCY || 8);
const CHECK_TIMEOUT_BASE_SEC = Number(process.env.PROXY_CHECK_TIMEOUT_SEC || process.env.CHECK_TIMEOUT_SEC || 8);
const PROXY_TEST_TIMEOUT_MS = Math.max(0, Number(process.env.PROXY_TEST_TIMEOUT_MS || 0));
const CHECK_TIMEOUT_MS = PROXY_TEST_TIMEOUT_MS > 0 ? Math.max(1000, PROXY_TEST_TIMEOUT_MS) : Math.max(1000, (Number.isFinite(CHECK_TIMEOUT_BASE_SEC) ? CHECK_TIMEOUT_BASE_SEC : 8) * 1000);
const PROXY_TEST_RETRIES = Math.max(0, Number(process.env.PROXY_TEST_RETRIES || 0));
const PROXY_TEST_BACKOFF_MS = Math.max(100, Number(process.env.PROXY_TEST_BACKOFF_MS || 1000));
const PROXY_TEST_BACKOFF_MAX_MS = Math.max(PROXY_TEST_BACKOFF_MS, Number(process.env.PROXY_TEST_BACKOFF_MAX_MS || 10000));
const COOLDOWN_MIN = Number(process.env.PROXY_COOLDOWN_MIN || process.env.COOLDOWN_MIN || 30);
const FAIL_MAX = Number(process.env.PROXY_FAIL_MAX || 3);
const WARMUP_MIN = Number(process.env.PROXY_WARMUP_MIN || 40);
const REQUESTS_PER_PROXY_PER_MIN = Number(process.env.REQUESTS_PER_PROXY_PER_MIN || 8);
const SCORE_DECAY_SEC = Number(process.env.PROXY_SCORE_DECAY_SEC || 900);
const FAIL_RATE_WINDOW_MS = Math.max(30_000, Number(process.env.PROXY_FAIL_WINDOW_MS || 60_000));
const FAIL403_RATE_THR = Math.min(1, Math.max(0, Number(process.env.PROXY_FAIL403_RATE_THR || 0.2)));
const FAILTLS_RATE_THR = Math.min(1, Math.max(0, Number(process.env.PROXY_FAILTLS_RATE_THR || 0.1)));

function boolEnv(name, def = false) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return !!def;
  const s = String(raw).trim().toLowerCase();
  if ([ '1','true','yes','y','on' ].includes(s)) return true;
  if ([ '0','false','no','n','off' ].includes(s)) return false;
  return !!def;
}

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0",
];
function pickUserAgent() {
  if (!USER_AGENTS.length) return "Mozilla/5.0";
  const idx = Math.floor(Math.random() * USER_AGENTS.length);
  return USER_AGENTS[idx] || USER_AGENTS[0];
}

class MinuteBucket {
  constructor(rpm = 1) {
    this.setRate(rpm);
    this.tokens = this.rate;
    this._last = Date.now();
  }
  setRate(rpm = 1) {
    const next = Math.max(1, Number(rpm || 1));
    this.rate = next;
    this.tokens = Math.min(this.tokens ?? next, next);
  }
  _refill(now = Date.now()) {
    const dt = Math.max(0, now - this._last);
    if (!dt) return;
    this._last = now;
    const perMs = this.rate / 60_000;
    this.tokens = Math.min(this.rate, this.tokens + perMs * dt);
  }
  take(n = 1) {
    if (n <= 0) return true;
    this._refill();
    if (this.tokens >= n) { this.tokens -= n; return true; }
    return false;
  }
  giveBack(n = 1) {
    if (n <= 0) return;
    this.tokens = Math.min(this.rate, this.tokens + n);
  }
}

const EXPLORE_RPM = Math.max(1, Number(process.env.EXPLORE_RPM || 60));
const exploreBucket = new MinuteBucket(EXPLORE_RPM);

const PERMA_FAILS = Math.max(1, Number(process.env.PROXY_PERMA_FAILS || (FAIL_MAX * 3)));
const permanentlyBad = new Set();

const requestWindow = new Map(); // proxy -> timestamps (last window)
const fail403Window = new Map(); // proxy -> timestamps (last window)
const failTlsWindow = new Map(); // proxy -> timestamps (last window)

function pruneWindow(arr, now = Date.now()) {
  const cutoff = now - FAIL_RATE_WINDOW_MS;
  while (arr.length && arr[0] < cutoff) arr.shift();
}

function pushWindow(map, proxy, now = Date.now()) {
  if (!proxy) return;
  let arr = map.get(proxy);
  if (!arr) {
    arr = [];
    map.set(proxy, arr);
  }
  arr.push(now);
  pruneWindow(arr, now);
}

function countWindow(map, proxy, now = Date.now()) {
  const arr = map.get(proxy);
  if (!arr) return 0;
  pruneWindow(arr, now);
  return arr.length;
}

function rateFor(map, proxy) {
  const now = Date.now();
  const total = countWindow(requestWindow, proxy, now);
  if (!total) return 0;
  return countWindow(map, proxy, now) / total;
}

function updateSlidingRates(proxy) {
  const st = healthyMap.get(proxy);
  if (!st) return;
  st.fail403Rate = rateFor(fail403Window, proxy);
  st.failTlsRate = rateFor(failTlsWindow, proxy);
  st.sampleCount60 = countWindow(requestWindow, proxy);
  healthyMap.set(proxy, st);
}

// Data structures
// proxy -> { lastOkAt, okCount, score, bucketTokens, bucketRefillAt, cooldownUntil }
const healthyMap = new Map();
export const healthEvents = new EventEmitter();
export function healthyCount() { return healthyMap.size; }
export function shouldSafeMode() {
  const min = Math.max(0, Number(process.env.SAFE_MODE_MIN_HEALTHY || process.env.MIN_HEALTHY || 10));
  try { return healthyMap.size < min; } catch { return true; }
}
const cooldown = new Map();   // proxy -> timestamp when usable again
const failCounts = new Map(); // proxy -> fails since last ok

let allProxies = [];
let scanOffset = 0;
let rrCursor = 0;

function classifyStatus(code) {
  const n = Number(code || 0);
  if (n >= 200 && n < 400) return 'ok';
  if (n === 429) return 'rate_limited';
  if (n === 401 || n === 403 || n === 407) return 'auth_blocked';
  if (n >= 400 && n < 500) return 'blocked';
  if (n >= 500 || n === 0) return 'failed';
  return 'blocked';
}

// Utility: add healthy entry with hard capacity cap (LRU eviction)
function _refillTokens(state) {
  const now = Date.now();
  if (!state.bucketRefillAt || now >= state.bucketRefillAt + 60_000) {
    state.bucketTokens = REQUESTS_PER_PROXY_PER_MIN;
    state.bucketRefillAt = now;
  }
}

function tryAcquireToken(proxy) {
  const st = healthyMap.get(proxy);
  if (!st) return false;
  _refillTokens(st);
  if (st.bucketTokens > 0) { st.bucketTokens -= 1; return true; }
  return false;
}

function addHealthy(proxy, { status } = {}) {
  // Reset cooldown and failure score
  cooldown.delete(proxy);
  failCounts.set(proxy, 0);
  const prev = healthyMap.get(proxy);
  const next = prev || { score: 0, bucketTokens: REQUESTS_PER_PROXY_PER_MIN, bucketRefillAt: 0, cooldownUntil: 0, okCount: 0, lastOkAt: 0 };
  next.lastOkAt = Date.now();
  next.okCount = (next.okCount || 0) + 1;
  // move to end for LRU effect
  if (healthyMap.has(proxy)) healthyMap.delete(proxy);
  healthyMap.set(proxy, next);
  // Enforce capacity strictly
  while (healthyMap.size > CAPACITY) {
    const oldest = healthyMap.keys().next().value;
    healthyMap.delete(oldest);
  }
  permanentlyBad.delete(proxy);
  if (status) console.log(`[proxy] Healthy proxy added: ${proxy} (status: ${status})`);
  try { healthEvents.emit('count', healthyMap.size); } catch {}
  try { healthEvents.emit('add', proxy); } catch {}
}

async function twoPhaseCheck(proxy, base) {
  // Phase A: HTTPS reachability probe with proxy agent
  let url = String(proxy || '').trim();
  if (url && !/^[a-z]+:\/\//i.test(url)) url = `http://${url}`;
  const agent = new HttpsProxyAgent(url);
  const userAgent = pickUserAgent();
  const t = CHECK_TIMEOUT_MS;
  const probeUrl = process.env.PROXY_PROBE_URL || 'https://api.ipify.org?format=json';
  const a = await axios.get(probeUrl, {
    proxy: false,
    httpAgent: agent,
    httpsAgent: agent,
    timeout: t,
    validateStatus: () => true,
    headers: {
      'User-Agent': userAgent,
      'Accept': 'application/json, text/plain, */*',
    }
  });
  if (a?.status === 407) return { ok: false, status: 407, reason: 'auth_blocked:407' };
  if (a?.status !== 200) return { ok: false, reason: `probe:${a?.status || 0}` };
  // Phase B: real API probe with session + CSRF
  // lightweight per-check client to avoid circular deps
  async function createHealthClient(pxy) {
    let s = String(pxy || '').trim();
    if (s && !/^https?:\/\//i.test(s)) s = `http://${s}`;
    const agent = new HttpsProxyAgent(s);
    // lazy import to avoid ESM issues if not installed; tokens.js requires axios-cookiejar-support usage within http.js
    const { CookieJar } = await import('tough-cookie');
    const { wrapper } = await import('axios-cookiejar-support');
    const jar = new CookieJar();
    const http = wrapper(axios.create({
      withCredentials: true,
      proxy: false,
      headers: {
        'User-Agent': userAgent,
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
      },
    }));
    try { http.defaults.jar = jar; } catch {}
    return { http, jar, csrf: null, agent };
  }
  const client = await createHealthClient(proxy);
  await ensureProxySession(client);
  const API = (base || (process.env.VINTED_BASE_URL || process.env.LOGIN_URL || 'https://www.vinted.de')).replace(/\/$/, '') + '/api/v2/catalog/items?search_text=nike&per_page=1';
  const b = await client.http.get(API, withCsrf({ timeout: t, validateStatus: () => true }, client));
  const code = Number(b?.status || 0);
  const cls = classifyStatus(code);
  return { ok: cls === 'ok', reason: `${cls}:${code}`, status: code, headers: b?.headers || {} };
}

async function probeWithRetry(proxy, base) {
  let lastErr;
  const attempts = Math.max(0, PROXY_TEST_RETRIES);
  for (let attempt = 0; attempt <= attempts; attempt++) {
    try {
      return await twoPhaseCheck(proxy, base);
    } catch (err) {
      lastErr = err;
      if (attempt === attempts) break;
      const backoff = Math.min(PROXY_TEST_BACKOFF_MAX_MS, PROXY_TEST_BACKOFF_MS * Math.pow(2, attempt));
      const jitter = Math.floor(Math.random() * 250);
      await new Promise(resolve => setTimeout(resolve, backoff + jitter));
    }
  }
  throw lastErr || new Error('proxy_test_failed');
}

async function testOne(proxy, base, stats) {
  stats.tested++;
  const coolUntil = cooldown.get(proxy) || 0;
  if (coolUntil > Date.now()) return; // still cooling down
  try {
    const res = await probeWithRetry(proxy, base);
    if (res.ok) {
      addHealthy(proxy, { status: res.status });
      stats.successful++;
    } else {
      const [cls] = String(res.reason || '').split(':');
      if (cls === 'rate_limited') {
        addHealthy(proxy, { status: res.status });
        const st = healthyMap.get(proxy);
        if (st) {
          st.score = Math.max(-1, Math.min(st.score ?? 0, 0));
          healthyMap.set(proxy, st);
        }
        const headers = res && res.headers ? res.headers : {};
        const retryAfterRaw = headers['retry-after'] ?? headers['Retry-After'];
        const retryAfter = Number(retryAfterRaw);
        const fallbackMs = Math.max(30_000, Number(process.env.PROXY_429_BACKOFF_MS || 60_000));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : fallbackMs;
        quarantineProxy(proxy, waitMs);
        stats.rateLimited++;
      } else if (cls === 'reachable_blocked') {
        addHealthy(proxy, { status: res.status });
        const st = healthyMap.get(proxy);
        if (st) {
          st.score = Math.min(st.score ?? 0, -2);
          healthyMap.set(proxy, st);
        }
        stats.reachable++;
      } else if (cls === 'auth_blocked') {
        const authTtl = Math.max(60_000, Number(process.env.PROXY_AUTH_TTL_MS || 12 * 60 * 60 * 1000));
        markBadInPool(proxy, { ttlMs: authTtl, reason: 'auth_blocked' });
        stats.authBlocked++;
      } else if (cls === 'blocked') {
        stats.blocked++;
      } else {
        const f = (failCounts.get(proxy) || 0) + 1;
        failCounts.set(proxy, f);
        if (healthyMap.has(proxy)) healthyMap.delete(proxy);
        const baseMin = Math.max(5, COOLDOWN_MIN);
        const jitter = 5 + Math.floor(Math.random() * 10);
        const mins = f >= FAIL_MAX ? baseMin + jitter : Math.floor(baseMin / 2) + Math.floor(Math.random() * 5);
        cooldown.set(proxy, Date.now() + mins * 60 * 1000);
        stats.failed++;
      }
    }
  } catch (err) {
    stats.failed++;
    if (String(process.env.LOG_LEVEL || '').toLowerCase() === 'debug') {
      console.warn(`[proxy.test] error ${proxy}: ${err?.message || err}`);
    }
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

  const stats = { tested: 0, successful: 0, blocked: 0, failed: 0, reachable: 0, authBlocked: 0, rateLimited: 0 };
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
        console.log(`[proxy] fast-start with ${healthyMap.size} healthy â†’ continue filling in background`);
        setTimeout(() => { refillIfBelowCap().catch(() => {}); }, 0);
        console.log(`[proxy] Healthy proxies: ${healthyMap.size}/${CAPACITY}`);
        try { healthEvents.emit('count', healthyMap.size); } catch {}
        return;
      }
      if (Date.now() - started > DEADLINE_MS) {
        console.log(`[proxy] init deadline reached (${DEADLINE_MS}ms), continuing fill in background`);
        setTimeout(() => { refillIfBelowCap().catch(() => {}); }, 0);
        console.log(`[proxy] Healthy proxies: ${healthyMap.size}/${CAPACITY}`);
        try { healthEvents.emit('count', healthyMap.size); } catch {}
        return;
      }
    }
  }
  console.log(`[proxy] Proxy test results: ${stats.tested} tested, ${stats.successful} healthy, ${stats.reachable} reachable_blocked, ${stats.authBlocked} auth_blocked, ${stats.rateLimited} rate_limited, ${stats.blocked} blocked, ${stats.failed} failed`);
  console.log(`[proxy] Healthy proxies: ${healthyMap.size}/${CAPACITY}`);
  try { healthEvents.emit('count', healthyMap.size); } catch {}

  const minAtBoot = Math.max(0, Number(process.env.MIN_PROXIES_AT_BOOT || 10));
  const allowDirect = boolEnv('PROXY_ALLOW_DIRECT_WHEN_EMPTY', false) || boolEnv('ALLOW_DIRECT_ON_EMPTY', false) || boolEnv('ALLOW_DIRECT', false);
  if (minAtBoot > 0 && healthyMap.size < minAtBoot && !allowDirect) {
    const msg = `[proxy] insufficient proxies at boot: healthy=${healthyMap.size} < ${minAtBoot}`;
    console.error(msg);
    throw new Error(msg);
  }
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
    console.log(`[proxy] Top-up added ${delta} â†’ now ${healthyMap.size}/${CAPACITY}`);
    try { healthEvents.emit('count', healthyMap.size); } catch {}
  }
}

export function startAutoTopUp() {
  const mins = Number(process.env.PROXY_TOPUP_MIN || 0);
  if (!mins) return;
  setInterval(() => { refillIfBelowCap().catch(() => {}); }, mins * 60 * 1000);
}

function pickExplorationCandidate() {
  if (!allProxies.length) return null;
  const now = Date.now();
  const primary = [];
  const fallback = [];
  for (const proxy of allProxies) {
    if (!proxy) continue;
    if (permanentlyBad.has(proxy)) continue;
    const cool = cooldown.get(proxy) || 0;
    if (cool > now) continue;
    if (healthyMap.has(proxy)) {
      fallback.push(proxy);
      continue;
    }
    primary.push(proxy);
  }
  const pool = primary.length ? primary : fallback;
  if (!pool.length) return null;
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx];
}

export function hasHealthy() {
  return healthyMap.size > 0;
}

export function releaseExploreToken() {
  exploreBucket.giveBack(1);
}

export function pickExploratory() {
  const candidate = pickExplorationCandidate();
  if (!candidate) return null;
  if (!exploreBucket.take(1)) return null;
  return { proxy: candidate, mode: 'trial', budgetToken: true };
}

export function getProxy(options = {}) {
  const { allowExploratory = true, preferExploratory = false } = options || {};
  const now = Date.now();

  if (!preferExploratory) {
    const weighted = [];
    for (const [p, st] of healthyMap.entries()) {
      const cool = st.cooldownUntil || (cooldown.get(p) || 0);
      if (cool > now) continue;
      const fail403 = (st.fail403Rate ?? rateFor(fail403Window, p)) > FAIL403_RATE_THR;
      const failTls = (st.failTlsRate ?? rateFor(failTlsWindow, p)) > FAILTLS_RATE_THR;
      if (fail403 || failTls) continue;
      _refillTokens(st);
      if (st.bucketTokens <= 0) continue;
      const w = Math.max(1, Math.min(20, (st.score ?? 0) + 10));
      weighted.push([p, w]);
    }
    if (weighted.length) {
      const size = weighted.length;
      for (let i = 0; i < size; i++) {
        const [candidate] = weighted[(rrCursor + i) % size];
        if (tryAcquireToken(candidate)) {
          rrCursor = (rrCursor + i + 1) % size;
          return { proxy: candidate, mode: 'healthy', budgetToken: false };
        }
      }
      for (const [p] of weighted) {
        if (tryAcquireToken(p)) return { proxy: p, mode: 'healthy', budgetToken: false };
      }
    }
  }
  if (!allowExploratory) return null;
  const exploratory = pickExploratory();
  if (exploratory) return exploratory;
  return null;
}

export function markBadInPool(p, opts = {}) {
  if (!p) return;
  const st = healthyMap.get(p);
  if (st) {
    st.score = Math.max(-10, (st.score || 0) - 2);
    healthyMap.set(p, st);
  }
  if (healthyMap.has(p)) healthyMap.delete(p);
  const f = (failCounts.get(p) || 0) + 1;
  failCounts.set(p, f);
  const ttlMs = Number(opts?.ttlMs ?? 0);
  let until = 0;
  if (Number.isFinite(ttlMs) && ttlMs > 0) {
    until = Date.now() + ttlMs;
  } else {
    const baseMin = Math.max(5, COOLDOWN_MIN);
    const jitter = 5 + Math.floor(Math.random() * 10);
    const mins = f >= FAIL_MAX ? baseMin + jitter : Math.floor(baseMin / 2) + Math.floor(Math.random() * 5);
    until = Date.now() + mins * 60 * 1000;
  }
  cooldown.set(p, until);
  if (st) { st.cooldownUntil = until; healthyMap.set(p, st); }
  if (f >= PERMA_FAILS) permanentlyBad.add(p);
  try { healthEvents.emit('cooldown', p); } catch {}
}

// Quarantine a proxy for a specific window (ms) without increasing fail counts aggressively.
export function quarantineProxy(p, windowMs = 15 * 60 * 1000) {
  if (!p) return;
  const st = healthyMap.get(p) || {};
  const until = Date.now() + Math.max(60_000, Number(windowMs || 0));
  cooldown.set(p, until);
  st.cooldownUntil = until;
  st.score = Math.max(-5, (st.score || 0) - 1);
  healthyMap.set(p, st);
  try { healthEvents.emit('cooldown', p); } catch {}
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

// Score decay towards 0
let decayTimer = null;
function startScoreDecay() {
  if (decayTimer) return;
  if (!SCORE_DECAY_SEC) return;
  decayTimer = setInterval(() => {
    for (const [p, st] of healthyMap.entries()) {
      if (!st) continue;
      if (!st.score) continue;
      st.score += st.score > 0 ? -1 : 1;
      healthyMap.set(p, st);
    }
  }, SCORE_DECAY_SEC * 1000);
}
startScoreDecay();

export function recordProxySuccess(p) {
  const st = healthyMap.get(p);
  if (!st) return;
  st.score = Math.min(10, (st.score || 0) + 1);
  st.lastOkAt = Date.now();
  healthyMap.set(p, st);
  permanentlyBad.delete(p);
  pushWindow(requestWindow, p);
  updateSlidingRates(p);
}

export function recordProxyOutcome(p, code) {
  const st = healthyMap.get(p) || {};
  const n = Number(code || 0);
  pushWindow(requestWindow, p);
  if (n === 429) {
    st.score = Math.max(-2, (st.score || 0) - 1);
    healthyMap.set(p, st);
    permanentlyBad.delete(p);
  } else if (n === 401 || n === 403 || n === 407) {
    st.score = Math.max(-5, (st.score || 0) - 1);
    healthyMap.set(p, st);
    permanentlyBad.delete(p);
    pushWindow(fail403Window, p);
  } else if (n >= 500) {
    st.score = Math.max(-10, (st.score || 0) - 1);
    healthyMap.set(p, st);
  }
  updateSlidingRates(p);
}

export function recordProxyTlsFailure(p) {
  if (!p) return;
  pushWindow(requestWindow, p);
  pushWindow(failTlsWindow, p);
  updateSlidingRates(p);
}

export function coolingCount() {
  const now = Date.now();
  let c = 0;
  for (const ts of cooldown.values()) if (ts > now) c++;
  return c;
}

export function badCount() {
  let c = 0;
  for (const v of failCounts.values()) if ((v || 0) > 0) c++;
  return c;
}

export function listHealthyProxies() {
  return Array.from(healthyMap.keys());
}

export function getProxyScores() {
  const out = {};
  for (const [p, st] of healthyMap.entries()) out[p] = st?.score || 0;
  return out;
}

