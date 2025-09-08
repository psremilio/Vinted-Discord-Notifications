import fs from 'fs';

export function loadProxies(
  path =
    process.env.PROXY_LIST_FILE ||
    (process.env.RAILWAY_ENVIRONMENT ? '/app/config/proxies.txt' : 'config/proxies.txt')
) {
  if (!fs.existsSync(path)) {
    throw new Error(`Proxyliste fehlt: ${path}`);
  }
  const raw = fs.readFileSync(path, 'utf8');
  const list = raw
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => /^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(s));
  const unique = [...new Set(list)];
  if (unique.length < 10) {
    console.warn(`[proxy] WARN: nur ${unique.length} Proxys erkannt – prüf Datei & Whitelist`);
  } else {
    console.log(`[proxy] Pool bereit: ${unique.length} Proxys`);
  }
  return unique;
}
