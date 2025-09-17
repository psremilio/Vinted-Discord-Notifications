import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { CookieJar } from 'tough-cookie';
import { wrapper as cookieJarWrapper } from 'axios-cookiejar-support';
import { ensureProxySession, withCsrf, retryOnceOn401_403 } from './tokens.js';
import { updateFetchSuccessRate } from './fetchStats.js';
import { getProxy, hasHealthy, releaseExploreToken, markBadInPool, quarantineProxy, recordProxySuccess, recordProxyOutcome, recordProxyTlsFailure } from './proxyHealth.js';
import { stickyMap } from '../schedule/stickyMap.js';
import { getBuckets, dropBuckets } from '../schedule/proxyBuckets.js';
import { rateCtl } from '../schedule/rateControl.js';
import { metrics } from '../infra/metrics.js';
import { ensureBucket as ensureSearchBucket, giveBackBucket } from '../utils/limiter.js';

const clientsByProxy = new Map();
const BASE = process.env.VINTED_BASE_URL || process.env.LOGIN_URL || 'https://www.vinted.de';

function envFlag(name, def = false) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return !!def;
  const s = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return !!def;
}

function directFallbackEnabled() {
  const keys = ['ALLOW_DIRECT', 'ALLOW_DIRECT_ON_EMPTY', 'PROXY_ALLOW_DIRECT_WHEN_EMPTY'];
  return keys.some((key) => envFlag(key, false));
}
let directFallbackNotified = false;

// Sliding-window trackers (60s) to drive gentle hedging adjustments and vinted 429 gauge
const softFails = [];
const totalReqs = [];
const err429s = [];
const err403s = [];
const vinted429s = [];
const vintedReqs = [];
function _gcWindow(arr) {
  const cutoff = Date.now() - 60_000;
  while (arr.length && arr[0] < cutoff) arr.shift();
}
function recordOutcome({ ok = false, softfail = false, status = null } = {}) {
  const now = Date.now();
  totalReqs.push(now); _gcWindow(totalReqs);
  if (softfail) { softFails.push(now); _gcWindow(softFails); }
  if (status === 429) { err429s.push(now); _gcWindow(err429s); }
  if (status === 403) { err403s.push(now); _gcWindow(err403s); }
  try {
    const total = totalReqs.length || 1;
    const rate429 = Math.min(1, Math.max(0, err429s.length / total));
    const rate403 = Math.min(1, Math.max(0, err403s.length / total));
    metrics.http_429_rate_60s?.set(Math.round(rate429 * 100));
    metrics.fetch_403_rate_60s?.set(Math.round(rate403 * 100));
    const success = Math.min(1, Math.max(0, 1 - (softFails.length / total)));
    updateFetchSuccessRate(success);
    metrics.fetch_success_rate_60s?.set?.(Math.round(success * 100));
  } catch {}
}
function getSoftfailRate60s() {
  _gcWindow(totalReqs); _gcWindow(softFails);
  const t = totalReqs.length || 1;
  return Math.min(1, Math.max(0, softFails.length / t));
}
function recordVinted429Sample({ is429 = false } = {}) {
  const now = Date.now();
  vintedReqs.push(now); _gcWindow(vintedReqs);
  if (is429) { vinted429s.push(now); _gcWindow(vinted429s); }
  try {
    const t = vintedReqs.length || 1;
    const rate = Math.min(1, Math.max(0, vinted429s.length / t));
    metrics.vinted_http_429_rate_60s?.set(Math.round(rate * 100));
    metrics.vinted_req_60s_count?.set(vintedReqs.length);
  } catch {}
}
function getHedgeBudget() {
  const baseN = Math.max(1, Number(process.env.HEDGE_REQUESTS || 2));
  const maxN = Math.max(baseN, Number(process.env.HEDGE_REQUESTS_MAX || 2));
  const disableThrRaw = process.env.HEDGE_DISABLE_RATE ?? process.env.HEDGE_DISABLE_THR;
  const limitThrRaw = process.env.HEDGE_LIMIT_RATE ?? process.env.HEDGE_CUT_THR;
  const disableThr = Math.min(1, Math.max(0, Number(disableThrRaw ?? 0.5)));
  const limitThr = Math.min(disableThr, Math.max(0, Number(limitThrRaw ?? 0.1)));
  const rate = getSoftfailRate60s();
  if (rate >= disableThr) return 1;
  if (rate >= limitThr) return Math.min(2, maxN);
  return Math.min(maxN, baseN);
}

const proxy429BackoffMs = new Map();
function resetProxy429Backoff(proxy) {
  if (!proxy) return;
  proxy429BackoffMs.delete(proxy);
}
function nextProxy429Backoff(proxy) {
  const base = Math.max(15_000, Number(process.env.PROXY_429_BACKOFF_MS || 60_000));
  const max = Math.max(base, Number(process.env.PROXY_429_BACKOFF_MAX_MS || 300_000));
  const current = proxy429BackoffMs.get(proxy) ?? base;
  const jitter = Math.floor(Math.random() * 500);
  const wait = Math.min(current, max) + jitter;
  const next = Math.min(Math.max(current, base) * 2, max);
  proxy429BackoffMs.set(proxy, next);
  return wait;
}
function scheduleProxy429Cooldown(proxy, headers) {
  if (!proxy) return;
  const header = headers?.['retry-after'] ?? headers?.['Retry-After'];
  const retryAfter = Number(header);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    const wait = Math.max(1000, retryAfter * 1000);
    quarantineProxy(proxy, wait);
    const prev = proxy429BackoffMs.get(proxy) ?? wait;
    proxy429BackoffMs.set(proxy, Math.max(wait, prev));
    return;
  }
  const wait = nextProxy429Backoff(proxy);
  quarantineProxy(proxy, wait);
}

export function createClient(proxyStr) {
  const key = String(proxyStr || '').trim();
  const existing = clientsByProxy.get(key);
  if (existing) return existing;

  // Treat DIRECT/invalid proxies as direct client (no proxy agent)
  const parts = key.split(':');
  const port = Number(parts[1]);
  const isDirect = !key || key.toUpperCase() === 'DIRECT' || parts.length < 2 || !Number.isFinite(port);
  if (isDirect) {
    const jar = new CookieJar();
    const http = cookieJarWrapper(axios.create({
      withCredentials: true,
      maxRedirects: 5,
      timeout: Number(process.env.FETCH_TIMEOUT_MS || 6000),
      proxy: false,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    }));
    try { http.defaults.jar = jar; } catch {}
    const client = { http, warmedAt: Date.now(), proxyAgent: null, proxyLabel: 'DIRECT', jar, csrf: null };
    clientsByProxy.set('DIRECT', client);
    return client;
  }

  let proxyAgent;
  // Support full URL with optional auth, scheme, and host
  if (/^https?:\/\//i.test(key)) {
    proxyAgent = new HttpsProxyAgent(key);
  } else {
    const [host] = parts;
    proxyAgent = new HttpsProxyAgent({
      protocol: 'http:',
      host,
      port,
      keepAlive: true,
      maxSockets: Number(process.env.HTTP_MAX_SOCKETS || 64),
      maxFreeSockets: Number(process.env.HTTP_MAX_FREE_SOCKETS || 32),
    });
  }

  const jar = new CookieJar();
  const baseHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (String(process.env.HEADERS_CH_UA ?? '1') !== '0') {
    baseHeaders['sec-ch-ua'] = '"Chromium";v="126", "Not.A/Brand";v="24", "Google Chrome";v="126"';
    baseHeaders['sec-ch-ua-mobile'] = '?0';
    baseHeaders['sec-ch-ua-platform'] = '"Windows"';
  }
  const http = cookieJarWrapper(axios.create({
    withCredentials: true,
    maxRedirects: 5,
    timeout: Number(process.env.FETCH_TIMEOUT_MS || 6000),
    proxy: false, // Disable axios proxy handling
    httpAgent: proxyAgent,
    httpsAgent: proxyAgent, // Use our custom agent
    headers: baseHeaders,
  }));
  try { http.defaults.jar = jar; } catch {}

  const client = { http, warmedAt: 0, proxyAgent, proxyLabel: key, jar, csrf: null };
  clientsByProxy.set(key, client);
  return client;
}

// Legacy bootstrap logic removed – ensureProxySession handles warmup per client now.

export async function getHttp(base) {
  // Per-request: attempt to grab a proxy from the pool
  const MAX_TRIES = Math.max(1, Number(process.env.PROXY_MAX_RETRIES || 2));
  for (let i = 0; i < MAX_TRIES; i++) {
    const pick = getProxy();
    const proxyInfo = pick && pick.proxy ? pick : null;
    if (!proxyInfo) {
      await new Promise(r => setTimeout(r, 150 + i * 100));
      continue;
    }
    const { proxy: p, mode, budgetToken } = proxyInfo;
    const client = createClient(p);
    try {
      await ensureProxySession(client);
      return { http: client.http, proxy: p, client, route: mode || 'healthy', explorationBudget: !!budgetToken };
    } catch {
      if (budgetToken) releaseExploreToken();
    }
  }

  // Optional direct fallback when no proxies are immediately available.
  // Enabled only when ALLOW_DIRECT(us) flags explicitly permit it.
  const DIRECT_OK =
    envFlag('ALLOW_DIRECT', false) ||
    envFlag('ALLOW_DIRECT_ON_EMPTY', false) ||
    envFlag('PROXY_ALLOW_DIRECT_WHEN_EMPTY', false);
  if (DIRECT_OK) {
    const client = createClient('DIRECT');
    try { await ensureProxySession(client); } catch {}
    return { http: client.http, proxy: 'DIRECT', client };
  }
  console.warn('[proxy] No healthy proxies available; consider checking PROXY_* vars or set ALLOW_DIRECT=1 for debugging.');
  throw new Error('No healthy proxies available');
}

// Hedged GET: fire up to HEDGE_REQUESTS with small delay and return the first useful response
export async function hedgedGet(url, config = {}, base = BASE) {
  const HEDGE_N = Math.max(1, getHedgeBudget());
  const HEDGE_DELAY = Math.max(0, Number(process.env.HEDGE_DELAY_MS || 200));
  const RETRY_DELAY = Math.max(0, Number(process.env.RETRY_DELAY_MS || 500));

  const attempts = [];
  const controllers = [];
  let resolved = false;

  const host = (() => {
    try { return new URL(url).host; }
    catch { return null; }
  })();

  let hostTokenTaken = false;
  if (host) {
    try {
      const bucket = ensureSearchBucket(host, {
        targetRpm: Number(process.env.SEARCH_TARGET_RPM || 300),
        minRpm: Number(process.env.SEARCH_MIN_RPM || 120),
        maxRpm: Number(process.env.SEARCH_MAX_RPM || 2000),
      });
      hostTokenTaken = bucket?.take?.(1) ?? false;
    } catch {
      hostTokenTaken = false;
    }
    if (!hostTokenTaken) {
      try { metrics.fetch_skipped_total?.inc(); } catch {}
      const err = new Error('hedge-no-host-budget');
      err.skipped = true;
      throw err;
    }
  }

  function runAttempt(delayMs) {
    return new Promise((resolve) => {
      setTimeout(async () => {
        if (resolved) return resolve(null);
        let proxy = null;
        let controller = null;
        const started = Date.now();
        try {
          const ctx = await getHttp(base);
          if (!ctx) return resolve(null);
          proxy = ctx.proxy;
          const client = ctx.client;
          controller = new AbortController();
          controllers.push(controller);
          const axiosCfg = withCsrf({
            ...config,
            signal: controller.signal,
            timeout: Number(process.env.FETCH_TIMEOUT_MS || 8000),
            validateStatus: () => true,
          }, client);
          const res = await retryOnceOn401_403(
            () => client.http.get(url, axiosCfg),
            client
          );
          const code = Number(res?.status || 0);
          const latency = Date.now() - started;
          const ok = code >= 200 && code < 300;
          if (ok) {
            recordProxySuccess(proxy);
            resetProxy429Backoff(proxy);
            try { rateCtl.observe(proxy, { ok: true, latency, code }); } catch {}
            try { recordOutcome({ ok: true, status: code }); } catch {}
            if (!resolved) {
              resolved = true;
              for (const c of controllers) {
                if (c !== controller) { try { c.abort(); } catch {} }
              }
              return resolve({ res, proxy });
            }
          } else {
            recordProxyOutcome(proxy, code);
            try { rateCtl.observe(proxy, { ok: false, code, latency }); } catch {}
            try { recordOutcome({ softfail: true, status: code }); } catch {}
            if (code === 429) {
              scheduleProxy429Cooldown(proxy, res?.headers);
              if (RETRY_DELAY) await new Promise(r => setTimeout(r, RETRY_DELAY));
            } else if (code === 403 && RETRY_DELAY) {
              await new Promise(r => setTimeout(r, RETRY_DELAY));
            }
          }
        } catch (err) {
          const status = Number(err?.response?.status || 0);
          if (proxy) {
            recordProxyOutcome(proxy, status);
            if (status === 429) scheduleProxy429Cooldown(proxy, err?.response?.headers);
          }
          try { recordOutcome({ softfail: true, status }); } catch {}
          try {
            if (proxy) rateCtl.observe(proxy, { fail: true });
            else rateCtl.observe('UNKNOWN', { fail: true });
          } catch {}
        }
        resolve(null);
      }, delayMs);
    });
  }

  for (let i = 0; i < HEDGE_N; i++) {
    attempts.push(runAttempt(i === 0 ? 0 : i * HEDGE_DELAY));
  }

  const results = await Promise.all(attempts);
  const winner = results.find(x => x && x.res);
  if (winner) return winner.res;

  try {
    const ALLOW = String(process.env.ALLOW_DIRECT_ON_HEDGE_FAIL || process.env.ALLOW_DIRECT || '0') === '1';
    if (ALLOW) {
      const res = await axios.get(url, { ...config, proxy: false, timeout: Number(process.env.FETCH_TIMEOUT_MS || 8000), validateStatus: () => true });
      const code = Number(res?.status || 0);
      if (code >= 200 && code < 300) {
        try { recordOutcome({ ok: true, status: code }); } catch {}
        return res;
      }
    }
  } catch {}
  throw new Error('Hedged requests failed');
}


export function rotateProxy(badProxy) {
  if (badProxy && clientsByProxy.has(badProxy)) {
    const client = clientsByProxy.get(badProxy);
    if (client.proxyAgent) {
      client.proxyAgent.destroy();
    }
    clientsByProxy.delete(badProxy);
  }
  if (badProxy) markBadInPool(badProxy);
}

export async function initProxyPool() {
  return (await import('./proxyHealth.js')).initProxyPool();
}

// Convenience helper for simple GET requests that handles session bootstrap
export async function get(url, config = {}) {
  const { http, proxy, client } = await getHttp();
  try {
    await ensureProxySession(client);
    const res = await client.http.get(url, withCsrf(config, client));
    const dateHeader = res?.headers?.['date'];
    if (dateHeader) res._serverNow = new Date(dateHeader);
    return res;
  } catch (e) {
    if (e.response && e.response.status === 401) {
      markBadInPool(proxy);
    }
    throw e;
  }
}

// Low-level fetch via a specific proxy, with latency measurement and EWMA tracking
const ewmaByProxy = new Map(); // proxy -> { value, alpha }
const latSamplesByProxy = new Map(); // proxy -> number[]
export async function doFetchWithProxy(proxy, url, config = {}, timeout = Number(process.env.FETCH_TIMEOUT_MS || 6000)) {
  const client = createClient(proxy);
  await ensureProxySession(client);
  const t0 = Date.now();
  let res;
  try {
    res = await retryOnceOn401_403(
      () => client.http.get(url, withCsrf({ ...config, timeout, validateStatus: () => true }, client)),
      client
    );
  } catch (e) {
    // timeout or network error
    const err = e;
    const latency = Date.now() - t0;
    try { metrics.fetch_timeout_total?.inc({ proxy }); } catch {}
    throw Object.assign(new Error('timeout'), { latency, cause: err });
  }
  const latency = Date.now() - t0;
  const dateHeader = res?.headers?.['date'];
  if (dateHeader) res._serverNow = new Date(dateHeader);
  // EWMA
  try {
    const s = ewmaByProxy.get(proxy) || { value: latency, alpha: Number(process.env.EWMA_ALPHA || 0.2) };
    s.value = s.alpha * latency + (1 - s.alpha) * (s.value || latency);
    ewmaByProxy.set(proxy, s);
    if (metrics?.proxy_latency_ewma_ms) metrics.proxy_latency_ewma_ms.set({ proxy }, Math.round(s.value));
    let arr = latSamplesByProxy.get(proxy);
    if (!arr) { arr = []; latSamplesByProxy.set(proxy, arr); }
    arr.push(latency);
    if (arr.length > 300) arr.shift();
    const a = arr.slice().sort((x,y)=>x-y);
    const p95 = a[Math.min(a.length - 1, Math.floor(a.length * 0.95))];
    metrics.proxy_fetch_ms_p95?.set({ proxy }, p95);
  } catch {}
  return { res, latency };
}

// Sticky-per-proxy fetch with AIMD and token buckets
const timeoutsByProxy = new Map(); // proxy -> [ts,...]
function recordTimeout(proxy) {
  try {
    const arr = timeoutsByProxy.get(proxy) || [];
    const now = Date.now();
    arr.push(now);
    // keep last 60s
    const cutoff = now - 60_000;
    while (arr.length && arr[0] < cutoff) arr.shift();
    timeoutsByProxy.set(proxy, arr);
    if (arr.length >= Number(process.env.PROXY_FAIL_MAX || 3)) {
      markBadInPool(proxy);
    }
  } catch {}
}

async function fetchDirectFallback(ruleId, url, opts = {}) {
  if (!directFallbackEnabled()) return { skipped: true };
  if (!directFallbackNotified) {
    directFallbackNotified = true;
    try { console.warn('[fetch] no healthy proxies available; falling back to direct HTTP'); } catch {}
  }
  const timeout = Number(process.env.FETCH_TIMEOUT_MS || 6000);
  try {
    const { res, latency } = await doFetchWithProxy('DIRECT', url, opts, timeout);
    const code = Number(res?.status || 0);
    try { recordVinted429Sample({ is429: code === 429 }); } catch {}
    if (code >= 200 && code < 300) {
      try { metrics.fetch_ok_total.inc(); } catch {}
      try { rateCtl.observe('DIRECT', { ok: true, latency, code }); } catch {}
      try { stickyMap.record(ruleId, { skipped: false, proxy: 'DIRECT' }); } catch {}
      try { recordOutcome({ ok: true, status: code }); } catch {}
      return { ok: true, res };
    }
    try { rateCtl.observe('DIRECT', { ok: false, code, latency }); } catch {}
    try { stickyMap.record(ruleId, { skipped: true, proxy: 'DIRECT' }); } catch {}
    try { recordOutcome({ softfail: true, status: code }); } catch {}
    return { softFail: true };
  } catch (err) {
    const status = Number(err?.response?.status || 0);
    try { rateCtl.observe('DIRECT', { fail: true }); } catch {}
    try { stickyMap.record(ruleId, { skipped: true, proxy: 'DIRECT' }); } catch {}
    try { recordOutcome({ softfail: true, status }); } catch {}
    return { softFail: true };
  }
}

export async function fetchRule(ruleId, url, opts = {}) {
  const host = (() => {
    try { return new URL(url).host; }
    catch { return null; }
  })();
  const healthyAvailable = hasHealthy();
  let candidate = null;
  const stickyProxy = healthyAvailable ? stickyMap.assign(ruleId) : null;
  if (stickyProxy) candidate = { proxy: stickyProxy, mode: 'sticky', budgetToken: false };
  if (!candidate) {
    const picked = getProxy({ allowExploratory: true, preferExploratory: !healthyAvailable });
    if (picked) candidate = picked;
  }

  const defaults = {
    targetRpm: Number(process.env.SEARCH_TARGET_RPM || 300),
    minRpm: Number(process.env.SEARCH_MIN_RPM || 120),
    maxRpm: Number(process.env.SEARCH_MAX_RPM || 2000),
  };

  const releaseExploreBudget = () => {
    if (candidate && candidate.budgetToken) {
      releaseExploreToken();
      candidate.budgetToken = false;
    }
  };

  let proxy = candidate?.proxy || null;
  let proxyMode = candidate?.mode || (healthyAvailable ? 'sticky' : null);
  let usingTrial = proxyMode === 'trial';
  let hostTokenTaken = false;
  let buckets = null;

  for (let attempt = 0; attempt < 2 && proxy; attempt++) {
    proxyMode = candidate?.mode || (healthyAvailable ? 'sticky' : null);
    usingTrial = proxyMode === 'trial';
    hostTokenTaken = false;

    if (!usingTrial && host) {
      try {
        const bucket = ensureSearchBucket(host, defaults);
        hostTokenTaken = bucket?.take?.(1) ?? false;
        if (!hostTokenTaken) {
          releaseExploreBudget();
          candidate = getProxy({ allowExploratory: true, preferExploratory: true });
          proxy = candidate?.proxy || null;
          continue;
        }
      } catch {
        hostTokenTaken = false;
        releaseExploreBudget();
        candidate = getProxy({ allowExploratory: true, preferExploratory: true });
        proxy = candidate?.proxy || null;
        continue;
      }
    }

    proxy = candidate?.proxy || proxy;
    buckets = getBuckets(proxy, rateCtl);
    const DISABLE_RES = String(process.env.SEARCH_DISABLE_RESERVOIR || '0') === '1';
    if (!usingTrial && (!buckets || (!DISABLE_RES && !buckets.main.take(1)))) {
      metrics.fetch_skipped_total.inc();
      rateCtl.observe(proxy, { skipped: true });
      if (hostTokenTaken && host) giveBackBucket(host, 1);
      releaseExploreBudget();
      if (attempt === 0) {
        candidate = getProxy({ allowExploratory: true, preferExploratory: true });
        proxy = candidate?.proxy || null;
        continue;
      }
      try { stickyMap.record(ruleId, { skipped: true, proxy }); } catch {}
      if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log(`[fetch] skip rule=${ruleId} proxy=${proxy} reason=no-proxy-budget`);
      return { skipped: true };
    }

    break;
  }

  proxy = candidate?.proxy || proxy;
  if (!proxy) {
    releaseExploreBudget();
    const fallback = await fetchDirectFallback(ruleId, url, opts);
    if (fallback && (fallback.ok || fallback.softFail)) return fallback;
    metrics.fetch_skipped_total.inc();
    try { stickyMap.record(ruleId, { skipped: true, proxy: null }); } catch {}
    if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log(`[fetch] skip rule=${ruleId} reason=no-proxy`);
    return { skipped: true };
  }
  const bucketState = buckets || getBuckets(proxy, rateCtl);
  try {
    const { res, latency } = await doFetchWithProxy(proxy, url, opts, Number(process.env.FETCH_TIMEOUT_MS || 6000));
    const code = Number(res?.status || 0);
    // Slow-proxy quarantine
    try {
      const budget = Number(process.env.LATENCY_BUDGET_MS || 2000) * 3;
      if (latency > budget) {
        const win = Number(process.env.SLOW_PROXY_WINDOW_MS || 900000);
        quarantineProxy?.(proxy, win);
        if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log(`[fetch] quarantine proxy=${proxy} ms=${latency}`);
      }
    } catch {}
    // record vinted 429 sample for adaptive search limiter
    try { recordVinted429Sample({ is429: code === 429 }); } catch {}
    const isSuccess = code >= 200 && code < 300;
    const is429 = code === 429;
    const isAuthBlock = code === 401 || code === 403 || code === 407;
    if (isSuccess) {
      metrics.fetch_ok_total.inc();
      recordProxySuccess(proxy);
      resetProxy429Backoff(proxy);
      rateCtl.observe(proxy, { ok: true, latency, code });
      if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log(`[fetch] ok rule=${ruleId} proxy=${proxy} code=${code} ms=${latency}`);
      try { stickyMap.record(ruleId, { skipped: false, proxy }); } catch {}
      try { recordOutcome({ ok: true, status: code }); } catch {}
      return { ok: true, res };
    }
    if (is429) scheduleProxy429Cooldown(proxy, res?.headers);
    if (isAuthBlock && proxy && proxy !== 'DIRECT') {
      const blockMs = Math.max(60_000, Number(process.env.PROXY_403_COOLDOWN_MS || 120_000));
      quarantineProxy(proxy, blockMs);
      metrics.proxy_block_403_total?.inc();
      if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.warn(`[fetch] proxy cooldown ${proxy} code=${code} ms=${blockMs}`);
    }
    rateCtl.observe(proxy, { ok: false, code, latency });
    recordProxyOutcome(proxy, code);
    // failed or rate limited -> consider retry on neighbor if tokens allow
    const retryBucket = (bucketState || getBuckets(proxy, rateCtl))?.retry;
    if (retryBucket && retryBucket.take(1)) {
      const alt = stickyMap.next(proxy);
      if (alt) {
        try {
          const { res: res2, latency: lat2 } = await doFetchWithProxy(alt, url, opts, Number(process.env.FETCH_TIMEOUT_MS || 6000));
          const code2 = Number(res2?.status || 0);
          if (code2 >= 200 && code2 < 300) {
            metrics.fetch_ok_total.inc();
            resetProxy429Backoff(alt);
            // slight penalty to original proxy
            rateCtl.observe(proxy, { softFail: true });
            rateCtl.observe(alt, { ok: true, latency: lat2, code: code2 });
            if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log(`[fetch] ok-after-retry rule=${ruleId} from=${proxy} alt=${alt} code=${code2} ms=${lat2}`);
            try { stickyMap.record(ruleId, { skipped: false, proxy: alt }); } catch {}
            try { recordOutcome({ ok: true, status: code2 }); } catch {}
            return { ok: true, res: res2 };
          } else {
            recordProxyOutcome(alt, code2);
            if (code2 === 429) scheduleProxy429Cooldown(alt, res2?.headers);
            rateCtl.observe(alt, { ok: false, code: code2, latency: lat2 });
            if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log(`[fetch] fail-retry rule=${ruleId} alt=${alt} code=${code2} ms=${lat2}`);
          }
        } catch (e2) {
          rateCtl.observe(alt, { fail: true });
          if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log(`[fetch] error-retry rule=${ruleId} alt=${alt} err=${e2?.message||e2}`);
        }
      }
    }
    metrics.fetch_softfail_total.inc();
    try { stickyMap.failover(ruleId); } catch {}
    try { stickyMap.record(ruleId, { skipped: true, proxy }); } catch {}
    if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log(`[fetch] softfail rule=${ruleId} proxy=${proxy} code=${code}`);
    try { recordOutcome({ softfail: true, status: code }); } catch {}
    return { softFail: true };
  } catch (e) {
    // network error -> try one neighbor if retry tokens are available
    const retryBucket = (bucketState || getBuckets(proxy, rateCtl))?.retry;
    const status = Number(e?.response?.status || 0);
    const msg = String(e?.message || e || '');
    if (status === 429) scheduleProxy429Cooldown(proxy, e?.response?.headers);
    const timeoutHit = /timeout/i.test(msg);
    if (timeoutHit) recordTimeout(proxy);
    const tlsLike = /tls|socket disconnected|econnreset|econnrefused|eai_again|enotfound/i.test(msg) || timeoutHit;
    if (proxy && proxy !== 'DIRECT' && tlsLike) {
      const coolMs = Math.max(60_000, Number(process.env.PROXY_TLS_COOLDOWN_MS || 120_000));
      try { recordProxyTlsFailure(proxy); } catch {}
      metrics.proxy_block_tls_total?.inc();
      quarantineProxy(proxy, coolMs);
      if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.warn(`[fetch] proxy tls cooldown ${proxy} ms=${coolMs} err=${msg}`);
    }
    if (retryBucket && retryBucket.take(1)) {
      const alt = stickyMap.next(proxy);
      try {
        const { res: res2, latency: lat2 } = await doFetchWithProxy(alt, url, opts, Number(process.env.FETCH_TIMEOUT_MS || 6000));
        const code2 = Number(res2?.status || 0);
        if (code2 >= 200 && code2 < 300) {
          metrics.fetch_ok_total.inc();
          rateCtl.observe(proxy, { softFail: true });
          rateCtl.observe(alt, { ok: true, latency: lat2, code: code2 });
          if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log(`[fetch] ok-after-neterr rule=${ruleId} alt=${alt} code=${code2} ms=${lat2}`);
          try { stickyMap.record(ruleId, { skipped: false, proxy: alt }); } catch {}
          try { recordOutcome({ ok: true, status: code2 }); } catch {}
          return { ok: true, res: res2 };
        }
      } catch {}
    }
    metrics.fetch_softfail_total.inc();
    try { stickyMap.failover(ruleId); } catch {}
    rateCtl.observe(proxy, { fail: true });
    try { stickyMap.record(ruleId, { skipped: true, proxy }); } catch {}
    if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log(`[fetch] net-softfail rule=${ruleId} proxy=${proxy} err=${e?.message||e}`);
    try { recordOutcome({ softfail: true, status }); } catch {}
    return { softFail: true };
  }
}




