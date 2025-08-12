import fs from 'fs';
import axios from 'axios';
import { HttpProxyAgent } from 'http-proxy-agent';
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
        return 0;
    }
    const rawBase = process.env.VINTED_BASE_URL || 'https://www.vinted.de';
    const baseNoSemi = rawBase.replace(/;+$/, '');
    const HOME_URL = new URL('/', new URL(baseNoSemi)).toString();
    for (const p of proxies) {
        if (healthy.length >= 20) break;
        try {
            const proxyUrl = `http://${p}`;
            const res = await axios.get(HOME_URL, {
                proxy: false,
                httpAgent: new HttpProxyAgent(proxyUrl),
                httpsAgent: new HttpsProxyAgent(proxyUrl),
                maxRedirects: 0,
                timeout: 10000,
                headers: {
                    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
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
