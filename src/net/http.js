import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxy, markBadInPool } from './proxyHealth.js';

const clientsByProxy = new Map();
let CURRENT_PROXY = null;
let failedProxiesCount = 0;
const MAX_FAILED_PROXIES = 5;
let globalCooldownUntil = 0;
const GLOBAL_COOLDOWN_DURATION = 5 * 60 * 1000; // 5 minutes

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
    },
  });
  
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
  // Check global cooldown
  if (Date.now() < globalCooldownUntil) {
    const remaining = Math.ceil((globalCooldownUntil - Date.now()) / 1000);
    console.warn(`[proxy] Global cooldown active, waiting ${remaining}s before retrying`);
    await new Promise(resolve => setTimeout(resolve, remaining * 1000));
  }
  
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
      const http = axios.create({
        withCredentials: true,
        maxRedirects: 5,
        timeout: 15000,
        proxy: false,
      });
      return { http, proxy: 'DIRECT' };
    }
    
    // If no proxies available and direct is not allowed, try to refresh the pool one more time
    try {
      console.warn('[proxy] No proxies available, attempting to refresh pool...');
      const mod = await import('./proxyHealth.js');
      await mod.initProxyPool();
      CURRENT_PROXY = getProxy();
      if (CURRENT_PROXY) {
        const client = createClient(CURRENT_PROXY);
        await warmUp(client);
        return { http: client.http, proxy: CURRENT_PROXY };
      }
    } catch (e) {
      console.warn('[proxy] Failed to refresh proxy pool:', e.message);
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
  if (badProxy) {
    markBadInPool(badProxy);
    failedProxiesCount++;
    
    // If too many proxies are failing, refresh the pool and set global cooldown
    if (failedProxiesCount >= MAX_FAILED_PROXIES) {
      console.warn('[proxy] Too many failed proxies, refreshing pool and setting global cooldown...');
      failedProxiesCount = 0;
      globalCooldownUntil = Date.now() + GLOBAL_COOLDOWN_DURATION;
      console.warn(`[proxy] Global cooldown set for ${GLOBAL_COOLDOWN_DURATION / 1000}s`);
      
      // Clear all clients to force recreation
      for (const [proxy, client] of clientsByProxy) {
        if (client.proxyAgent) {
          client.proxyAgent.destroy();
        }
      }
      clientsByProxy.clear();
      CURRENT_PROXY = null;
    }
  }
  CURRENT_PROXY = getProxy();
}

export async function initProxyPool() {
  return (await import('./proxyHealth.js')).initProxyPool();
}

