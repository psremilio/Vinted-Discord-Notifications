import { authorizedRequest } from './make-request.js';
import { authManager } from './auth-manager.js';
import { isWebUri } from 'valid-url';

// fetch cookies for the search session with no privileges
export async function fetchCookies() {
  const base = process.env.LOGIN_URL || 'https://www.vinted.de';

  if (!isWebUri(base)) {
    console.error('[auth] Ungültige LOGIN_URL:', base);
    return;
  }

  const url = base.replace(/\/$/, '') + '/';

  try {
    const res = await authorizedRequest({ method: 'GET', url, search: true });
    const raw = res.headers['set-cookie'] || [];
    const setCookie = Array.isArray(raw) ? raw : [raw];
    if (!setCookie.length) throw 'Keine Set-Cookie-Header';
    const cookies = setCookie
      .map(c => c.split(';')[0].trim())
      .filter(Boolean);
    const cookieObj = {};
    cookies.forEach(c => {
      const [k, v] = c.split('=');
      cookieObj[k] = v;
    });
    await authManager.setCookies(cookieObj);
    console.log('[auth] Cookies aktualisiert');
  } catch (err) {
    console.error('[auth] Fehler beim Fetching der Cookies:', err);
  }
}

