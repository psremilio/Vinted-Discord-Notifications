import { pickUserAgent } from './proxyHealth.js';

export function getHeaders(host = 'www.vinted.de', { session = null, referer = '', origin = '' } = {}) {
  const headers = {
    'User-Agent': pickUserAgent(),
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': referer || `https://${host}/`,
    'Origin': origin || `https://${host}`,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Connection': 'keep-alive',
  };

  if (session?.cookie) headers.Cookie = session.cookie;
  if (session?.csrf) headers['X-CSRF-Token'] = session.csrf;

  return headers;
}

export function buildHeaders(session = null, referer = '', origin = '') {
  let host = 'www.vinted.de';
  try {
    const url = new URL(referer || origin || `https://${host}/`);
    if (url.hostname) host = url.hostname;
  } catch {}
  return getHeaders(host, { session, referer, origin });
}
