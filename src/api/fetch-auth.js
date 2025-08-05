// src/api/fetch-auth.js
import { request } from 'undici';
import { authManager } from './auth-manager.js';

export async function fetchCookies() {
  const base = process.env.BASE_URL || 'https://www.vinted.de';
  const url = base.replace(/\/$/, '') + '/how_it_works';

  // 1) GET direkt
  let res;
  try {
    res = await request(url, { method: 'GET' });
  } catch {
    // 2) HEAD direkt
    res = await request(url, { method: 'HEAD' });
  }

  const raw = res.headers['set-cookie'];
  const lines = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  if (!lines.length) {
    console.error('[auth] Keine Set-Cookie-Header – breche ab');
    return;
  }

  // nur die drei wichtigen Cookies extrahieren
  const cookieObj = {};
  for (const line of lines) {
    const [pair] = line.split(';');
    const [k, v] = pair.split('=');
    if (['access_token_web','refresh_token_web','_vinted_fr_session'].includes(k)) {
      cookieObj[k] = v;
    }
  }

  await authManager.setCookies(cookieObj);
  console.log('[auth] Session-Cookies aktualisiert:', Object.keys(cookieObj).join(', '));
}
