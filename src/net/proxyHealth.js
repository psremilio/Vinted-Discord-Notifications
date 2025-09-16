import axios from 'axios';
import { EventEmitter } from 'events';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { loadProxies } from './proxies.js';
import { ensureProxySession, withCsrf } from './tokens.js';

// Configuration with sensible defaults and backwards compatibility
const CAPACITY = Number(process.env.PROXY_CAPACITY || process.env.PROXY_HEALTHY_CAP || 800);
const CHECK_CONCURRENCY = Number(process.env.PROXY_CHECK_CONCURRENCY || process.env.PROXY_TEST_CONCURRENCY || 8);
const CHECK_TIMEOUT_SEC = Number(process.env.PROXY_CHECK_TIMEOUT_SEC || process.env.CHECK_TIMEOUT_SEC || 8);
const COOLDOWN_MIN = Number(process.env.PROXY_COOLDOWN_MIN || process.env.COOLDOWN_MIN || 30);
const FAIL_MAX = Number(process.env.PROXY_FAIL_MAX || 3);
const WARMUP_MIN = Number(process.env.PROXY_WARMUP_MIN || 40);
const REQUESTS_PER_PROXY_PER_MIN = Number(process.env.REQUESTS_PER_PROXY_PER_MIN || 8);
const SCORE_DECAY_SEC = Number(process.env.PROXY_SCORE_DECAY_SEC || 900);

function boolEnv(name, def = false) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return !!def;
  const s = String(raw).trim().toLowerCase();
  if ([ '1','true','yes','y','on' ].includes(s)) return true;
  if ([ '0','false','no','n','off' ].includes(s)) return false;
  return !!def;
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

// Data structures
// proxy -> { lastOkAt, okCount, score, bucketTokens, bucketRefillAt, cooldownUntil }
const healthyMap = new Map();
export const healthEvents = new EventEmitter();
export function healthyCount() { return healthyMap.size; }
const cooldown = new Map();   // proxy -> timestamp when usable again
const failCounts = new Map(); // proxy -> fails since last ok

let allProxies = [];
let scanOffset = 0;
let rrCursor = 0;

function classifyStatus(code) {
  const n = Number(code || 0);
  if (n >= 200 && n < 400) return 'ok';
  if (n === 429) return 'rate_limited';
  if (n === 401 || n === 403) return 'auth_blocked';
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
  const t = CHECK_TIMEOUT_SEC * 1000;
  const probeUrl = process.env.PROXY_PROBE_URL || 'https://api.ipify.org?format=json';
  const a = await axios.get(probeUrl, {
    proxy: false,
    httpAgent: agent,
    httpsAgent: agent,
    timeout: t,
    validateStatus: () => true,
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json, text/plain, */*',
    }
  });
  if (a?.status === 407) return { ok: false, status: 407, reason: 'auth_required' };
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
      httpAgent: agent,
      httpsAgent: agent,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
      },
    }));
    try { http.defaults.jar = jar; } catch {}
    return { http, jar, csrf: null };
  }
  const client = await createHealthClient(proxy);
  await ensureProxySession(client);
  const API = (base || (process.env.VINTED_BASE_URL || process.env.LOGIN_URL || 'https://www.vinted.de')).replace(/\/$/, '') + '/api/v2/catalog/items?search_text=nike&per_page=1';
  const b = await client.http.get(API, withCsrf({ timeout: t, validateStatus: () => true }, client));
  const code = Number(b?.status || 0);
  const cls = classifyStatus(code);
  return { ok: cls === 'ok', reason: `${cls}:${code}`, status: code };
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
      if (['reachable_blocked', 'auth_blocked', 'rate_limited'].includes(cls)) {
        addHealthy(proxy, { status: res.status });
        const st = healthyMap.get(proxy);
        if (st) {
          if (cls === 'rate_limited') {
            st.score = Math.max(-1, Math.min(st.score ?? 0, 0));
          } else {
            st.score = Math.min(st.score ?? 0, -2);
          }
          healthyMap.set(proxy, st);
        }
        if (cls === 'reachable_blocked') stats.reachable++;
        else if (cls === 'auth_blocked') stats.authBlocked++;
        else stats.rateLimited++;
      } else if (cls === 'blocked' || cls === 'auth_required') {
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

export function markBadInPool(p) {
  if (!p) return;
  const st = healthyMap.get(p);
  if (st) {
    st.score = Math.max(-10, (st.score || 0) - 2);
    healthyMap.set(p, st);
  }
  if (healthyMap.has(p)) healthyMap.delete(p);
  const f = (failCounts.get(p) || 0) + 1;
  failCounts.set(p, f);
  const baseMin = Math.max(5, COOLDOWN_MIN);
  const jitter = 5 + Math.floor(Math.random() * 10);
  const mins = f >= FAIL_MAX ? baseMin + jitter : Math.floor(baseMin / 2) + Math.floor(Math.random() * 5);
  const until = Date.now() + mins * 60 * 1000;
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
}

export function recordProxyOutcome(p, code) {
  const st = healthyMap.get(p) || {};
  const n = Number(code || 0);
  if (n === 429) {
    st.score = Math.max(-2, (st.score || 0) - 1);
    healthyMap.set(p, st);
    permanentlyBad.delete(p);
  } else if (n === 401 || n === 403) {
    st.score = Math.max(-5, (st.score || 0) - 1);
    healthyMap.set(p, st);
    permanentlyBad.delete(p);
  } else if (n >= 500) {
    st.score = Math.max(-10, (st.score || 0) - 1);
    healthyMap.set(p, st);
  }
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
