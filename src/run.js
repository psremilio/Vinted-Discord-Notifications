import { vintedSearch } from "./bot/search.js";
import { postArticles } from "./bot/post.js";
import { initProxyPool } from "./net/http.js";
import { startAutoTopUp } from "./net/proxyHealth.js";
import { createProcessedStore, dedupeKey, ttlMs } from "./utils/dedupe.js";

// Map of channel names that are already scheduled.  addSearch() consults
// this via `activeSearches.has(name)` so repeated /new_search commands don't
// create duplicate timers. The value holds the last scheduled timeout ID.
const activeSearches = new Map(); // name -> Timeout
// In-memory processed store with TTL; keys are per-rule when configured
let processedStore = createProcessedStore();
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
        // Optional heartbeat dots (disabled by default)
        if (String(process.env.DEBUG_DOTS || '0') === '1') process.stdout.write('.');
        const articles = await vintedSearch(channel, processedStore);

        //if new articles are found post them
        if (articles && articles.length > 0) {
            console.log(`${channel.channelName} => +${articles.length}`);
            articles.forEach(article => {
              const key = dedupeKey(channel.channelName, article.id);
              processedStore.set(key, Date.now(), { ttl: ttlMs });
            });
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
    const t = setTimeout(() => runInterval(client, channel), delay);
    activeSearches.set(channel.channelName, t);
};

// Attach a new search to the scheduler
const addSearch = (client, search) => {
    if (activeSearches.has(search.channelName)) return;
    // Log scheduling info once so you see which interval is active
    const baseSec = OVERRIDE_SEC > 0 ? OVERRIDE_SEC : search.frequency;
    console.log(
      `[schedule] ${search.channelName}: every ${baseSec}s` +
      (NO_JITTER ? '' : ' (±20% jitter)') +
      (OVERRIDE_SEC > 0 ? ' [override via POLL_INTERVAL_SEC]' : '')
    );
    if (process.env.NODE_ENV === 'test') {
        const t = setTimeout(() => { runInterval(client, search); }, 1000);
        activeSearches.set(search.channelName, t);
        return;
    }
    (async () => {
        try {
            // ersten Poll direkt losschicken, nicht erst nach timeout
            await runSearch(client, search);
        } catch (err) {
            console.error('\nError in initializing articles:', err);
        }
        const t = setTimeout(() => { runInterval(client, search); }, 1000);
        activeSearches.set(search.channelName, t);
    })();
};

//init the article id set, then launch the simultaneous searches
export const run = async (client, mySearches) => {
    processedStore = createProcessedStore();
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

    // Validate configured channel IDs up-front to surface misconfig early
    try {
        await Promise.all((mySearches || []).map(async (s) => {
            const ch = await getChannelById(client, s.channelId);
            if (!ch) {
                console.warn(`[post] Warnung: Zielkanal ungültig oder nicht erreichbar für "${s.channelName}" (id=${s.channelId}).`);
            }
        }));
    } catch {}

    //stagger start time for searches to avoid too many simultaneous requests
    mySearches.forEach((channel, index) => {
        setTimeout(() => addSearch(client, channel), index * 1000 + 5000);
    });

    // Periodic cleanup of expired dedupe entries
    setInterval(() => {
        processedStore.purgeExpired();
        try {
          console.log(`[dedupe] purge expired; size=${processedStore.size()}`);
        } catch { /* ignore logging failures */ }
    }, 60 * 60 * 1000);
};

// Stop and remove a scheduled job by name, if present
function removeJob(name) {
    const t = activeSearches.get(name);
    if (!t) return false;
    try { clearTimeout(t); } catch {}
    activeSearches.delete(name);
    console.log(`[schedule] stopped ${name}`);
    return true;
}

export { addSearch, activeSearches, removeJob };
