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
  const client = { http };
  clientsByProxy.set(proxyStr, client);
  return client;
}

export function getHttp() {
  if (!CURRENT_PROXY) CURRENT_PROXY = getProxy();
  if (!CURRENT_PROXY) {
    // Always allow direct connection as fallback when no proxies are available
    console.log('[proxy] No proxies available, using direct connection');
    const http = wrapper(
      axios.create({
        jar: new CookieJar(),
        withCredentials: true,
        maxRedirects: 5,
        timeout: 15000,
        proxy: false,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      })
    );
    return { http, proxy: 'DIRECT' };
  }

  const { http } = createClient(CURRENT_PROXY);
  return { http, proxy: CURRENT_PROXY };
}

export function rotateProxy(badProxy) {
  if (badProxy && clientsByProxy.has(badProxy)) clientsByProxy.delete(badProxy);
  if (badProxy) markBadInPool(badProxy);
  CURRENT_PROXY = getProxy();
}

export async function initProxyPool() {
  return (await import('./proxyHealth.js')).initProxyPool();
}

