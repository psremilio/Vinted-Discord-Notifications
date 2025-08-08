import { request } from 'undici';
import { authManager } from './auth-manager.js';
// keine ProxyAgent-Abhängigkeit hier

export async function fetchCookies() {
  const base = process.env.BASE_URL || 'https://www.vinted.de';
  const url  = base.replace(/\/$/, '') + '/how_it_works';

  // 1) Erst mal HEAD direkt
  let res;
  try {
    res = await request(url, { method: 'HEAD' });
  } catch {
    // 2) Fallback auf GET, falls manche Hosts HEAD nicht unterstützen
    res = await request(url, { method: 'GET' });
  }

  // Jetzt die Set-Cookie-Header rausholen
  const raw = res.headers['set-cookie'];               // kann string oder array sein
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  if (!arr.length) {
    console.error('[auth] Keine Set-Cookie-Header erhalten — breche ab');
    return;
  }

  // Nur die für Vinted relevanten Cookies extrahieren
  const cookieObj = {};
  for (const line of arr) {
    const [pair] = line.split(';');
    const [k,v]    = pair.split('=');
    if (['access_token_web','refresh_token_web','_vinted_fr_session'].includes(k)) {
      cookieObj[k] = v;
    }
  }
  await authManager.setCookies(cookieObj);
  console.log('[auth] Session-Cookies aktualisiert:', Object.keys(cookieObj).join(', '));
}
