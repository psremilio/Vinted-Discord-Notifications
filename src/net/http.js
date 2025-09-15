import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { CookieJar } from 'tough-cookie';
import { wrapper as cookieJarWrapper } from 'axios-cookiejar-support';
import { ensureProxySession, withCsrf, retryOnceOn401_403 } from './tokens.js';
import { getProxy, markBadInPool, recordProxySuccess, recordProxyOutcome } from './proxyHealth.js';
import { stickyMap } from '../schedule/stickyMap.js';
import { getBuckets, dropBuckets } from '../schedule/proxyBuckets.js';
import { rateCtl } from '../schedule/rateControl.js';
import { metrics } from '../infra/metrics.js';

const clientsByProxy = new Map();
const BASE = process.env.VINTED_BASE_URL || process.env.LOGIN_URL || 'https://www.vinted.de';

// Sliding-window trackers (60s) to drive gentle hedging adjustments and vinted 429 gauge
const softFails = [];
const totalReqs = [];
const vinted429s = [];
const vintedReqs = [];
function _gcWindow(arr) {
  const cutoff = Date.now() - 60_000;
  while (arr.length && arr[0] < cutoff) arr.shift();
}
function recordOutcome({ ok = false, softfail = false } = {}) {
  const now = Date.now();
  totalReqs.push(now); _gcWindow(totalReqs);
  if (softfail) { softFails.push(now); _gcWindow(softFails); }
  try {
    const rate = getSoftfailRate60s();
    metrics.http_429_rate_60s?.set(Math.round(rate * 100));
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
  const baseN = Math.max(1, Number(process.env.HEDGE_REQUESTS || 3));
  const maxN = Math.max(baseN, Number(process.env.HEDGE_REQUESTS_MAX || 6));
  const thr = Math.min(1, Math.max(0, Number(process.env.SOFTFAIL_RATE_BOOST_THR || 0.15)));
  const rate = getSoftfailRate60s();
  const bonus = rate > thr ? 1 : 0;
  return Math.min(maxN, baseN + bonus);
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
      timeout: Number(process.env.FETCH_TIMEOUT_MS || 5000),
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
  const http = cookieJarWrapper(axios.create({
    withCredentials: true,
    maxRedirects: 5,
    timeout: Number(process.env.FETCH_TIMEOUT_MS || 5000),
    proxy: false, // Disable axios proxy handling
    httpAgent: proxyAgent,
    httpsAgent: proxyAgent, // Use our custom agent
    headers: {
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
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
  }));
  try { http.defaults.jar = jar; } catch {}

  const client = { http, warmedAt: 0, proxyAgent, proxyLabel: key, jar, csrf: null };
  clientsByProxy.set(key, client);
  return client;
}

const PROXY_DEBUG = String(process.env.DEBUG_PROXY || '0') === '1';
const bootstrapFailCounts = new Map(); // proxyLabel -> count

async function bootstrapSession(client, base = BASE) {
  const TTL = 45 * 60 * 1000; // 45 minutes
  if (client.warmedAt && Date.now() - client.warmedAt < TTL) return;
  // Do not bootstrap for direct clients (no proxy agent)
  if (!client.proxyAgent) { client.warmedAt = Date.now(); return; }
  try {
    const res = await axios.get(base, {
      proxy: false,
      httpAgent: client.proxyAgent,
      httpsAgent: client.proxyAgent,
      timeout: 10000,
      validateStatus: () => true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        Connection: 'keep-alive',
      }
    });
    const setCookie = res.headers['set-cookie'] || [];
    const cookieHeader = setCookie.map(c => c.split(';')[0]).join('; ');
    let csrf;
    if (typeof res.data === 'string') {
      const m = res.data.match(/name="csrf-token"\s+content="([^"]+)"/i);
      csrf = m && m[1];
    }
    if (cookieHeader) client.http.defaults.headers.Cookie = cookieHeader;
    client.http.defaults.headers.Referer = base.endsWith('/') ? base : base + '/';
    client.http.defaults.headers.Origin = base.replace(/\/$/, '');
    if (csrf) client.http.defaults.headers['X-CSRF-Token'] = csrf;
    client.warmedAt = Date.now();
    if (PROXY_DEBUG) {
      console.log(`[proxy] session bootstrapped for ${client.proxyLabel}${csrf ? ' +csrf' : ''}`);
    }
  } catch (e) {
    console.warn('[proxy] bootstrap failed:', e.code || e.message);
    // Non-blocking single retry after a short delay
    const retryDelay = Math.max(200, Number(process.env.PROXY_BOOTSTRAP_RETRY_DELAY_MS || 500));
    try { console.log(`[proxy] scheduling non-blocking bootstrap retry in ${retryDelay}ms for ${client.proxyLabel}`); } catch {}
    setTimeout(async () => {
      try {
        const res2 = await axios.get(base, {
          proxy: false,
          httpAgent: client.proxyAgent,
          httpsAgent: client.proxyAgent,
          timeout: 8000,
          validateStatus: () => true,
          headers: {
            'User-Agent': 'Mozilla/5.0',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          }
        });
        const setCookie2 = res2.headers['set-cookie'] || [];
        const cookieHeader2 = setCookie2.map(c => c.split(';')[0]).join('; ');
        if (cookieHeader2) client.http.defaults.headers.Cookie = cookieHeader2;
        client.http.defaults.headers.Referer = base.endsWith('/') ? base : base + '/';
        client.http.defaults.headers.Origin = base.replace(/\/$/, '');
        client.warmedAt = Date.now();
        if (PROXY_DEBUG) console.log(`[proxy] session bootstrapped (retry) for ${client.proxyLabel}`);
      } catch {}
    }, retryDelay);
    // Circuit-breaker on repeated bootstrap failures
    try {
      const key = String(client.proxyLabel || '');
      if (key) {
        const c = (bootstrapFailCounts.get(key) || 0) + 1;
        bootstrapFailCounts.set(key, c);
        const MAX = Math.max(2, Number(process.env.PROXY_BOOTSTRAP_FAIL_MAX || 3));
        if (c >= MAX) {
          console.warn(`[proxy] bootstrap circuit-breaker: marking proxy bad after ${c} fails → ${key}`);
          try { markBadInPool(key); } catch {}
          bootstrapFailCounts.set(key, 0);
        }
      }
    } catch {}
  }
}

export async function getHttp(base) {
  // Per-request: attempt to grab a proxy from the pool
  const MAX_TRIES = Math.max(1, Number(process.env.PROXY_MAX_RETRIES || 2));
  for (let i = 0; i < MAX_TRIES; i++) {
    const p = getProxy();
  if (!p) {
      await new Promise(r => setTimeout(r, 150 + i * 100));
      continue;
    }
    const client = createClient(p);
    await ensureProxySession(client);
    return { http: client.http, proxy: p, client };
  }

  // Optional direct fallback when no proxies are immediately available.
  // Enabled by ALLOW_DIRECT=1 or (by default) ALLOW_DIRECT_ON_EMPTY=1.
  const DIRECT_OK =
    String(process.env.ALLOW_DIRECT || '0') === '1' ||
    String(process.env.ALLOW_DIRECT_ON_EMPTY || '0') === '1' ||
    String(process.env.PROXY_ALLOW_DIRECT_WHEN_EMPTY || '0') === '1';
  if (DIRECT_OK) {
    const http = axios.create({
      withCredentials: true,
      maxRedirects: 5,
      timeout: 15000,
      proxy: false,
    });
    return { http, proxy: 'DIRECT' };
  }
  console.warn('[proxy] No healthy proxies available; consider checking PROXY_* vars or set ALLOW_DIRECT=1 for debugging.');
  throw new Error('No healthy proxies available');
}

// Hedged GET: fire up to HEDGE_REQUESTS with small delay and return the first useful response
export async function hedgedGet(url, config = {}, base = BASE) {
  const HEDGE_N = getHedgeBudget();
  const HEDGE_DELAY = Math.max(0, Number(process.env.HEDGE_DELAY_MS || 200));

  const attempts = [];
  const controllers = [];
  let resolved = false;

  function runAttempt(delayMs) {
    return new Promise((resolve) => {
      setTimeout(async () => {
        if (resolved) return resolve(null);
        let proxy;
        try {
          const { http, proxy: p, client } = await getHttp(base);
          proxy = p;
          const controller = new AbortController();
          controllers.push(controller);
          await ensureProxySession(client);
          let res = await retryOnceOn401_403(
            () => client.http.get(url, withCsrf({ ...config, signal: controller.signal, validateStatus: () => true }, client)),
            client
          );
          const code = Number(res.status || 0);
          if (!resolved && code >= 200 && code < 300) {
            recordProxySuccess(proxy);
            recordOutcome({ ok: true });
            resolved = true;
            resolve({ res, proxy });
          } else {
            const code2 = Number(res?.status || 0);
            if (!resolved && code2 >= 200 && code2 < 300) {
              recordProxySuccess(proxy);
              recordOutcome({ ok: true });
              resolved = true;
              resolve({ res, proxy });
            } else {
              recordProxyOutcome(proxy, code2 || code);
              recordOutcome({ softfail: true });
              resolve(null);
            }
          }
        } catch (e) {
          // timeouts or network errors
          recordProxyOutcome(proxy, e?.response?.status || 0);
          recordOutcome({ softfail: true });
          resolve(null);
        }
      }, delayMs);
    });
  }

  for (let i = 0; i < HEDGE_N; i++) {
    attempts.push(runAttempt(i === 0 ? 0 : i * HEDGE_DELAY));
  }
  const results = await Promise.all(attempts);
  const winner = results.find(x => x && x.res);
  if (winner) return winner.res;
  // Optional direct fallback when all hedged proxy requests fail
  try {
    const ALLOW = String(process.env.ALLOW_DIRECT_ON_HEDGE_FAIL || process.env.ALLOW_DIRECT || '0') === '1';
    if (ALLOW) {
      const res = await axios.get(url, { ...config, proxy: false, timeout: Number(process.env.FETCH_TIMEOUT_MS || 5000), validateStatus: () => true });
      const code = Number(res?.status || 0);
      if (code >= 200 && code < 300) {
        try { recordOutcome({ ok: true }); } catch {}
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
export async function doFetchWithProxy(proxy, url, config = {}, timeout = Number(process.env.FETCH_TIMEOUT_MS || 5000)) {
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

export async function fetchRule(ruleId, url, opts = {}) {
  const proxy = stickyMap.assign(ruleId);
  if (!proxy) {
    metrics.fetch_skipped_total.inc();
    // no bucket/proxy available for this slot
    try { stickyMap.record(ruleId, { skipped: true, proxy: null }); } catch {}
    if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log(`[fetch] skip rule=${ruleId} reason=no-proxy`);
    return { skipped: true };
  }
  const buckets = getBuckets(proxy, rateCtl);
  const DISABLE_RES = String(process.env.SEARCH_DISABLE_RESERVOIR || '0') === '1';
  if (!buckets || (!DISABLE_RES && !buckets.main.take(1))) {
    metrics.fetch_skipped_total.inc();
    // no reservoir token for this proxy right now
    rateCtl.observe(proxy, { skipped: true });
    try { stickyMap.record(ruleId, { skipped: true, proxy }); } catch {}
    if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log(`[fetch] skip rule=${ruleId} proxy=${proxy} reason=no-bucket`);
    return { skipped: true };
  }
  try {
    const { res, latency } = await doFetchWithProxy(proxy, url, opts, Number(process.env.FETCH_TIMEOUT_MS || 4000));
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
    if (code === 429 || code === 403) {
      // treat as fail for controller, but return softFail path below
      rateCtl.observe(proxy, { ok: false, code, latency });
    } else if (code >= 200 && code < 300) {
      metrics.fetch_ok_total.inc();
      recordProxySuccess(proxy);
      rateCtl.observe(proxy, { ok: true, latency, code });
      if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log(`[fetch] ok rule=${ruleId} proxy=${proxy} code=${code} ms=${latency}`);
      try { stickyMap.record(ruleId, { skipped: false, proxy }); } catch {}
      return { ok: true, res };
    }
    // Token refresh + single retry on same proxy for 401/403 if enabled
    const RETRY_ON_401 = String(process.env.TOKEN_RETRY_ON_401 || '1') === '1';
    if (RETRY_ON_401 && (code === 401 || code === 403)) {
      const delay = Math.max(0, Number(process.env.TOKEN_RETRY_DELAY_MS || 300));
      await new Promise(r => setTimeout(r, delay));
      try { await bootstrapSession(createClient(proxy)); } catch {}
      try {
        const { res: res3, latency: lat3 } = await doFetchWithProxy(proxy, url, opts, Number(process.env.FETCH_TIMEOUT_MS || 4000));
        const code3 = Number(res3?.status || 0);
        if (code3 >= 200 && code3 < 300) {
          metrics.fetch_ok_total.inc();
          recordProxySuccess(proxy);
          rateCtl.observe(proxy, { ok: true, latency: lat3, code: code3 });
          try { stickyMap.record(ruleId, { skipped: false, proxy }); } catch {}
          return { ok: true, res: res3 };
        }
      } catch {}
    }
    // failed or rate limited -> consider retry on neighbor if tokens allow
    const retry = getBuckets(proxy, rateCtl).retry;
    if (retry && retry.take(1)) {
      const alt = stickyMap.next(proxy);
      if (alt) {
        try {
          const { res: res2, latency: lat2 } = await doFetchWithProxy(alt, url, opts, Number(process.env.FETCH_TIMEOUT_MS || 4000));
          const code2 = Number(res2?.status || 0);
          if (code2 >= 200 && code2 < 300) {
            metrics.fetch_ok_total.inc();
            // slight penalty to original proxy
            rateCtl.observe(proxy, { softFail: true });
            rateCtl.observe(alt, { ok: true, latency: lat2, code: code2 });
            if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log(`[fetch] ok-after-retry rule=${ruleId} from=${proxy} alt=${alt} code=${code2} ms=${lat2}`);
            try { stickyMap.record(ruleId, { skipped: false, proxy: alt }); } catch {}
            try { recordOutcome({ ok: true }); } catch {}
            return { ok: true, res: res2 };
          } else {
            recordProxyOutcome(alt, code2);
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
    try { recordOutcome({ softfail: true }); } catch {}
    return { softFail: true };
  } catch (e) {
    // network error -> try one neighbor if retry tokens are available
    const retry = getBuckets(proxy, rateCtl).retry;
    if (String(e?.message || '').includes('timeout')) recordTimeout(proxy);
    if (retry && retry.take(1)) {
      const alt = stickyMap.next(proxy);
      try {
        const { res: res2, latency: lat2 } = await doFetchWithProxy(alt, url, opts, Number(process.env.FETCH_TIMEOUT_MS || 4000));
        const code2 = Number(res2?.status || 0);
        if (code2 >= 200 && code2 < 300) {
          metrics.fetch_ok_total.inc();
          rateCtl.observe(proxy, { softFail: true });
          rateCtl.observe(alt, { ok: true, latency: lat2, code: code2 });
          if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log(`[fetch] ok-after-neterr rule=${ruleId} alt=${alt} code=${code2} ms=${lat2}`);
          try { stickyMap.record(ruleId, { skipped: false, proxy: alt }); } catch {}
          try { recordOutcome({ ok: true }); } catch {}
          return { ok: true, res: res2 };
        }
      } catch {}
    }
    metrics.fetch_softfail_total.inc();
    try { stickyMap.failover(ruleId); } catch {}
    rateCtl.observe(proxy, { fail: true });
    try { stickyMap.record(ruleId, { skipped: true, proxy }); } catch {}
    if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log(`[fetch] net-softfail rule=${ruleId} proxy=${proxy} err=${e?.message||e}`);
    try { recordOutcome({ softfail: true }); } catch {}
    return { softFail: true };
  }
}
