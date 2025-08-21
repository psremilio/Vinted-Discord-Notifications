import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxy, markBadInPool } from './proxyHealth.js';

const clientsByProxy = new Map();
let CURRENT_PROXY = null;

function createClient(proxyStr) {
  const existing = clientsByProxy.get(proxyStr);
  if (existing) return existing;

  const [host, portStr] = proxyStr.split(':');
  const port = Number(portStr);
  
  // Create HTTPS proxy agent for proper tunneling
  const proxyAgent = new HttpsProxyAgent(`http://${host}:${port}`);
  
  const http = wrapper(
    axios.create({
      jar: new CookieJar(),
      withCredentials: true,
      maxRedirects: 5,
      timeout: 15000,
      proxy: false, // Disable axios proxy handling
      httpsAgent: proxyAgent, // Use our custom agent
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'TE': 'trailers',
      },
    })
  );
  const client = { http, warmedAt: 0, proxyAgent };
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

// Retry with exponential backoff
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) throw error;
      
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
      console.log(`[retry] attempt ${attempt + 1} failed, retrying in ${Math.round(delay)}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
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
  if (badProxy && clientsByProxy.has(badProxy)) {
    const client = clientsByProxy.get(badProxy);
    if (client.proxyAgent) {
      client.proxyAgent.destroy();
    }
    clientsByProxy.delete(badProxy);
  }
  if (badProxy) markBadInPool(badProxy);
  CURRENT_PROXY = getProxy();
}

export async function initProxyPool() {
  return (await import('./proxyHealth.js')).initProxyPool();
}

