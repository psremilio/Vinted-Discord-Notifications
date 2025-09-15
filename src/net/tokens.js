const BASE = (process.env.VINTED_BASE_URL || process.env.LOGIN_URL || 'https://www.vinted.de').replace(/\/$/, '');

export async function ensureProxySession(client) {
  if (client?.csrf) return;
  const res = await client.http.get(BASE + '/', { timeout: 8000, validateStatus: () => true });
  let csrf = null;
  try {
    if (typeof res.data === 'string') {
      const m = res.data.match(/name=["']csrf-token["']\s+content=["']([^"']+)["']/i);
      csrf = m && m[1];
    }
  } catch {}
  if (!csrf) {
    try { csrf = res?.headers?.['x-csrf-token'] || null; } catch {}
  }
  client.csrf = csrf || null;
  // Set sane defaults
  try {
    client.http.defaults.headers.Referer = BASE + '/';
    client.http.defaults.headers.Origin = BASE;
    if (client.csrf) client.http.defaults.headers['X-CSRF-Token'] = client.csrf;
  } catch {}
}

export function withCsrf(cfg = {}, client) {
  const out = { ...(cfg || {}) };
  out.headers = { ...(cfg?.headers || {}) };
  if (client?.csrf) out.headers['X-CSRF-Token'] = client.csrf;
  out.headers['Referer'] = out.headers['Referer'] || (BASE + '/');
  out.headers['X-Requested-With'] = out.headers['X-Requested-With'] || 'XMLHttpRequest';
  return out;
}

export async function retryOnceOn401_403(fn, client) {
  let res;
  try {
    res = await fn();
    const s = Number(res?.status || 0);
    if (s !== 401 && s !== 403) return res;
  } catch (e) {
    const s = e?.response?.status;
    if (s !== 401 && s !== 403) throw e;
  }
  // First attempt hit 401/403 – reset session once and retry
  client.csrf = null;
  try {
    if (client.jar?.removeAllCookiesSync) client.jar.removeAllCookiesSync();
    else if (client.jar?.removeAllCookies) await new Promise(r => client.jar.removeAllCookies(() => r()));
  } catch {}
  try {
    await ensureProxySession(client);
  } catch {}
  return await fn();
}

// Back-compat aliases to match callers expecting tokens.ensure / retryOnce401_403
export const ensure = ensureProxySession;
export const retryOnce401_403 = retryOnceOn401_403;

export default {
  ensureProxySession,
  withCsrf,
  retryOnceOn401_403,
  // aliases
  ensure,
  retryOnce401_403,
};
