import axios from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxy, markBadInPool } from './proxyHealth.js';

const clientsByProxy = new Map();
let CURRENT_PROXY = null;

function getClientFor(proxy) {
  let client = clientsByProxy.get(proxy);
  if (!client) {
    const jar = new CookieJar();
    const http = wrapper(
      axios.create({
        jar,
        withCredentials: true,
        maxRedirects: 5,
        timeout: 15000,
        proxy: false,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      }),
    );
    const agent = new HttpsProxyAgent('http://' + proxy);
    client = { http, agent, jar };
    clientsByProxy.set(proxy, client);
  }
  return client;
}

export function getHttp() {
  if (!CURRENT_PROXY) CURRENT_PROXY = getProxy();
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
      return { http, agent: undefined, proxy: 'DIRECT' };
    }
    throw new Error('No healthy proxies available');
  }
  const { http, agent } = getClientFor(CURRENT_PROXY);
  return { http, agent, proxy: CURRENT_PROXY };
}

export function rotateProxy(badProxy) {
  if (badProxy && clientsByProxy.has(badProxy)) clientsByProxy.delete(badProxy);
  if (badProxy) markBadInPool(badProxy);
  CURRENT_PROXY = getProxy();
}

export async function initProxyPool() {
  return (await import('./proxyHealth.js')).initProxyPool();
}

