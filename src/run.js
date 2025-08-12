import { vintedSearch } from "./bot/search.js";
import { postArticles } from "./bot/post.js";
import { initProxyPool, getHttp, getProxyStatus } from "./net/http.js";

// Map of channel names that are already scheduled.  addSearch() consults
// this via `activeSearches.has(name)` so repeated /new_search commands don't
// create duplicate timers.
const activeSearches = new Map();
// Will hold IDs of articles already processed across all searches
let processedArticleIds = new Set();

const runSearch = async (client, channel) => {
    try {
        process.stdout.write('.');
        const articles = await vintedSearch(channel, processedArticleIds);

        //if new articles are found post them
        if (articles && articles.length > 0) {
            process.stdout.write('\n' + channel.channelName + ' => +' + articles.length);
            articles.forEach(article => { processedArticleIds.add(article.id); });
            await postArticles(articles, client.channels.cache.get(channel.channelId));
        }
    } catch (err) {
        console.error('\nError running bot:', err);
        
        // Check if it's a proxy-related error
        if (err.message && err.message.includes('No healthy proxies available')) {
            console.log('[search] Proxy-Problem erkannt, versuche Proxy-Pool zu erneuern...');
            try {
                await initProxyPool();
                console.log('[search] Proxy-Pool erneuert');
            } catch (proxyErr) {
                console.error('[search] Proxy-Pool Erneuerung fehlgeschlagen:', proxyErr.message);
            }
        }
    }
};

//run the search and set a timeout to run it again   
const runInterval = async (client, channel) => {
    await runSearch(client, channel);
    const delay = channel.frequency * 1000 * (0.8 + Math.random() * 0.4);
    setTimeout(() => runInterval(client, channel), delay);
};

// Attach a new search to the scheduler
const addSearch = (client, search) => {
    if (activeSearches.has(search.channelName)) return;
    activeSearches.set(search.channelName, true);
    if (process.env.NODE_ENV === 'test') {
        setTimeout(() => { runInterval(client, search); }, 1000);
        return;
    }
    (async () => {
        try {
            // ersten Poll direkt losschicken, nicht erst nach timeout
            await runSearch(client, search);
        } catch (err) {
            console.error('\nError in initializing articles:', err);
        }
        setTimeout(() => { runInterval(client, search); }, 1000);
    })();
};

//first, get cookies, then init the article id set, then launch the simmultaneous searches
export const run = async (client, mySearches) => {
    processedArticleIds = new Set();
    
    // Initialize proxy pool with retry logic
    let proxyInitSuccess = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            console.log(`[run] Initialisiere Proxy-Pool (Versuch ${attempt}/3)...`);
            await initProxyPool();
            proxyInitSuccess = true;
            break;
        } catch (e) {
            console.warn(`[run] Proxy-Pool Initialisierung fehlgeschlagen (Versuch ${attempt}/3):`, e.message);
            if (attempt < 3) {
                console.log('[run] Warte 10 Sekunden vor erneutem Versuch...');
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
        }
    }
    
    if (!proxyInitSuccess) {
        console.error('[run] Proxy-Pool Initialisierung nach 3 Versuchen fehlgeschlagen');
        if (process.env.ALLOW_DIRECT !== '1') {
            console.error('[run] ALLOW_DIRECT ist nicht gesetzt - Anwendung kann nicht ohne Proxies laufen');
        }
    }
    
    // Set up proxy refresh interval
    const REFRESH_H = parseInt(process.env.PROXY_REFRESH_HOURS || '6', 10);
    setInterval(async () => {
        try {
            console.log('[proxy] refreshing pool…');
            await initProxyPool();
            
            // Log proxy status after refresh
            const status = getProxyStatus();
            console.log(`[proxy] Status nach Refresh: ${status.availableProxies} Proxies verfügbar, Aktueller: ${status.currentProxy || 'Keiner'}`);
        } catch (e) {
            console.warn('[proxy] refresh failed:', e.message || e);
        }
    }, REFRESH_H * 60 * 60 * 1000);
    
    // Try to get initial cookies
    try {
        const { http, proxy } = getHttp();
        console.log(`[run] Verwende ${proxy} für initiale Cookie-Anfrage`);
        try {
            await http.get(process.env.VINTED_BASE_URL || 'https://www.vinted.de/');
            console.log('[run] Initiale Cookie-Anfrage erfolgreich');
        } catch (err) {
            console.error('[run] initial cookie fetch failed:', err.message);
        }
    } catch (e) {
        console.warn('[run] skip initial cookie fetch – no proxy available:', e.message);
        
        // If no proxies available and direct not allowed, try to initialize again
        if (process.env.ALLOW_DIRECT !== '1') {
            console.log('[run] Versuche Proxy-Pool erneut zu initialisieren...');
            try {
                await initProxyPool();
                const { http, proxy } = getHttp();
                await http.get(process.env.VINTED_BASE_URL || 'https://www.vinted.de/');
                console.log('[run] Cookie-Anfrage nach Proxy-Pool-Erneuerung erfolgreich');
            } catch (retryErr) {
                console.error('[run] Auch nach Proxy-Pool-Erneuerung fehlgeschlagen:', retryErr.message);
            }
        }
    }

    //stagger start time for searches to avoid too many simultaneous requests
    mySearches.forEach((channel, index) => {
        setTimeout(() => addSearch(client, channel), index * 1000 + 5000);
    });

    //fetch new cookies and clean ProcessedArticleIDs at interval
    setInterval(async () => {
        try {
            const { http, proxy } = getHttp();
            console.log(`[run] Cookie-Refresh mit ${proxy}`);
            await http.get(process.env.VINTED_BASE_URL || 'https://www.vinted.de/');
            console.log('reducing processed articles size');
            const halfSize = Math.floor(processedArticleIds.size / 2);
            processedArticleIds = new Set([...processedArticleIds].slice(halfSize));
        } catch (err) {
            console.error('[run] hourly cookie refresh skipped:', err.message);
            
            // Try to reinitialize proxy pool if this fails
            if (err.message && err.message.includes('No healthy proxies available')) {
                console.log('[run] Versuche Proxy-Pool nach Cookie-Refresh-Fehler zu erneuern...');
                try {
                    await initProxyPool();
                } catch (proxyErr) {
                    console.error('[run] Proxy-Pool Erneuerung fehlgeschlagen:', proxyErr.message);
                }
            }
        }
    }, 1*60*60*1000); //set interval to 1h, after which session could be expired
    
    // Log initial status
    const status = getProxyStatus();
    console.log(`[run] Anwendung gestartet - Proxy-Status: ${status.availableProxies} verfügbar, Direkt erlaubt: ${status.allowDirect}`);
};

export { addSearch, activeSearches };
