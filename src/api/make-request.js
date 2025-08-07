import fs from 'fs';
import { request, ProxyAgent } from 'undici';
import { authManager } from './auth-manager.js';

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) Firefox/127.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)'
];

const ALLOW_DIRECT = (process.env.ALLOW_DIRECT || '0') === '1';

// Only accept host:port or IP:port formats
function isValidProxy(p) {
  return /^([0-9]{1,3}\.){3}[0-9]{1,3}:\d+$/.test(p) || /^[a-zA-Z0-9.-]+:\d+$/.test(p);
}

let proxyList = [], stickyProxy = null, stickyUntil = 0;

function reloadProxies() {
  try {
    proxyList = fs.readFileSync('proxies.txt','utf-8')
                  .split('\n').map(l=>l.trim()).filter(Boolean);
  } catch {
    proxyList = [];
  }
}
reloadProxies();
fs.watchFile('proxies.txt',{interval:60_000},reloadProxies);

function getProxy() {
  const now = Date.now();
  if (stickyProxy && now < stickyUntil) return stickyProxy;
  const valid = proxyList.filter(isValidProxy);
  if (!valid.length) return null;
  stickyProxy = valid[Math.random()*valid.length|0];
  stickyUntil = now + 60_000;
  return stickyProxy;
}

export const authorizedRequest = async ({method,url,oldUrl=null,search=false,logs=true}={})=>{
  for (let attempt=0; attempt<5; ++attempt) {
    const headers = {
      'User-Agent': UAS[attempt%UAS.length],
      'Host': new URL(url).host,
      'Accept-Encoding':'gzip,deflate,br',
      'Connection':'close',
      'DNT':1
    };
    if (search) {
      const cookies = authManager.getCookies();
      headers['Cookie'] = Object.entries(cookies)
        .filter(([,v])=>v)
        .map(([k,v])=>`${k}=${v}`).join('; ');
      headers['Accept']='application/json, text/plain, */*';
      headers['Accept-Language']='de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7';
      headers['Sec-Fetch-Site']='same-site';
      headers['Sec-Fetch-Mode']='cors';
      headers['Sec-Fetch-Dest']='empty';
    }
    if (oldUrl) headers['Referer']=oldUrl;

    const proxy = getProxy();
    let dispatcher;
    if (proxy) {
      try {
        dispatcher = new ProxyAgent('http://'+proxy);
        if (logs) console.log('[req] using proxy:', proxy);
      } catch {
        console.warn('[req] Ungültiger Proxy übersprungen:', proxy);
        dispatcher = undefined;
      }
    }

    try {
      let res = await request(url,{method,headers,dispatcher,decompress:true});
      while ([301,302,307,308].includes(res.statusCode)) {
        url = res.headers.location;
        res = await request(url,{method,headers,dispatcher,decompress:true});
      }
      if (logs) console.log('[req] Content-Encoding:', res.headers['content-encoding']);
      if (res.statusCode>=200 && res.statusCode<300) {
        return res;
      }
      if ([401,403,429].includes(res.statusCode) || res.statusCode >= 500) stickyUntil = 0;
      console.warn(`[req] Status ${res.statusCode}, Retry #${attempt+1}`);
    } catch (err) {
      stickyUntil = 0;
      console.warn('[req] Request error:', err);
    }
    await new Promise(r => setTimeout(r, 500 + Math.random()*500));
  }
  if (!ALLOW_DIRECT) throw new Error('Kein Proxy hat funktioniert');
  console.warn('[req] Fallback ohne Proxy');
  let res = await request(url,{method,headers,decompress:true});
  while ([301,302,307,308].includes(res.statusCode)) {
    url = res.headers.location;
    res = await request(url,{method,headers,decompress:true});
  }
  if (logs) console.log('[req] Content-Encoding:', res.headers['content-encoding']);
  return res;
};

