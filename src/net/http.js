import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxy, markBadInPool } from './proxyHealth.js';

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
  throw new Error('No healthy proxies available');
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
