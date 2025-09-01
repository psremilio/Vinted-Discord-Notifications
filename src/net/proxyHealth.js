import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { loadProxies } from './proxies.js';

const healthy = [];
const cooldown = new Map();
const HEALTHY_CAP = Number(process.env.PROXY_HEALTHY_CAP || 60);
const TEST_CONCURRENCY = Number(process.env.PROXY_TEST_CONCURRENCY || 8);
// Fast start: return as soon as we have a minimal number of healthy proxies
const FAST_ENABLED = String(process.env.PROXY_FAST_START || '1') === '1';
const FAST_MIN = Math.max(1, Number(process.env.PROXY_FAST_START_MIN || 20));

let allProxies = [];
let scanOffset = 0;

async function testOne(p, base, stats) {
    stats.tested++;
    try {
        const [host, portStr] = p.split(':');
        const port = Number(portStr);
        const proxyAgent = new HttpsProxyAgent(`http://${host}:${port}`);
        const res = await axios.get(base, {
            proxy: false,
            httpAgent: proxyAgent,
            httpsAgent: proxyAgent,
            timeout: 7000,
            maxRedirects: 0,
            validateStatus: () => true,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7'
            }
        });
        if (res.status >= 200 && res.status < 500 && res.status !== 401) {
            if (res.status >= 200 && res.status < 300) {
                healthy.push(p);
                stats.successful++;
                console.log(`[proxy] Healthy proxy added: ${p} (status: ${res.status})`);
            } else if (res.status === 403) {
                stats.rateLimited++;
                console.log(`[proxy] Proxy ${p} responded but with status: 403 - skipping`);
            } else {
                stats.blocked++;
            }
        } else {
            stats.failed++;
        }
    } catch {
        stats.failed++;
    }
}

export async function initProxyPool() {
    healthy.length = 0;
    const started = Date.now();
    const DEADLINE_MS = Number(process.env.PROXY_INIT_DEADLINE_MS || 30000);
    const file =
        process.env.PROXY_LIST_FILE ||
        (process.env.RAILWAY_ENVIRONMENT ? '/app/config/proxies.txt' : 'config/proxies.txt');
    try {
        allProxies = loadProxies(file);
        scanOffset = 0;
        console.log(`[proxy] Loaded ${allProxies.length} proxies from ${file}`);
    } catch (err) {
        console.warn('[proxy] proxy list not found:', err.message);
        allProxies = [];
        return;
    }
    const base = process.env.VINTED_BASE_URL || process.env.LOGIN_URL || 'https://www.vinted.de/';
    console.log(`[proxy] Testing proxies against: ${base}`);

    const stats = { tested: 0, successful: 0, blocked: 0, failed: 0, rateLimited: 0 };
    while (healthy.length < HEALTHY_CAP && scanOffset < allProxies.length) {
        const batch = allProxies.slice(scanOffset, scanOffset + 200);
        scanOffset += batch.length;
        for (let i = 0; i < batch.length && healthy.length < HEALTHY_CAP; i += TEST_CONCURRENCY) {
            const slice = batch.slice(i, i + TEST_CONCURRENCY);
            await Promise.allSettled(slice.map(p => testOne(p, base, stats)));
            if (Date.now() - started > DEADLINE_MS) {
                console.log(`[proxy] init deadline reached (${DEADLINE_MS}ms), continuing fill in background`);
                setTimeout(() => { refillIfBelowCap().catch(() => {}); }, 0);
                console.log(`[proxy] Healthy proxies: ${healthy.length}`);
                return;
            }
            // Early exit for fast start: continue filling in background
            if (FAST_ENABLED && healthy.length >= Math.min(FAST_MIN, HEALTHY_CAP)) {
                console.log(`[proxy] fast-start with ${healthy.length} healthy → continue filling in background`);
                // Continue scanning asynchronously without blocking startup
                setTimeout(() => { refillIfBelowCap().catch(() => {}); }, 0);
                console.log(`[proxy] Healthy proxies: ${healthy.length}`);
                return;
            }
        }
    }
    console.log(`[proxy] Proxy test results: ${stats.tested} tested, ${stats.successful} healthy, ${stats.blocked} blocked (401), ${stats.rateLimited} rate limited (403), ${stats.failed} failed`);
    console.log(`[proxy] Healthy proxies: ${healthy.length}`);
}

async function refillIfBelowCap() {
    if (healthy.length >= HEALTHY_CAP) return;
    const file =
        process.env.PROXY_LIST_FILE ||
        (process.env.RAILWAY_ENVIRONMENT ? '/app/config/proxies.txt' : 'config/proxies.txt');
    if (!allProxies.length) {
        try {
            allProxies = loadProxies(file);
            scanOffset = 0;
        } catch {
            return;
        }
    }
    const base = process.env.VINTED_BASE_URL || process.env.LOGIN_URL || 'https://www.vinted.de/';
    const start = healthy.length;
    while (healthy.length < HEALTHY_CAP && scanOffset < allProxies.length) {
        const batch = allProxies.slice(scanOffset, scanOffset + 200);
        scanOffset += batch.length;
        for (let i = 0; i < batch.length && healthy.length < HEALTHY_CAP; i += TEST_CONCURRENCY) {
            const slice = batch.slice(i, i + TEST_CONCURRENCY);
            await Promise.allSettled(slice.map(p => testOne(p, base, {tested:0,successful:0,blocked:0,failed:0,rateLimited:0})));
        }
    }
    if (healthy.length > start) {
        console.log(`[proxy] Top-up added ${healthy.length - start} → now ${healthy.length}/${HEALTHY_CAP}`);
    }
}

export function startAutoTopUp() {
    const mins = Number(process.env.PROXY_TOPUP_MIN || 0);
    if (!mins) return;
    setInterval(() => { refillIfBelowCap().catch(() => {}); }, mins * 60 * 1000);
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
