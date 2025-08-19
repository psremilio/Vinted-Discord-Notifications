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
          ({ http, proxy } = await getHttp());
      } catch (e) {
          console.warn('[search] no proxy available', e.message || e);
          return [];
      }
      try {
          const res = await http.get(apiUrl.href, {
              // emulate a real browser request so Cloudflare is less likely to block us
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Referer': channel.url,
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'same-origin',
                'TE': 'trailers',
              },
              validateStatus: () => true,
          });
          const ct = String(res.headers['content-type'] || '').toLowerCase();
          if (res.status >= 200 && res.status < 300 && ct.includes('application/json')) {
            return selectNewArticles(res.data, processedArticleIds, channel);
          }
          throw new Error(`HTTP ${res.status}`);
      } catch (e) {
          console.warn('[search] fail on proxy', proxy, e.message || e);
          const status = Number((e.message || '').replace('HTTP ', ''));
          if (!(status >= 400 && status < 500)) {
            rotateProxy(proxy);
          }
      }

      try {
          ({ http, proxy } = await getHttp());
      } catch (e) {
          console.warn('[search] no proxy available (retry)', e.message || e);
          return [];
      }
      try {
          const res = await http.get(apiUrl.href, {
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Referer': channel.url,
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'same-origin',
                'TE': 'trailers',
              },
              validateStatus: () => true,
          });
          const ct = String(res.headers['content-type'] || '').toLowerCase();
          if (res.status >= 200 && res.status < 300 && ct.includes('application/json')) {
            return selectNewArticles(res.data, processedArticleIds, channel);
          }
          throw new Error(`HTTP ${res.status}`);
      } catch (e2) {
          console.warn('[search] retry failed on proxy', proxy, e2.message || e2);
          const status = Number((e2.message || '').replace('HTTP ', ''));
          if (!(status >= 400 && status < 500)) {
            rotateProxy(proxy);
          }
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
