import fs from 'fs';
import path from 'path';
import axios from 'axios';

// Destination file for normalized proxy list
const DEST =
  process.env.PROXY_LIST_FILE ||
  (process.env.RAILWAY_ENVIRONMENT ? '/app/config/proxies.txt' : 'config/proxies.txt');

function mask(s = '') {
  const str = String(s || '');
  return str.length > 12 ? `${str.slice(0, 4)}…${str.slice(-4)}` : '***';
}

function toUrl(line) {
  let s = String(line || '').trim();
  if (!s || s.startsWith('#')) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname || !u.port) return null;
    const auth = u.username ? `${encodeURIComponent(u.username)}:${encodeURIComponent(u.password || '')}@` : '';
    return `${u.protocol}//${auth}${u.hostname}:${u.port}`;
  } catch {
    return null;
  }
}

function normalizeList(txtOrArr) {
  let lines = [];
  if (Array.isArray(txtOrArr)) {
    lines = txtOrArr.map(x =>
      typeof x === 'string'
        ? x
        : (x?.url || (x?.host && x?.port ? `${x.host}:${x.port}` : ''))
    );
  } else if (typeof txtOrArr === 'object' && txtOrArr) {
    const obj = txtOrArr;
    const arr = obj.data || obj.list || obj.items || obj.proxies || [];
    if (Array.isArray(arr) && arr.length) {
      lines = arr.map(x => (typeof x === 'string' ? x : (x?.url || (x?.host && x?.port ? `${x.host}:${x.port}` : ''))));
    } else {
      // Attempt to flatten object values to strings
      lines = Object.values(obj).map(v => (typeof v === 'string' ? v : ''));
    }
  } else {
    const txt = String(txtOrArr || '');
    lines = txt.split(/\r?\n/);
  }
  const list = lines.map(toUrl).filter(Boolean);
  const uniq = [...new Set(list)];
  return uniq.join('\n') + (uniq.length ? '\n' : '');
}

async function writeAtomic(dest, content) {
  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(dest)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, dest);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithBackoff(url, { headers = {}, params = {}, responseType = 'text', attempts = null } = {}) {
  const maxAttempts = Math.max(1, Number(attempts || process.env.PROXY_DL_ATTEMPTS || 5));
  const baseDelay = Math.max(100, Number(process.env.PROXY_DL_BACKOFF_MS || 1500));
  const timeout = Math.max(1000, Number(process.env.PROXY_CHECK_TIMEOUT_SEC || 8) * 1000);
  let lastErr = null;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await axios.get(url, {
        headers,
        params,
        timeout,
        responseType,
        // Accept 2xx..4xx (so 429 is handled via code below)
        validateStatus: s => s >= 200 && s < 500,
      });
      // Handle 429 backoff
      if (res.status === 429) {
        const ra = Number(res.headers?.['retry-after'] || 0);
        const wait = (Number.isFinite(ra) ? ra * 1000 : 0) + Math.floor(Math.random() * 500);
        if (wait > 0) await sleep(wait);
        continue;
      }
      if (res.status >= 400) {
        lastErr = new Error(`status=${res.status}`);
        // backoff and retry
      } else {
        return res.data;
      }
    } catch (e) {
      lastErr = e;
    }
    const delay = (2 ** i) * baseDelay + Math.floor(Math.random() * 500);
    await sleep(delay);
  }
  if (lastErr && lastErr.message) {
    throw new Error(`download failed: ${lastErr.message}`);
  }
  throw new Error('download failed');
}

export async function ensureProxyList() {
  const url = String(process.env.PROXY_LIST_URL || '').trim();
  const psKey = String(process.env.PS_API_KEY || '').trim();
  const psEndpoint = String(process.env.PS_ENDPOINT || '').trim();
  const serviceId = String(process.env.PS_SERVICE_ID || process.env.SERVICE_ID || '').trim();
  const format = String(process.env.PS_FORMAT || 'txt').trim().toLowerCase(); // 'txt' | 'json'

  await fs.promises.mkdir(path.dirname(DEST), { recursive: true });

  let raw = null;
  if (url) {
    console.log(`[proxy] provider=url loading: ${url}`);
    raw = await fetchWithBackoff(url, { responseType: 'text' });
  } else if (psKey && psEndpoint) {
    const headerName = String(process.env.PS_AUTH_HEADER || 'Authorization').trim();
    const scheme = String(process.env.PS_AUTH_SCHEME || 'Bearer').trim();
    const headers = {};
    headers[headerName] = scheme ? `${scheme} ${psKey}` : psKey;
    // Params from env (optional)
    const params = {};
    if (serviceId) params.service_id = serviceId;
    if (process.env.PS_PROTOCOLS) params.protocols = process.env.PS_PROTOCOLS;
    if (process.env.PS_COUNTRIES) params.countries = process.env.PS_COUNTRIES;
    if (process.env.PS_LIMIT) params.limit = process.env.PS_LIMIT;
    if (process.env.PS_TIMEOUT_MS) params.timeout = process.env.PS_TIMEOUT_MS;
    if (process.env.PS_EXTRA_QUERY) {
      const extra = String(process.env.PS_EXTRA_QUERY || '');
      for (const kv of extra.split('&')) {
        if (!kv) continue;
        const [k, v] = kv.split('=');
        if (k) params[k] = v ?? '';
      }
    }
    try {
      console.log(`[proxy] provider=proxyscrape endpoint=${psEndpoint} key=${mask(psKey)} svc=${serviceId || '-'} fmt=${format}`);
    } catch {}
    const responseType = format === 'json' ? 'json' : 'text';
    raw = await fetchWithBackoff(psEndpoint, { headers, params, responseType });
  } else {
    // Neither URL nor PS key configured
    if (fs.existsSync(DEST)) {
      const n = fs.readFileSync(DEST, 'utf8').split(/\r?\n/).filter(Boolean).length;
      console.warn(`[proxy] No provider configured; using existing ${DEST} (${n} entries)`);
      return;
    }
    throw new Error('No PROXY_LIST_URL or PS_API_KEY+PS_ENDPOINT configured');
  }

  const normalized = normalizeList(raw);
  const cnt = normalized ? normalized.trim().split(/\r?\n/).filter(Boolean).length : 0;
  await writeAtomic(DEST, normalized);
  console.log(`[proxy] wrote list → ${DEST} (count=${cnt})`);
  if (cnt < 5) console.warn('[proxy] WARN: very few proxies after normalization – check provider filters & format');
}

let refreshTimer = null;
export function startProxyRefreshLoop() {
  const min = Number(process.env.LIST_REFRESH_MIN || 60);
  if (!min || min <= 0) return;
  if (refreshTimer) return;
  console.log(`[proxy] auto-refresh every ${min} min`);
  const tick = async () => {
    try {
      await ensureProxyList();
    } catch (e) {
      console.warn('[proxy] refresh failed:', e?.message || e);
    }
  };
  refreshTimer = setInterval(tick, min * 60 * 1000);
}
