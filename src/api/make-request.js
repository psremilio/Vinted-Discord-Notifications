import fs from 'fs';
import { request, ProxyAgent } from 'undici';
import { authManager } from './auth-manager.js';

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) Firefox/127.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)'
];

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
      headers['Accept']='application/json';
    }
    if (oldUrl) headers['Referer']=oldUrl;

    // nur für echte Such-Requests rotierende Proxys einsetzen
    let dispatcher;
    if (search) {
      const p = getProxy();
      if (p) dispatcher = new ProxyAgent('http://'+p);
    }

    // undici: aktiviere automatische Dekompression
    // (Standard ist off, weshalb wir rohe gzip/br Bytes kriegen)
    let res = await request(url, {
      method,
      headers,
      dispatcher,
      decompress: true,
    });

    while ([301,302,307,308].includes(res.statusCode)) {
      url = res.headers.location;
      res = await request(url,{method,headers,dispatcher,decompress: true});
    }
    if (res.statusCode>=200 && res.statusCode<300) {
      return res;
    }
    console.warn(`[req] Status ${res.statusCode}, Retry #${attempt+1}`);
    stickyUntil = 0;
  }
  throw 'Kein Proxy hat funktioniert';
};

