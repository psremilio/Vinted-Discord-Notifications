import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { getProxy, markBadInPool, getProxyCount, isProxyAvailable } from './proxyHealth.js';

const clientsByProxy = new Map();
let CURRENT_PROXY = null;
let directClient = null;

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

function createDirectClient() {
  if (directClient) return directClient;
  
  directClient = wrapper(
    axios.create({
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
  
  return directClient;
}

export function getHttp() {
  // Try to get a proxy first
  if (!CURRENT_PROXY && isProxyAvailable()) {
    CURRENT_PROXY = getProxy();
  }
  
  if (CURRENT_PROXY) {
    try {
      const { http } = createClient(CURRENT_PROXY);
      return { http, proxy: CURRENT_PROXY };
    } catch (err) {
      console.warn(`[http] Proxy ${CURRENT_PROXY} failed, trying to rotate:`, err.message);
      rotateProxy(CURRENT_PROXY);
      return getHttp(); // Recursive call to try again
    }
  }
  
  // Fallback to direct connection if allowed
  if (process.env.ALLOW_DIRECT === '1') {
    console.log('[http] Verwende direkte Verbindung (keine Proxies verfügbar)');
    const http = createDirectClient();
    return { http, proxy: 'DIRECT' };
  }
  
  // If we get here, no proxies available and direct not allowed
  console.error('[http] Keine Proxies verfügbar und direkte Verbindung nicht erlaubt');
  throw new Error('No healthy proxies available');
}

export function rotateProxy(badProxy) {
  if (badProxy && clientsByProxy.has(badProxy)) {
    clientsByProxy.delete(badProxy);
    console.log(`[http] Proxy ${badProxy} aus Client-Cache entfernt`);
  }
  
  if (badProxy) {
    markBadInPool(badProxy);
  }
  
  // Try to get a new proxy
  CURRENT_PROXY = getProxy();
  
  if (CURRENT_PROXY) {
    console.log(`[http] Proxy rotiert zu: ${CURRENT_PROXY}`);
  } else {
    console.warn('[http] Keine weiteren Proxies verfügbar');
  }
}

export async function initProxyPool() {
  return (await import('./proxyHealth.js')).initProxyPool();
}

export function getProxyStatus() {
  return {
    currentProxy: CURRENT_PROXY,
    availableProxies: getProxyCount(),
    hasProxies: isProxyAvailable(),
    allowDirect: process.env.ALLOW_DIRECT === '1'
  };
}

