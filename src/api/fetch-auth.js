import { request } from 'undici';
import { authManager } from './auth-manager.js';

export async function fetchCookies() {
  const url = (process.env.BASE_URL || 'https://www.vinted.de').replace(/\/$/, '') + '/';
  let res;
  try {
    // Direktes GET, keine Proxies, damit wir auf jeden Fall die echten Set-Cookie-Header kriegen
    res = await request(url, { method: 'GET' });
  } catch {
    // Fallback auf HEAD
    res = await request(url, { method: 'HEAD' });
  }

  const raw = res.headers['set-cookie'];
  const lines = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  if (!lines.length) {
    console.error('[auth] Keine Set-Cookie-Header bekommen – breche ab.');
    return;
  }

  // Extrahiere gezielt die drei Token-Cookies
  const cookieObj = {};
  for (const line of lines) {
    const [pair] = line.split(';');
    const [key, val] = pair.split('=');
    if (['access_token_web','refresh_token_web','_vinted_fr_session'].includes(key)) {
      cookieObj[key] = val;
    }
  }
  await authManager.setCookies(cookieObj);
  console.log('[auth] Session-Cookies aktualisiert:', Object.keys(cookieObj).join(', '));
}
