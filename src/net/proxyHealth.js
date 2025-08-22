import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { loadProxies } from './proxies.js';

const healthy = [];
const cooldown = new Map();

export async function initProxyPool() {
    // reset pool before rebuilding
    healthy.length = 0;
    const file = process.env.PROXY_LIST_FILE || '/app/config/proxies.txt';
    let proxies = [];
    try {
        proxies = loadProxies(file).slice(0, 200);
        console.log(`[proxy] Loaded ${proxies.length} proxies from ${file}`);
    } catch (err) {
        console.warn('[proxy] proxy list not found:', err.message);
        return;
    }
    const base = process.env.VINTED_BASE_URL || process.env.LOGIN_URL || 'https://www.vinted.de/';
    console.log(`[proxy] Testing proxies against: ${base}`);
    
    let tested = 0;
    let successful = 0;
    let blocked = 0;
    let failed = 0;
    let rateLimited = 0;
    
    for (const p of proxies) {
        if (healthy.length >= 60) break;
        tested++;
        try {
            const [host, portStr] = p.split(':');
            const port = Number(portStr);
            
            // Create HTTPS proxy agent for proper tunneling
            const proxyAgent = new HttpsProxyAgent(`http://${host}:${port}`);
            
            // Add random delay between proxy tests to avoid overwhelming
            if (tested > 1) {
                await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 500));
            }
            
            const res = await axios.get(base, {
                proxy: false, // Disable axios proxy handling
                httpAgent: proxyAgent,
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
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                    'sec-ch-ua-mobile': '?0',
                    'sec-ch-ua-platform': '"Windows"',
                }
            });
            
            // treat any <500 status (including 403/429) as reachable, but exclude 401
            if (res.status >= 200 && res.status < 500 && res.status !== 401) {
                // Only accept proxies with good response codes (200, 201, 202, 204)
                // 403 responses indicate rate limiting, which might make the proxy unreliable
                if (res.status >= 200 && res.status < 300) {
                    healthy.push(p);
                    successful++;
                    console.log(`[proxy] Healthy proxy added: ${p} (status: ${res.status})`);
                } else {
                    // Log proxies that respond but with client errors
                    console.debug(`[proxy] Proxy ${p} responded but with status: ${res.status} - skipping`);
                }
            } else if (res.status === 401) {
                blocked++;
                console.debug(`[proxy] Proxy ${p} returned 401 - likely blocked`);
            } else if (res.status === 403) {
                rateLimited++;
                console.debug(`[proxy] Proxy ${p} returned 403 - rate limited`);
            } else {
                failed++;
                console.debug(`[proxy] Proxy ${p} failed with status: ${res.status}`);
            }
            
            // Clean up the agent
            proxyAgent.destroy();
        } catch (e) {
            failed++;
            // ignore invalid proxy
            console.debug(`[proxy] Proxy ${p} failed: ${e.message}`);
        }
    }
    
    console.log(`[proxy] Proxy test results: ${tested} tested, ${successful} healthy, ${blocked} blocked (401), ${rateLimited} rate limited (403), ${failed} failed`);
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
