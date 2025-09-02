import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxy, markBadInPool, recordProxySuccess, recordProxyOutcome } from './proxyHealth.js';
import { stickyMap } from '../schedule/stickyMap.js';
import { getBuckets, dropBuckets } from '../schedule/proxyBuckets.js';
import { rateCtl } from '../schedule/rateControl.js';
import { metrics } from '../infra/metrics.js';

const clientsByProxy = new Map();
const BASE = process.env.VINTED_BASE_URL || process.env.LOGIN_URL || 'https://www.vinted.de';

function createClient(proxyStr) {
  const existing = clientsByProxy.get(proxyStr);
  if (existing) return existing;

  const [host, portStr] = proxyStr.split(':');
  const port = Number(portStr);

  // Create HTTPS proxy agent for proper tunneling
  const proxyAgent = new HttpsProxyAgent(`http://${host}:${port}`);

  const http = axios.create({
    withCredentials: true,
    maxRedirects: 5,
    timeout: 15000,
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
  });

  const client = { http, warmedAt: 0, proxyAgent, proxyLabel: `${host}:${port}` };
  clientsByProxy.set(proxyStr, client);
  return client;
}

const PROXY_DEBUG = String(process.env.DEBUG_PROXY || '0') === '1';

async function bootstrapSession(client, base = BASE) {
  const TTL = 45 * 60 * 1000; // 45 minutes
  if (client.warmedAt && Date.now() - client.warmedAt < TTL) return;
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
  }
}

export async function getHttp(base) {
  // Per-request: attempt to grab a proxy from the pool
  const MAX_TRIES = 6;
  for (let i = 0; i < MAX_TRIES; i++) {
    const p = getProxy();
    if (!p) {
      await new Promise(r => setTimeout(r, 150 + i * 100));
      continue;
    }
    const client = createClient(p);
    await bootstrapSession(client, base || BASE);
    return { http: client.http, proxy: p };
  }

  if (process.env.ALLOW_DIRECT === '1') {
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
  const HEDGE_N = Math.max(1, Number(process.env.HEDGE_REQUESTS || 2));
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
          const { http, proxy: p } = await getHttp(base);
          proxy = p;
          const controller = new AbortController();
          controllers.push(controller);
          const res = await http.get(url, { ...config, signal: controller.signal, validateStatus: () => true });
          const code = Number(res.status || 0);
          if (!resolved && code >= 200 && code < 300) {
            recordProxySuccess(proxy);
            resolved = true;
            resolve({ res, proxy });
          } else {
            recordProxyOutcome(proxy, code);
            resolve(null);
          }
        } catch (e) {
          // timeouts or network errors
          recordProxyOutcome(proxy, e?.response?.status || 0);
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
  const { http, proxy } = await getHttp();
  try {
    return await http.get(url, config);
  } catch (e) {
    if (e.response && e.response.status === 401) {
      markBadInPool(proxy);
    }
    throw e;
  }
}

// Low-level fetch via a specific proxy, with latency measurement
export async function doFetchWithProxy(proxy, url, config = {}, timeout = 12000) {
  const client = createClient(proxy);
  await bootstrapSession(client);
  const t0 = Date.now();
  const res = await client.http.get(url, { ...config, timeout, validateStatus: () => true });
  const latency = Date.now() - t0;
  return { res, latency };
}

// Sticky-per-proxy fetch with AIMD and token buckets
export async function fetchRule(ruleId, url, opts = {}) {
  const proxy = stickyMap.assign(ruleId);
  if (!proxy) {
    metrics.fetch_skipped_total.inc();
    try { stickyMap.record(ruleId, { skipped: true, proxy: null }); } catch {}
    if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log(`[fetch] skip rule=${ruleId} reason=no-proxy`);
    return { skipped: true };
  }
  const buckets = getBuckets(proxy, rateCtl);
  if (!buckets || !buckets.main.take(1)) {
    metrics.fetch_skipped_total.inc();
    rateCtl.observe(proxy, { skipped: true });
    try { stickyMap.record(ruleId, { skipped: true, proxy }); } catch {}
    if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log(`[fetch] skip rule=${ruleId} proxy=${proxy} reason=no-token`);
    return { skipped: true };
  }
  try {
    const { res, latency } = await doFetchWithProxy(proxy, url, opts, 12000);
    const code = Number(res?.status || 0);
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
    // failed or rate limited -> consider retry on neighbor if tokens allow
    const retry = getBuckets(proxy, rateCtl).retry;
    if (retry && retry.take(1)) {
      const alt = stickyMap.next(proxy);
      if (alt) {
        try {
          const { res: res2, latency: lat2 } = await doFetchWithProxy(alt, url, opts, 12000);
          const code2 = Number(res2?.status || 0);
          if (code2 >= 200 && code2 < 300) {
            metrics.fetch_ok_total.inc();
            // slight penalty to original proxy
            rateCtl.observe(proxy, { softFail: true });
            rateCtl.observe(alt, { ok: true, latency: lat2, code: code2 });
            if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log(`[fetch] ok-after-retry rule=${ruleId} from=${proxy} alt=${alt} code=${code2} ms=${lat2}`);
            try { stickyMap.record(ruleId, { skipped: false, proxy: alt }); } catch {}
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
    return { softFail: true };
  } catch (e) {
    // network error -> try one neighbor if retry tokens are available
    const retry = getBuckets(proxy, rateCtl).retry;
    if (retry && retry.take(1)) {
      const alt = stickyMap.next(proxy);
      try {
        const { res: res2, latency: lat2 } = await doFetchWithProxy(alt, url, opts, 12000);
        const code2 = Number(res2?.status || 0);
        if (code2 >= 200 && code2 < 300) {
          metrics.fetch_ok_total.inc();
          rateCtl.observe(proxy, { softFail: true });
          rateCtl.observe(alt, { ok: true, latency: lat2, code: code2 });
          if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log(`[fetch] ok-after-neterr rule=${ruleId} alt=${alt} code=${code2} ms=${lat2}`);
          try { stickyMap.record(ruleId, { skipped: false, proxy: alt }); } catch {}
          return { ok: true, res: res2 };
        }
      } catch {}
    }
    metrics.fetch_softfail_total.inc();
    try { stickyMap.failover(ruleId); } catch {}
    rateCtl.observe(proxy, { fail: true });
    try { stickyMap.record(ruleId, { skipped: true, proxy }); } catch {}
    if (String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log(`[fetch] net-softfail rule=${ruleId} proxy=${proxy} err=${e?.message||e}`);
    return { softFail: true };
  }
}
