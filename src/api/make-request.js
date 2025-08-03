import fs from 'fs';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { request } from 'undici';

import { authManager } from './auth-manager.js';

const UAS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) Firefox/127.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)'
];

let proxyList = [];
function loadProxyList() {
    try {
        proxyList = fs.readFileSync('proxies.txt', 'utf-8')
            .split('\n').map(l => l.trim()).filter(Boolean);
    } catch {
        proxyList = [];
    }
}
loadProxyList();
fs.watchFile('proxies.txt', { interval: 60_000 }, loadProxyList);

let stickyProxy = null, stickyUntil = 0;
function getProxy() {
    const now = Date.now();
    if (stickyProxy && now < stickyUntil) return stickyProxy;
    if (!proxyList.length) return null;
    stickyProxy = proxyList[Math.random() * proxyList.length | 0];
    stickyUntil = now + 60_000; // 60s kleben
    return stickyProxy;
}

//general function to make an authorized request
export const authorizedRequest = async ({
    method,
    url,
    oldUrl = null,
    search = false,
    logs = true
} = {}) => {
    try {
        for (let attempt = 0; attempt < 5; attempt++) {
            const headers = {
                "User-Agent": UAS[Math.random() * UAS.length | 0],
                "Host": new URL(url).host,
                "Accept-Encoding": "gzip, deflate, br, zstd",
                "Connection": "close",
                "TE": "trailers",
                "DNT": 1
            };

            if (search) { //cookies from cookies.json
                const cookies = authManager.getCookies();
                headers["Cookie"] = Object.entries(cookies)
                    .filter(([, value]) => value)
                    .map(([key, value]) => `${key}=${value}`)
                    .join('; ');
                headers["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
                headers["Accept-Language"] = "en-US,en;q=0.5";
                headers["Priority"] = "u=0, i";
                headers["Sec-Fetch-Dest"] = "document";
                headers["Sec-Fetch-Mode"] = "navigate";
                headers["Sec-Fetch-Site"] = "cross-site";
                headers["Upgrade-Insecure-Requests"] = "1";
            }
            if (logs) {
                console.log("making an authed request to " + url);
            }

            const proxy = getProxy();
            const dispatcher = proxy ? new HttpsProxyAgent('http://' + proxy) : undefined;
            if (oldUrl) {
                headers["Referer"] = oldUrl;
            }

            let response = await request(url, { method, headers, dispatcher });

            while ([301, 302, 303, 307, 308].includes(response.statusCode)) {
                const newUrl = response.headers.location || response.headers.Location;
                console.log(`redirected to ${newUrl}`);
                response = await request(newUrl, { method, headers, dispatcher });
            }

            const ctype = response.headers['content-type'] || '';
            if (response.statusCode === 403 || ctype.includes('text/html')) {
                stickyUntil = 0; // next attempt gets a new proxy
                continue;
            }
            if (response.statusCode < 200 || response.statusCode >= 300) {
                throw `HTTP status: ${response.statusCode}`;
            }
            return response;
        }
        throw 'No proxy succeeded';
    } catch (error) {
        throw "While making request: " + error;
    }
};
