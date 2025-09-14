import fs from 'fs/promises';
import path from 'path';

// Simple token manager that leverages the existing proxy-aware bootstrap in http.js
// Persists tokens per host in a JSON file so sessions can survive restarts.

const DEFAULT_STORE = process.env.TOKEN_PERSIST_PATH || path.resolve('./data/tokens.json');
const BOOT_TTL_MS = Math.max(5 * 60_000, Number(process.env.TOKEN_BOOTSTRAP_TTL_MS || 45 * 60_000)); // default 45min

async function readStore() {
  try {
    const raw = await fs.readFile(DEFAULT_STORE, 'utf-8');
    return JSON.parse(raw) || {};
  } catch { return {}; }
}

async function writeStore(obj) {
  try {
    await fs.mkdir(path.dirname(DEFAULT_STORE), { recursive: true });
    await fs.writeFile(DEFAULT_STORE, JSON.stringify(obj, null, 2));
  } catch {}
}

export async function ensure(host, opts = {}) {
  const allowDirect = opts.allowDirect ?? (String(process.env.TOKEN_BOOTSTRAP_ALLOW_DIRECT || '1') === '1');
  const key = String(host || '').replace(/^https?:\/\//i, '').replace(/\/$/, '');
  if (!key) throw new Error('tokens.ensure: host required');
  const store = await readStore();
  const now = Date.now();
  const ent = store[key];
  if (ent && (!ent.expiresAt || Number(ent.expiresAt) > now)) return ent;

  // Bootstrap via existing proxy-aware client and reuse its cookies/csrf
  const base = `https://${key}`;
  try {
    const { getHttp } = await import('./http.js');
    const { http } = await getHttp(base);
    // bootstrapSession() inside getHttp already primed defaults with cookies/csrf
    const cookie = http?.defaults?.headers?.Cookie || http?.defaults?.headers?.cookie || '';
    const csrf = http?.defaults?.headers?.['X-CSRF-Token'] || http?.defaults?.headers?.['x-csrf-token'] || '';
    const info = { cookie, csrf: csrf || undefined, fetchedAt: now, expiresAt: now + BOOT_TTL_MS };
    store[key] = info;
    await writeStore(store);
    try { console.log('[token.bootstrap.ok]', key); } catch {}
    return info;
  } catch (e) {
    if (!allowDirect) throw e;
    // Fallback: direct bootstrap without proxy
    try {
      const { default: axios } = await import('axios');
      const res = await axios.get(base, { proxy: false, timeout: 10000, validateStatus: () => true, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const setCookie = res.headers?.['set-cookie'] || [];
      const cookie = setCookie.map(c => c.split(';')[0]).join('; ');
      const m = (typeof res.data === 'string') ? res.data.match(/name="csrf-token"\s+content="([^"]+)"/i) : null;
      const csrf = m && m[1];
      const info = { cookie, csrf: csrf || undefined, fetchedAt: now, expiresAt: now + BOOT_TTL_MS };
      store[key] = info;
      await writeStore(store);
      try { console.log('[token.bootstrap.direct.ok]', key); } catch {}
      return info;
    } catch (e2) {
      try { console.warn('[token.bootstrap.fail]', key, e2?.message || e2); } catch {}
      throw e2;
    }
  }
}

export async function expire(host) {
  const key = String(host || '').replace(/^https?:\/\//i, '').replace(/\/$/, '');
  if (!key) return;
  const store = await readStore();
  if (store[key]) {
    delete store[key];
    await writeStore(store);
    try { console.log('[token.expire]', key); } catch {}
  }
}

export async function get(host) {
  const key = String(host || '').replace(/^https?:\/\//i, '').replace(/\/$/, '');
  const store = await readStore();
  return store[key] || null;
}

