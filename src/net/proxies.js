import fs from 'fs';

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
      const auth = u.username ? `${encodeURIComponent(u.username)}:${encodeURIComponent(u.password || '')}@` : '';
      return `${u.protocol}//${auth}${u.hostname}:${u.port}`;
    } catch {
      return null;
    }
  };
  const list = raw.split(/\r?\n/).map(toUrl).filter(Boolean);
  const unique = [...new Set(list)];
  if (unique.length < 10) {
    console.warn(`[proxy] WARN: nur ${unique.length} Proxys erkannt – prüf Datei & Whitelist`);
  } else {
    console.log(`[proxy] Pool bereit: ${unique.length} Proxys`);
  }
  return unique;
}
