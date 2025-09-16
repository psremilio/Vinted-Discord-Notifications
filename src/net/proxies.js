import fs from 'fs';

const DEFAULT_PROXY_USER =
  process.env.PROXY_DEFAULT_USERNAME ||
  process.env.PROXY_USERNAME ||
  process.env.PS_PROXY_USERNAME ||
  '';

const DEFAULT_PROXY_PASS =
  process.env.PROXY_DEFAULT_PASSWORD ||
  process.env.PROXY_PASSWORD ||
  process.env.PS_PROXY_PASSWORD ||
  '';

const AUTH_MODE = (process.env.PS_AUTH_MODE || process.env.PROXY_AUTH_MODE || '').trim().toLowerCase();

function maskProxySample(str) {
  try {
    const u = new URL(str);
    if (u.username) {
      return `${u.protocol}//***@${u.hostname}:${u.port}`;
    }
    return `${u.protocol}//${u.hostname}:${u.port}`;
  } catch {
    return str;
  }
}
export function loadProxies(
  filePath =
    process.env.PROXY_LIST_FILE ||
    (process.env.RAILWAY_ENVIRONMENT ? '/app/config/proxies.txt' : 'config/proxies.txt')
) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Proxyliste fehlt: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const toUrl = (s) => {
    s = String(s || '').trim();
    if (!s || s.startsWith('#')) return null;
    // Allow: ip:port, host:port, user:pass@host:port, http(s)://user:pass@host:port
    if (!/^[a-z]+:\/\//i.test(s)) s = `http://${s}`;
    try {
      const u = new URL(s);
      if (!u.hostname || !u.port) return null;
      let user = u.username;
      let pass = u.password;
      const mode = AUTH_MODE;
      const useDefaultCreds = !user && DEFAULT_PROXY_USER && mode !== 'ip';
      if (useDefaultCreds) {
        user = DEFAULT_PROXY_USER;
        pass = DEFAULT_PROXY_PASS || '';
      }
      const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass || '')}@` : '';
      return `${u.protocol}//${auth}${u.hostname}:${u.port}`;
    } catch {
      return null;
    }
  };
  const list = raw.split(/\r?\n/).map(toUrl).filter(Boolean);
  const unique = [...new Set(list)];
  if (unique.length < 10) {
    const sampleWarn = unique.slice(0, 3).map(maskProxySample).join(', ');
    console.warn(`[proxy] WARN: nur ${unique.length} Proxys erkannt – prüf Datei & Whitelist sample=[${sampleWarn}]`);
  } else {
    const sampleInfo = unique.slice(0, 3).map(maskProxySample).join(', ');
    console.log(`[proxy] Pool bereit: ${unique.length} Proxys sample=[${sampleInfo}]`);
  }
  return unique;
}


