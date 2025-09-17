import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';

const DEFAULT_PROXY_USER =
  process.env.PROXY_DEFAULT_USERNAME ||
  process.env.PROXY_USERNAME ||
  process.env.PS_PROXY_USERNAME ||
  '';

const DEFAULT_PROXY_PASS =
  process.env.PROXY_DEFAULT_PASSWORD ||
  process.env.PROXY_PASSWORD ||
  process.env.PS_PROXY_PASSWORD ||
  '';

function normalizeProxyUrl(raw) {
  try {
    let s = String(raw || '').trim();
    if (!s) return null;
    if (!/^[a-z]+:\/\//i.test(s)) s = `http://${s}`;
    const u = new URL(s);
    if (!u.hostname || !u.port) return null;
    let user = u.username;
    let pass = u.password;
    if (!user && DEFAULT_PROXY_USER) {
      user = DEFAULT_PROXY_USER;
      pass = DEFAULT_PROXY_PASS || '';
    }
    const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass || '')}@` : '';
    return `${u.protocol}//${auth}${u.hostname}:${u.port}`;
  } catch {
    return null;
  }
}

function maskProxySample(str) {
  try {
    const u = new URL(str);
    if (u.username) {
      return `${u.protocol}//***@${u.hostname}:${u.port}`;
    }
    return `${u.protocol}//${u.hostname}:${u.port}`;
  } catch {
    return str;
  }
}

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
    const normalized = normalizeProxyUrl(s);
    if (normalized) out.push(normalized);
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
    const sample = list.slice(0, 3).map(maskProxySample).join(', ');
    logger.info?.(`[proxy] wrote list to ${FILE} (count=${list.length}) sample=[${sample}]`);
  } catch (e) {
    logger.warn?.('[proxy] failed to write list:', e?.message || e);
  }
}

async function tryReadLocal(logger = console) {
  try {
    const txt = await fs.readFile(FILE, 'utf8');
    const list = normalize(txt);
    const sample = list.slice(0, 3).map(maskProxySample).join(', ');
    logger.info?.(`[proxy] loaded cached list count=${list.length} from ${FILE} sample=[${sample}]`);
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
    if (process.env.PS_API_KEY && process.env.SERVICE_ID) {
      const base = `https://api.proxyscrape.com/v2/account/datacenter_shared/proxy-list?auth=${process.env.PS_API_KEY}&type=getproxies&protocol=http&format=txt&country=all&service=${process.env.SERVICE_ID}`;
      urls.push(`${base}&status=online`);
      urls.push(`${base}&status=all`);
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
          if (list.length) {
            const sample = list.slice(0, 3).map(maskProxySample).join(', ');
            logger.info?.(`[proxy] provider ${url} parsed count=${list.length} sample=[${sample}]`);
            return list;
          }
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
