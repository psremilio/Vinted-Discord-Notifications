import axios from 'axios';

export async function whitelistCurrentEgressIP() {
  const tpl = process.env.PROXY_WHITELIST_URL;
  if (!tpl) return;
  try {
    const { data } = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
    const ip = data.ip;
    const url = tpl.replace('{{IP}}', ip);
    const r = await axios.get(url, { timeout: 8000 });
    console.log(`[proxy] Whitelisted ${ip} (${r.status})`);
  } catch (e) {
    console.warn('[proxy] whitelist failed:', e.message);
  }
}
