const ATTACHED = Symbol('axios_cookie_jar_attached');

function resolveUrl(url, base, fallback) {
  try {
    if (base) return new URL(url, base).toString();
  } catch {}
  try {
    if (fallback) return new URL(url, fallback).toString();
    return new URL(url).toString();
  } catch {}
  if (fallback) {
    try { return new URL(url || '', fallback).toString(); } catch {}
  }
  return null;
}

function persistCookies(jar, target, header) {
  if (!target || !header) return;
  const list = Array.isArray(header) ? header : [header];
  for (const value of list) {
    const cookie = typeof value === 'string' ? value.trim() : '';
    if (!cookie) continue;
    try { jar.setCookieSync(cookie, target); } catch {}
  }
}

export function attachCookieJar(http, jar, opts = {}) {
  if (!http || !jar) return http;
  if (http[ATTACHED]) return http;

  const baseURL = opts.baseURL ? String(opts.baseURL) : undefined;

  http.interceptors.request.use((config) => {
    try {
      const target = resolveUrl(config?.url || '', config?.baseURL, baseURL);
      if (target) {
        const cookie = jar.getCookieStringSync(target, { allPaths: true });
        if (cookie) {
          const headers = { ...(config.headers || {}) };
          if (!headers.Cookie) headers.Cookie = cookie;
          else headers.Cookie = `${headers.Cookie}; ${cookie}`;
          config.headers = headers;
        }
      }
    } catch {}
    return config;
  });

  const capture = (response) => {
    if (!response) return response;
    try {
      const cfg = response.config || {};
      const target = resolveUrl(cfg.url || '', cfg.baseURL, baseURL);
      if (target) {
        const header = response.headers?.['set-cookie'];
        persistCookies(jar, target, header);
      }
    } catch {}
    return response;
  };

  http.interceptors.response.use(
    (response) => capture(response),
    (error) => {
      if (error?.response) capture(error.response);
      throw error;
    }
  );

  try { http.defaults.jar = jar; } catch {}
  http[ATTACHED] = true;
  return http;
}

export default attachCookieJar;
