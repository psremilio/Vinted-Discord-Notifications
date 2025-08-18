import { vintedSearch } from "./bot/search.js";
import { postArticles } from "./bot/post.js";
import { initProxyPool, getHttp } from "./net/http.js";

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
    await initProxyPool();
    const REFRESH_H = parseInt(process.env.PROXY_REFRESH_HOURS || '6', 10);
    setInterval(async () => {
        try {
            console.log('[proxy] refreshing pool…');
            await initProxyPool();
        } catch (e) {
            console.warn('[proxy] refresh failed:', e.message || e);
        }
    }, REFRESH_H * 60 * 60 * 1000);
    try {
        const { http } = await getHttp();
        try {
            await http.get(
                process.env.VINTED_BASE_URL || process.env.LOGIN_URL || 'https://www.vinted.de/',
                { validateStatus: () => true }
            );
        } catch (err) {
            console.error('[run] initial cookie fetch failed:', err);
        }
    } catch (e) {
        console.warn('[run] skip initial cookie fetch – no proxy available:', e.message || e);
    }

    //stagger start time for searches to avoid too many simultaneous requests
    mySearches.forEach((channel, index) => {
        setTimeout(() => addSearch(client, channel), index * 1000 + 5000);
    });

    //fetch new cookies and clean ProcessedArticleIDs at interval
    setInterval(async () => {
        try {
            const { http } = await getHttp();
            await http.get(
                process.env.VINTED_BASE_URL || process.env.LOGIN_URL || 'https://www.vinted.de/',
                { validateStatus: () => true }
            );
            console.log('reducing processed articles size');
            const halfSize = Math.floor(processedArticleIds.size / 2);
            processedArticleIds = new Set([...processedArticleIds].slice(halfSize));
        } catch (err) {
            console.error('[run] hourly cookie refresh skipped:', err.message || err);
        }
    }, 1*60*60*1000); //set interval to 1h, after which session could be expired
};

export { addSearch, activeSearches };
