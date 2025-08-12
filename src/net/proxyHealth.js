import fs from 'fs';
import axios from 'axios';

const healthy = [];

export async function initProxyPool() {
    // reset pool before rebuilding
    healthy.length = 0;
    const file = process.env.PROXY_LIST_FILE || 'config/proxies.txt';
    let proxies = [];
    try {
        proxies = fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter(Boolean).slice(0, 200);
    } catch (err) {
        console.warn('[proxy] proxy list not found:', err.message);
        return 0;
    }
    const base = process.env.VINTED_BASE_URL || 'https://www.vinted.de/';
    for (const p of proxies) {
        if (healthy.length >= 20) break;
        try {
            const [host, portStr] = p.split(':');
            const port = Number(portStr);
            const res = await axios.get(base, {
                proxy: { protocol: 'http', host, port },
                maxRedirects: 0,
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                },
                validateStatus: () => true,
            });
            // Consider the proxy healthy if it can reach the target and is not a hard failure
            if (typeof res.status === 'number' && res.status < 500) {
                healthy.push(p);
            }
        } catch (e) {
            // ignore invalid proxy
        }
    }
    console.log(`[proxy] Healthy: ${healthy.length}`);
    return healthy.length;
}

export function getProxy() {
    if (!healthy.length) return null;
    return healthy[Math.floor(Math.random() * healthy.length)];
}

export function markBadInPool(p) {
    const i = healthy.indexOf(p);
    if (i >= 0) healthy.splice(i, 1);
}

export function getHealthyCount() {
    return healthy.length;
}
