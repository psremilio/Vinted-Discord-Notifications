import fs from 'fs';
import path from 'path';
import axios from 'axios';

const DEFAULT_FILE =
  process.env.PROXY_LIST_FILE ||
  (process.env.RAILWAY_ENVIRONMENT ? '/app/config/proxies.txt' : 'config/proxies.txt');
const FILE = DEFAULT_FILE;
// Build proxy list URL either from explicit PROXY_LIST_URL or using
// PS_API_KEY and SERVICE_ID when the variable still contains
// uninterpolated placeholders.
const URL =
  process.env.PROXY_LIST_URL && !process.env.PROXY_LIST_URL.includes('${')
    ? process.env.PROXY_LIST_URL
    : process.env.PS_API_KEY && process.env.SERVICE_ID
      ? `https://api.proxyscrape.com/v2/account/datacenter_shared/proxy-list?auth=${process.env.PS_API_KEY}&type=getproxies&protocol=http&format=txt&status=all&country=all&service=${process.env.SERVICE_ID}`
      : undefined;

export async function ensureProxyList() {
  await fs.promises.mkdir(path.dirname(FILE), { recursive: true });
  if (!URL) {
    if (fs.existsSync(FILE)) {
      const n = fs
        .readFileSync(FILE, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean).length;
      console.log(`[proxy] using existing ${FILE} (${n} entries)`);
    } else {
      console.warn(`[proxy] missing ${FILE} and PROXY_LIST_URL not set`);
    }
    return;
  }
  try {
    const { data } = await axios.get(URL, { timeout: 15000 });
    await fs.promises.writeFile(FILE, data);
    const n = String(data).split(/\r?\n/).filter(Boolean).length;
    console.log(`[proxy] downloaded list → ${FILE} (${n} entries)`);
  } catch (e) {
    console.warn('[proxy] failed to download proxy list:', e.message);
  }
}

export function startProxyRefreshLoop() {
  const mins = Number(process.env.LIST_REFRESH_MIN || 0);
  if (!URL || !mins) return;
  setInterval(() => {
    ensureProxyList().catch(() => {});
  }, mins * 60 * 1000);
}
