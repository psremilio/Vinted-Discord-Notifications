import { vintedSearch } from "./bot/search.js";
import { postArticles } from "./bot/post.js";
import { initProxyPool } from "./net/http.js";
import { startAutoTopUp } from "./net/proxyHealth.js";

// Map of channel names that are already scheduled.  addSearch() consults
// this via `activeSearches.has(name)` so repeated /new_search commands don't
// create duplicate timers.
const activeSearches = new Map();
// Will hold IDs of articles already processed across all searches
let processedArticleIds = new Set();
// Optional env overrides for quick testing
const OVERRIDE_SEC = Number(process.env.POLL_INTERVAL_SEC || 0);
const NO_JITTER = String(process.env.POLL_NO_JITTER || '0') === '1';

// Local cache for resolved channels to avoid repeated fetches and invalid targets
const channelCache = new Map();
const warnedMissing = new Set();

async function getChannelById(client, id) {
    if (!id) return null;
    if (channelCache.has(id)) return channelCache.get(id);
    let ch = client?.channels?.cache?.get(id) || null;
    if (!ch && client?.channels?.fetch) {
        try {
            ch = await client.channels.fetch(id);
        } catch (e) {
            // ignore; will cache as null and warn once below
        }
    }
    channelCache.set(id, ch || null);
    return ch;
}

const runSearch = async (client, channel) => {
    try {
        process.stdout.write('.');
        const articles = await vintedSearch(channel, processedArticleIds);

        //if new articles are found post them
        if (articles && articles.length > 0) {
            process.stdout.write('\n' + channel.channelName + ' => +' + articles.length);
            articles.forEach(article => { processedArticleIds.add(article.id); });
            const dest = await getChannelById(client, channel.channelId);
            if (!dest) {
                if (!warnedMissing.has(channel.channelId)) {
                    console.warn(`[post] no valid targets for ${channel.channelName} (${channel.channelId})`);
                    warnedMissing.add(channel.channelId);
                }
            } else {
                await postArticles(articles, dest, channel.channelName);
            }
        }
    } catch (err) {
        console.error('\nError running bot:', err);
    }
};

//run the search and set a timeout to run it again   
const runInterval = async (client, channel) => {
    await runSearch(client, channel);
    const baseSec = OVERRIDE_SEC > 0 ? OVERRIDE_SEC : channel.frequency;
    const factor = NO_JITTER ? 1 : (0.8 + Math.random() * 0.4);
    const delay = baseSec * 1000 * factor;
    setTimeout(() => runInterval(client, channel), delay);
};

// Attach a new search to the scheduler
const addSearch = (client, search) => {
    if (activeSearches.has(search.channelName)) return;
    activeSearches.set(search.channelName, true);
    // Log scheduling info once so you see which interval is active
    const baseSec = OVERRIDE_SEC > 0 ? OVERRIDE_SEC : search.frequency;
    console.log(
      `[schedule] ${search.channelName}: every ${baseSec}s` +
      (NO_JITTER ? '' : ' (±20% jitter)') +
      (OVERRIDE_SEC > 0 ? ' [override via POLL_INTERVAL_SEC]' : '')
    );
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

//init the article id set, then launch the simultaneous searches
export const run = async (client, mySearches) => {
    processedArticleIds = new Set();
    await initProxyPool();
    // background top-up keeps the pool filled without blocking
    startAutoTopUp();
    const REFRESH_H = parseInt(process.env.PROXY_REFRESH_HOURS || '6', 10);
    setInterval(async () => {
        try {
            console.log('[proxy] refreshing pool…');
            await initProxyPool();
        } catch (e) {
            console.warn('[proxy] refresh failed:', e.message || e);
        }
    }, REFRESH_H * 60 * 60 * 1000);

    //stagger start time for searches to avoid too many simultaneous requests
    mySearches.forEach((channel, index) => {
        setTimeout(() => addSearch(client, channel), index * 1000 + 5000);
    });

    //fetch new cookies and clean ProcessedArticleIDs at interval
    setInterval(() => {
        console.log('reducing processed articles size');
        const halfSize = Math.floor(processedArticleIds.size / 2);
        processedArticleIds = new Set([...processedArticleIds].slice(halfSize));
    }, 1 * 60 * 60 * 1000);
};

export { addSearch, activeSearches };
