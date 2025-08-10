import fs from 'fs';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

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
        return;
    }
    const base = process.env.VINTED_BASE_URL || 'https://www.vinted.de/';
    for (const p of proxies) {
        if (healthy.length >= 20) break;
        try {
            const agent = new HttpsProxyAgent('http://' + p);
            const res = await axios.get(base, { httpsAgent: agent, maxRedirects: 0, validateStatus: () => true });
            const cookies = res.headers['set-cookie'];
            if (cookies && cookies.length) {
                healthy.push(p);
            }
        } catch (e) {
            // ignore invalid proxy
        }
    }
    console.log(`[proxy] Healthy: ${healthy.length}`);
}

export function getProxy() {
    if (!healthy.length) return null;
    return healthy[Math.floor(Math.random() * healthy.length)];
}

export function markBadInPool(p) {
    const i = healthy.indexOf(p);
    if (i >= 0) healthy.splice(i, 1);
}
