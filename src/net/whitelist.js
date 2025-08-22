import axios from 'axios';

export async function whitelistCurrentEgressIP() {
  try {
    const ip = (
      await axios.get('https://api.ipify.org?format=json', { timeout: 5000 })
    ).data.ip;

    // 1) Provider URL (GET with {{IP}} placeholder)
    if (process.env.PROXY_WHITELIST_URL) {
      const url = process.env.PROXY_WHITELIST_URL.replace('{{IP}}', ip);
      const r = await axios.get(url, { timeout: 8000 });
      console.log(`[proxy] Whitelisted via URL ${ip} (${r.status})`);
      return;
    }

    // 2) ProxyScrape fallback using POST
    if (process.env.PS_API_KEY && process.env.SERVICE_ID) {
      const body = new URLSearchParams();
      body.set('auth', process.env.PS_API_KEY);
      body.set('service', process.env.SERVICE_ID);
      body.append('ip[]', ip);
      await axios.post(
        'https://api.proxyscrape.com/v2/account/datacenter_shared/whitelist',
        body.toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 8000,
        },
      );
      console.log(`[proxy] Whitelisted ${ip} on ProxyScrape`);
    }
  } catch (e) {
    console.warn('[proxy] whitelist failed:', e.message);
  }
}
