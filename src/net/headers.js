export function buildHeaders(t = null, referer = '', origin = '') {
  const h = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (referer) h.Referer = referer;
  if (origin) h.Origin = origin;
  const includeChUa = String(process.env.HEADERS_CH_UA ?? '1') !== '0';
  if (includeChUa) {
    h['sec-ch-ua'] = '"Chromium";v="126", "Not.A/Brand";v="24", "Google Chrome";v="126"';
    h['sec-ch-ua-mobile'] = '?0';
    h['sec-ch-ua-platform'] = '"Windows"';
  }
  if (t && t.cookie) h.Cookie = t.cookie;
  if (t && t.csrf) h['X-CSRF-Token'] = t.csrf;
  return h;
}

