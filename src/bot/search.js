import { getHttp, rotateProxy } from "../net/http.js";
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
      let http, proxy;
      try {
          ({ http, proxy } = getHttp());
      } catch (e) {
          console.warn('[search] no proxy available', e.message || e);
          return [];
      }
      try {
          const res = await http.get(apiUrl.href, {
              headers: { Referer: channel.url },
          });
          const ct = (res.headers['content-type'] || '').toLowerCase();
          if (!ct.includes('application/json')) throw new Error(`Non-JSON: ${ct}`);
          return selectNewArticles(res.data, processedArticleIds, channel);
      } catch (e) {
          console.warn('[search] fail on proxy', proxy, e.message || e);
          rotateProxy(proxy);
      }

      try {
          ({ http, proxy } = getHttp());
      } catch (e) {
          console.warn('[search] no proxy available (retry)', e.message || e);
          return [];
      }
      try {
          const res = await http.get(apiUrl.href, {
              headers: { Referer: channel.url },
          });
          const ct = (res.headers['content-type'] || '').toLowerCase();
          if (!ct.includes('application/json')) throw new Error(`Non-JSON: ${ct}`);
          return selectNewArticles(res.data, processedArticleIds, channel);
      } catch (e2) {
          console.warn('[search] retry failed on proxy', proxy, e2.message || e2);
          rotateProxy(proxy);
          return [];
      }
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
