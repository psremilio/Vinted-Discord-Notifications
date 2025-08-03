import { vintedSearch } from "./bot/search.js";
import { postArticles } from "./bot/post.js";
import { fetchCookies } from "./api/fetch-auth.js";

// Map to keep track of active searches so we don't schedule duplicates
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
    setTimeout(() => runInterval(client, channel), channel.frequency*1000);
};

// Attach a new search to the scheduler
const addSearch = (client, search) => {
    if (activeSearches.has(search.channelName)) return;
    activeSearches.set(search.channelName, true);

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
    await fetchCookies();

    //stagger start time for searches to avoid too many simultaneous requests
    mySearches.forEach((channel, index) => {
        setTimeout(() => addSearch(client, channel), index * 1000);
    });

    //fetch new cookies and clean ProcessedArticleIDs at interval    
    setInterval(async () => {
        try {
            await fetchCookies();
            console.log('reducing processed articles size');
            const halfSize = Math.floor(processedArticleIds.size / 2);
            processedArticleIds = new Set([...processedArticleIds].slice(halfSize)); //convert to an array and keep only the last half of the elements
        } catch (err) {
            console.error('\nError getting new cookies:', err);
        }
    }, 1*60*60*1000); //set interval to 1h, after which session could be expired
};

export { addSearch };
