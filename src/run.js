import { vintedSearch } from "./bot/search.js";
import { postArticles } from "./bot/post.js";
import { initProxyPool } from "./net/http.js";
import { startAutoTopUp } from "./net/proxyHealth.js";

// Map of channel names that are already scheduled.  addSearch() consults
// this via `activeSearches.has(name)` so repeated /new_search commands don't
// create duplicate timers.
const activeSearches = new Map();
// Runtime registry of polling jobs: key -> { timer, channel, cancelled }
const jobs = new Map();
// Will hold IDs of articles already processed across all searches
let processedArticleIds = new Set();
// Optional env overrides for quick testing
const OVERRIDE_SEC = Number(process.env.POLL_INTERVAL_SEC || 0);
const NO_JITTER = String(process.env.POLL_NO_JITTER || '0') === '1';

// Simple key normalization helpers for mapping aliases
const normKey = s => String(s ?? '').toLowerCase().trim().replace(/\s+/g, '').replace(/-+/g, '-');
const singularFallback = k => k.replace(/s$/, '');

// Optional mapping: filter label -> channelId, populated from config
const CHANNEL_BY_FILTER = new Map();

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
            let dest = await getChannelById(client, channel.channelId);
            if (!dest) {
                // Try alias mapping based on channel name
                const key = normKey(channel.channelName);
                const altId = CHANNEL_BY_FILTER.get(key) || CHANNEL_BY_FILTER.get(singularFallback(key));
                if (altId && altId !== channel.channelId) {
                    dest = await getChannelById(client, altId);
                }
                if (!dest) {
                    const warnKey = `${channel.channelName}:${channel.channelId}`;
                    if (!warnedMissing.has(warnKey)) {
                        console.warn(`[post] no valid targets for ${channel.channelName} (${channel.channelId})`);
                        warnedMissing.add(warnKey);
                    }
                }
            }
            if (dest) {
                await postArticles(articles, dest);
            }
        }
    } catch (err) {
        console.error('\nError running bot:', err);
    }
};

//run the search and set a timeout to run it again   
const runInterval = async (client, channel) => {
    const key = channel.channelName;
    const current = jobs.get(key);
    if (current?.cancelled) return;

    await runSearch(client, channel);

    const latest = jobs.get(key);
    if (!latest || latest.cancelled) return;
    const baseSec = OVERRIDE_SEC > 0 ? OVERRIDE_SEC : channel.frequency;
    const factor = NO_JITTER ? 1 : (0.8 + Math.random() * 0.4);
    const delay = baseSec * 1000 * factor;
    const timer = setTimeout(() => runInterval(client, channel), delay);
    jobs.set(key, { ...latest, timer });
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
    // initialize registry entry
    jobs.set(search.channelName, { timer: null, channel: search, cancelled: false });
    if (process.env.NODE_ENV === 'test') {
        const t = setTimeout(() => { runInterval(client, search); }, 1000);
        jobs.set(search.channelName, { timer: t, channel: search, cancelled: false });
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
        jobs.set(search.channelName, { timer: t, channel: search, cancelled: false });
    })();
};

// Stop a running job by key (channelName). Returns true if a job was found and stopped.
function removeJob(key) {
    const k = String(key);
    const job = jobs.get(k);
    if (!job) return false;
    if (job.timer) {
        try { clearTimeout(job.timer); } catch {}
    }
    job.cancelled = true;
    jobs.delete(k);
    activeSearches.delete(k);
    return true;
}

//init the article id set, then launch the simultaneous searches
export const run = async (client, mySearches) => {
    processedArticleIds = new Set();
    // Populate mapping for alias lookups
    try {
        CHANNEL_BY_FILTER.clear();
        for (const s of mySearches || []) {
            const k = normKey(s.channelName);
            if (s.channelId) {
                if (!CHANNEL_BY_FILTER.has(k)) CHANNEL_BY_FILTER.set(k, s.channelId);
                const sing = singularFallback(k);
                if (!CHANNEL_BY_FILTER.has(sing)) CHANNEL_BY_FILTER.set(sing, s.channelId);
            }
        }
    } catch {}
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

export { addSearch, activeSearches, removeJob, jobs };
