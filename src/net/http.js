import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { getProxy, markBadInPool } from './proxyHealth.js';

const clientsByProxy = new Map();
let CURRENT_PROXY = null;

function createClient(proxyStr) {
  const existing = clientsByProxy.get(proxyStr);
  if (existing) return existing;

  const [host, portStr] = proxyStr.split(':');
  const port = Number(portStr);
  const http = wrapper(
    axios.create({
      jar: new CookieJar(),
      withCredentials: true,
      maxRedirects: 5,
      timeout: 15000,
      proxy: { protocol: 'http', host, port },
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    })
  );
  const client = { http, warmedAt: 0 };
  clientsByProxy.set(proxyStr, client);
  return client;
}

async function warmUp(client) {
  const base = process.env.VINTED_BASE_URL || process.env.LOGIN_URL || 'https://www.vinted.de/';
  if (Date.now() - client.warmedAt < 30 * 60 * 1000) return;
  try {
    // 4xx/3xx responses still prove the proxy is reachable
    await client.http.get(base, { validateStatus: () => true, timeout: 10000 });
  } catch (e) {
    // network errors shouldn't abort warmup
    console.warn('[warmup] ignoring error:', e.message || e);
  } finally {
    client.warmedAt = Date.now();
  }
}

export async function getHttp() {
  if (!CURRENT_PROXY) {
    CURRENT_PROXY = getProxy();
    if (!CURRENT_PROXY) {
      try {
        const mod = await import('./proxyHealth.js');
        await mod.initProxyPool();
        CURRENT_PROXY = getProxy();
      } catch {}
    }
  }
  if (!CURRENT_PROXY) {
    if (process.env.ALLOW_DIRECT === '1') {
      const http = wrapper(
        axios.create({
          withCredentials: true,
          maxRedirects: 5,
          timeout: 15000,
          proxy: false,
        })
      );
      return { http, proxy: 'DIRECT' };
    }
    throw new Error('No healthy proxies available');
  }

  const client = createClient(CURRENT_PROXY);
  await warmUp(client);
  return { http: client.http, proxy: CURRENT_PROXY };
}

export function rotateProxy(badProxy) {
  if (badProxy && clientsByProxy.has(badProxy)) clientsByProxy.delete(badProxy);
  if (badProxy) markBadInPool(badProxy);
  CURRENT_PROXY = getProxy();
}

export async function initProxyPool() {
  return (await import('./proxyHealth.js')).initProxyPool();
}

