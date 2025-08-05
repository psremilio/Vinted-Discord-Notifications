import { authorizedRequest } from './make-request.js';
import { authManager } from './auth-manager.js';
import { isWebUri } from 'valid-url';

// fetch cookies for the search session with no privileges
export async function fetchCookies() {
  const base = process.env.LOGIN_URL || 'https://www.vinted.de';

  if (!isWebUri(base)) {
    console.error('[auth] Ungültige LOGIN_URL:', base);
    return false;
  }

  const url = base.replace(/\/$/, '') + '/how_it_works';

  // Erst GET probieren, weil viele Hosts bei HEAD keine Cookies senden
  let res;
  try {
    res = await authorizedRequest({ method: 'GET', url, search: true });
  } catch (err) {
    console.warn('[auth] GET auf how_it_works fehlgeschlagen, versuche HEAD…');
    try {
      res = await authorizedRequest({ method: 'HEAD', url, search: true });
    } catch (err2) {
      console.error('[auth] HEAD auf how_it_works fehlgeschlagen:', err2);
      return false;
    }
  }

  const raw = res.headers['set-cookie'] || [];
  const setCookie = Array.isArray(raw) ? raw : [raw];

  if (!setCookie.length) {
    console.warn('[auth] Keine Set-Cookie-Header erhalten – überspringe Cookies-Refresh');
    return false;
  }

  try {
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
    return true;
  } catch (err) {
    console.error('[auth] Fehler beim Fetching der Cookies:', err);
    return false;
  }
}

