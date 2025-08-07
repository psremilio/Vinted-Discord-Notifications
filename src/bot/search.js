import { authorizedRequest } from "../api/make-request.js";
import { parseJsonBody } from "../utils/parse-json-body.js";
import { handleParams } from "./handle-params.js";

//send the authenticated request
export const vintedSearch = async (channel, processedArticleIds) => {
    const url = new URL(channel.url);
    const ids = handleParams(url);
    const apiUrl = new URL(`https://${url.host}/api/v2/catalog/items`);
    apiUrl.search = new URLSearchParams({
        page: '1',
        per_page: '96',
        time: Math.floor(Date.now()/1000 - Math.random()*60*3), //mimic random time, often with a delay in vinted
        search_text: ids.text,
        catalog_ids: ids.catalog,
        price_from: ids.min,
        price_to: ids.max,
        currency: ids.currency,
        order: 'newest_first',
        size_ids: ids.size,
        brand_ids: ids.brand,
        status_ids: ids.status,
        color_ids: ids.colour,
        material_ids: ids.material,
    }).toString();
    let res;
    try {
        res = await authorizedRequest({method: "GET", url: apiUrl.href, oldUrl: channel.url, search: true, logs: false});
    } catch (err) {
        console.error('[search] Proxy-Request fehlgeschlagen:', err);
        return [];
    }
    const ct = (res.headers['content-type'] || '').toLowerCase();
    if (!ct.includes('application/json')) {
        console.warn('[search] Non-JSON response:', ct);
        return [];
    }
    const responseData = await parseJsonBody(res);
    const articles = selectNewArticles(responseData, processedArticleIds, channel);
    return articles;
};

//chooses only articles not already seen & posted in the last 10min
const selectNewArticles = (articles, processedArticleIds, channel) => {
    const items = Array.isArray(articles.items) ? articles.items : [];
    const titleBlacklist = Array.isArray(channel.titleBlacklist) ? channel.titleBlacklist : [];
    const filteredArticles = items.filter(({ photo, id, title }) => 
      photo && 
      photo.high_resolution.timestamp * 1000 >  Date.now() - (1000 * 60 * 10) && 
      !processedArticleIds.has(id) &&
      !titleBlacklist.some(word => title.toLowerCase().includes(word))
    );
    return filteredArticles;
  };
