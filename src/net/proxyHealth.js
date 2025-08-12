import fs from 'fs';
import axios from 'axios';

const healthy = [];
let lastHealthCheck = 0;
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000; // 5 Minuten

export async function initProxyPool() {
    // reset pool before rebuilding
    healthy.length = 0;
    const file = process.env.PROXY_LIST_FILE || 'config/proxies.txt';
    let proxies = [];
    try {
        proxies = fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter(Boolean).slice(0, 200);
        console.log(`[proxy] ${proxies.length} Proxies geladen`);
    } catch (err) {
        console.warn('[proxy] proxy list not found:', err.message);
        return;
    }
    
    if (proxies.length === 0) {
        console.warn('[proxy] Keine Proxies verfügbar');
        return;
    }

    const base = process.env.VINTED_BASE_URL || 'https://www.vinted.de/';
    const healthChecks = [];
    
    for (const p of proxies) {
        if (healthy.length >= 20) break;
        
        const healthCheck = checkProxyHealth(p, base).then(isHealthy => {
            if (isHealthy) {
                healthy.push(p);
                console.log(`[proxy] ${p} ist gesund`);
            }
        }).catch(() => {
            // Ignore individual proxy failures
        });
        
        healthChecks.push(healthCheck);
    }
    
    // Wait for all health checks to complete
    await Promise.allSettled(healthChecks);
    console.log(`[proxy] ${healthy.length} gesunde Proxies gefunden`);
    
    // If no healthy proxies found, try with less strict validation
    if (healthy.length === 0) {
        console.log('[proxy] Versuche weniger strenge Validierung...');
        await initProxyPoolLoose(proxies, base);
    }
}

async function checkProxyHealth(proxy, baseUrl) {
    try {
        const [host, portStr] = proxy.split(':');
        const port = Number(portStr);
        
        const res = await axios.get(baseUrl, {
            proxy: { protocol: 'http', host, port },
            maxRedirects: 0,
            timeout: 10000,
            validateStatus: () => true,
        });
        
        // Accept any response that's not a connection error
        return res.status >= 200 || res.status < 600;
    } catch (e) {
        return false;
    }
}

async function initProxyPoolLoose(proxies, baseUrl) {
    console.log('[proxy] Verwende weniger strenge Proxy-Validierung...');
    
    for (const p of proxies) {
        if (healthy.length >= 10) break;
        
        try {
            const [host, portStr] = p.split(':');
            const port = Number(portStr);
            
            // Just test if we can connect to the proxy
            const res = await axios.get('http://httpbin.org/ip', {
                proxy: { protocol: 'http', host, port },
                timeout: 8000,
                validateStatus: () => true,
            });
            
            if (res.status >= 200 && res.status < 500) {
                healthy.push(p);
                console.log(`[proxy] ${p} akzeptiert (lockere Validierung)`);
            }
        } catch (e) {
            // Ignore individual proxy failures
        }
    }
    
    console.log(`[proxy] ${healthy.length} Proxies mit lockere Validierung gefunden`);
}

export function getProxy() {
    if (!healthy.length) return null;
    
    // Rotate proxies to distribute load
    const proxy = healthy.shift();
    healthy.push(proxy);
    return proxy;
}

export function markBadInPool(badProxy) {
    const i = healthy.indexOf(badProxy);
    if (i >= 0) {
        healthy.splice(i, 1);
        console.log(`[proxy] ${badProxy} als schlecht markiert, verbleibend: ${healthy.length}`);
    }
}

export function getProxyCount() {
    return healthy.length;
}

export function isProxyAvailable() {
    return healthy.length > 0;
}
