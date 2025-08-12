import axios from 'axios';
import { CookieJar } from 'tough-cookie';
import { HttpCookieAgent, HttpsCookieAgent } from 'http-cookie-agent/http';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxy, markBadInPool } from './proxyHealth.js';

const clientsByProxy = new Map();
let CURRENT_PROXY = null;

function buildAgents(proxyStr) {
  const jar = new CookieJar();
  const proxyUrl = proxyStr ? `http://${proxyStr}` : null;
  const httpAgent = new HttpCookieAgent({
    cookies: { jar },
    keepAlive: true,
    agent: proxyUrl ? new HttpProxyAgent(proxyUrl) : undefined,
  });
  const httpsAgent = new HttpsCookieAgent({
    cookies: { jar },
    keepAlive: true,
    agent: proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined,
  });
  return { httpAgent, httpsAgent };
}

function createClient(proxyStr) {
  const existing = clientsByProxy.get(proxyStr);
  if (existing) return existing;

  const { httpAgent, httpsAgent } = buildAgents(proxyStr);
  const http = axios.create({
    proxy: false,
    httpAgent,
    httpsAgent,
    withCredentials: true,
    maxRedirects: 5,
    timeout: 15000,
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'de-DE,de;q=0.9,en;q=0.8',
      'upgrade-insecure-requests': '1',
    },
  });
  const client = { http };
  clientsByProxy.set(proxyStr, client);
  return client;
}

export function getHttp() {
  if (!CURRENT_PROXY) CURRENT_PROXY = getProxy();
  if (!CURRENT_PROXY) {
    if (process.env.ALLOW_DIRECT === '1') {
      const { http } = createClient('');
      return { http, proxy: 'DIRECT' };
    }
    throw new Error('No healthy proxies available');
  }

  const { http } = createClient(CURRENT_PROXY);
  return { http, proxy: CURRENT_PROXY };
}

export function rotateProxy(badProxy) {
  if (badProxy && clientsByProxy.has(badProxy)) clientsByProxy.delete(badProxy);
  if (badProxy && badProxy !== 'DIRECT') markBadInPool(badProxy);
  CURRENT_PROXY = getProxy();
}

export async function initProxyPool() {
  return (await import('./proxyHealth.js')).initProxyPool();
}

export function isProxyReallyBad(err) {
  if (!err) return false;
  const code = err.code || '';
  const status = err.response?.status;

  if (['ECONNRESET','ETIMEDOUT','ENETUNREACH','ECONNREFUSED','EHOSTUNREACH'].includes(code)) return true;
  if (status === 407) return true;
  return false;
}

