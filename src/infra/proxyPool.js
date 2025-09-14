import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';

const DEFAULT_FILE =
  process.env.PROXIES_FILE ||
  (process.env.RAILWAY_ENVIRONMENT ? '/app/config/proxies.txt' : 'config/proxies.txt');
const FILE = DEFAULT_FILE;

function normalize(txt) {
  if (!txt) return [];
  const out = [];
  const lines = String(txt)
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('#'));
  for (const s of lines) {
    if (/^https?:\/\//i.test(s)) { out.push(s); continue; }
    if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}$/.test(s)) { out.push(`http://${s}`); continue; }
    if (/^[a-z0-9.-]+:\d{2,5}$/i.test(s)) { out.push(`http://${s}`); continue; }
  }
  // de-dup while preserving order
  const seen = new Set();
  const uniq = [];
  for (const p of out) { if (!seen.has(p)) { seen.add(p); uniq.push(p); } }
  return uniq;
}

function parseInline(s) {
  if (!s) return [];
  const nl = String(s).replace(/\s*,\s*/g, '\n');
  return normalize(nl);
}

async function writeList(list, logger = console) {
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE, list.join('\n'), 'utf8');
    logger.info?.(`[proxy] wrote list to ${FILE} (${list.length})`);
  } catch (e) {
    logger.warn?.('[proxy] failed to write list:', e?.message || e);
  }
}

async function tryReadLocal(logger = console) {
  try {
    const txt = await fs.readFile(FILE, 'utf8');
    const list = normalize(txt);
    logger.info?.(`[proxy] loaded cached list (${list.length}) from ${FILE}`);
    return list;
  } catch { return null; }
}

function buildProviders() {
  const urls = [];
  const fromList = (process.env.PROXY_LIST_URLS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  urls.push(...fromList);
  const single = process.env.PROXY_LIST_URL && !process.env.PROXY_LIST_URL.includes('${') ? process.env.PROXY_LIST_URL : null;
  if (single) urls.push(single);
  if ((process.env.PS_API_KEY && process.env.SERVICE_ID)) {
    urls.push(`https://api.proxyscrape.com/v2/account/datacenter_shared/proxy-list?auth=${process.env.PS_API_KEY}&type=getproxies&protocol=http&format=txt&status=all&country=all&service=${process.env.SERVICE_ID}`);
  }
  return Array.from(new Set(urls));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

export async function tryProvidersWithBackoff(logger = console) {
  const providers = buildProviders();
  if (!providers.length) return null;
  const maxAttempts = Math.max(1, Number(process.env.PROXY_DL_ATTEMPTS || 6));
  const baseDelay = Math.max(100, Number(process.env.PROXY_DL_BACKOFF_MS || 1500));
  for (let i = 0; i < maxAttempts; i++) {
    for (const url of providers) {
      try {
        const res = await axios.get(url, {
          timeout: 10000,
          validateStatus: s => s === 200 || s === 429,
        });
        const ra = Number(res?.headers?.['retry-after'] || 0);
        const data = res?.data || '';
        if (res.status === 429) {
          const wait = (Number.isFinite(ra) ? ra * 1000 : 0) + jitter(200, 700);
          if (wait > 0) await sleep(wait);
          continue;
        }
        if (typeof data === 'string' && data.trim()) {
          const list = normalize(data);
          if (list.length) return list;
        }
      } catch (e) {
        if (e?.response?.status === 429) {
          // soft-fail; outer backoff handles pacing
        } else {
          logger.warn?.(`[proxy] provider ${url} error`, { msg: e?.message || String(e) });
        }
      }
    }
    await sleep((2 ** i) * baseDelay + jitter(200, 800));
  }
  return null;
}

export async function refreshInBackground(logger = console) {
  const list = await tryProvidersWithBackoff(logger);
  if (list?.length) await writeList(list, logger);
}

export async function ensureProxyPool(logger = console) {
  const cached = await tryReadLocal(logger);
  if (cached?.length) {
    // refresh in background and return cached for immediate start
    refreshInBackground(logger).catch(e => logger.warn?.('proxy bg refresh failed', e?.message || e));
    return cached;
  }
  const downloaded = await tryProvidersWithBackoff(logger);
  if (downloaded?.length) {
    await writeList(downloaded, logger);
    return downloaded;
  }
  const fallback = parseInline(process.env.PROXIES_INLINE || '');
  if (fallback.length) {
    await writeList(fallback, logger);
    logger.warn?.('proxy booted from inline fallback (no providers reachable)');
    return fallback;
  }
  throw new Error('No proxies available at boot (providers 429 + no cache).');
}

export function scheduleProxyRefresh(logger = console) {
  const mins = Number(process.env.LIST_REFRESH_MIN || 0);
  if (!mins) return;
  setInterval(() => { refreshInBackground(logger).catch(()=>{}); }, Math.max(1, mins) * 60 * 1000).unref?.();
}
