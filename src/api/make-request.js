import fs from 'fs';
import { HttpsProxyAgent } from 'https-proxy-agent';

import { authManager } from './auth-manager.js';

const UAS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) Firefox/127.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)'
];

let stickyProxy = null, stickyUntil = 0;
function getProxy() {
    const now = Date.now();
    if (stickyProxy && now < stickyUntil) return stickyProxy;
    const list = fs.readFileSync('proxies.txt', 'utf-8').split('\n').map(l => l.trim()).filter(Boolean);
    if (!list.length) return null;
    stickyProxy = list[Math.random() * list.length | 0];
    stickyUntil = now + 60_000; // 60s
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
            const options = { method, headers };
            if (proxy) options.agent = new HttpsProxyAgent('http://' + proxy);
            if (oldUrl) {
                options.headers["Referer"] = oldUrl;
            }

            let response = await fetch(url, options);

            while ([301, 302, 303, 307, 308].includes(response.status)) {
                const newUrl = response.headers.get('Location');
                console.log(`redirected to ${newUrl}`);
                response = await fetch(newUrl, options);
            }

            if (response.status === 403 || response.headers.get('Content-Type')?.includes('text/html')) {
                stickyUntil = 0; // next attempt gets a new proxy
                continue;
            }
            if (!response.ok) {
                throw `HTTP status: ${response.status}`;
            }
            return await response.json();
        }
        throw 'No proxy succeeded';
    } catch (error) {
        throw "While making request: " + error;
    }
};
