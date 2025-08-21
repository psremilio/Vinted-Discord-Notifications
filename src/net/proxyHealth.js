import fs from 'fs';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

const healthy = [];
const cooldown = new Map();

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
    const base = process.env.VINTED_BASE_URL || process.env.LOGIN_URL || 'https://www.vinted.de/';
    
    for (const p of proxies) {
        if (healthy.length >= 20) break;
        try {
            const [host, portStr] = p.split(':');
            const port = Number(portStr);
            
            // Create HTTPS proxy agent for proper tunneling
            const proxyAgent = new HttpsProxyAgent(`http://${host}:${port}`);
            
            const res = await axios.get(base, {
                proxy: false, // Disable axios proxy handling
                httpsAgent: proxyAgent, // Use our custom agent
                timeout: 7000,
                maxRedirects: 0,
                validateStatus: () => true,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'DNT': '1',
                    'Connection': 'keep-alive',
                }
            });
            
            // treat any <500 status (including 403/429) as reachable
            if (res.status >= 200 && res.status < 500) {
                healthy.push(p);
                console.log(`[proxy] Healthy proxy added: ${p}`);
            }
            
            // Clean up the agent
            proxyAgent.destroy();
        } catch (e) {
            // ignore invalid proxy
            console.debug(`[proxy] Proxy ${p} failed: ${e.message}`);
        }
    }
    console.log(`[proxy] Healthy proxies: ${healthy.length}`);
}

export function getProxy() {
    const now = Date.now();
    const candidates = healthy.filter(p => (cooldown.get(p) ?? 0) <= now);
    if (!candidates.length) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
}

export function markBadInPool(p) {
    const i = healthy.indexOf(p);
    if (i >= 0) healthy.splice(i, 1);
    // 15–45 minute cooldown before reusing this proxy
    cooldown.set(p, Date.now() + (15 + Math.floor(Math.random() * 30)) * 60 * 1000);
}
