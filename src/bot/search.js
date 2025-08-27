import { getHttp, rotateProxy } from "../net/http.js";
import { handleParams } from "./handle-params.js";

// Retry with exponential backoff
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) throw error;
      
      // Add randomization to avoid predictable patterns
      const jitter = 0.5 + Math.random() * 0.5; // 0.5x to 1.0x multiplier
      const delay = (baseDelay * Math.pow(2, attempt) + Math.random() * 1000) * jitter;
      console.log(`[search] attempt ${attempt + 1} failed, retrying in ${Math.round(delay)}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

//send the authenticated request
export const vintedSearch = async (channel, processedArticleIds) => {
    const url = new URL(channel.url);
    const ids = handleParams(url);
    const apiUrl = new URL(`https://${url.host}/api/v2/catalog/items`);
    
    // Add more randomization to the time parameter
    const timeOffset = Math.floor(Math.random() * 300) - 150; // -150 to +150 seconds
    const currentTime = Math.floor(Date.now() / 1000) + timeOffset;
    
    apiUrl.search = new URLSearchParams({
        page: '1',
        per_page: '96',
        time: currentTime,
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

    // Try with retry logic
    return await retryWithBackoff(async () => {
        let http, proxy;
        try {
            ({ http, proxy } = await getHttp(`https://${url.host}`));
        } catch (e) {
            console.warn('[search] no proxy available', e.message || e);
            return [];
        }

        try {
            // Add random delay before request to avoid predictable patterns
            const randomDelay = Math.random() * 2000 + 1000; // 1-3 seconds
            await new Promise(resolve => setTimeout(resolve, randomDelay));
            
            const res = await http.get(apiUrl.href, {
                // emulate a real browser request so Cloudflare is less likely to block us
                headers: {
                  'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                  'Accept': 'application/json, text/plain, */*',
                  'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
                  'Accept-Encoding': 'gzip, deflate, br',
                  'DNT': '1',
                  'Connection': 'keep-alive',
                  'Referer': channel.url,
                  'Origin': `https://${url.host}`,
                  'Sec-Fetch-Dest': 'empty',
                  'Sec-Fetch-Mode': 'cors',
                  'Sec-Fetch-Site': 'same-origin',
                  'Cache-Control': 'no-cache',
                  'Pragma': 'no-cache',
                  'X-Requested-With': 'XMLHttpRequest',
                  'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                  'sec-ch-ua-mobile': '?0',
                  'sec-ch-ua-platform': '"Windows"',
                },
                validateStatus: () => true,
            });
            
            const ct = String(res.headers['content-type'] || '').toLowerCase();
            if (res.status >= 200 && res.status < 300 && ct.includes('application/json')) {
              return selectNewArticles(res.data, processedArticleIds, channel);
            }
            
            // Handle HTTP errors
            if (res.status === 401) {
                // 401 Unauthorized - rotate proxy immediately as this proxy is likely blocked
                console.warn('[search] HTTP 401 on proxy', proxy, '- rotating proxy');
                rotateProxy(proxy);
                // Add small delay to avoid overwhelming the system
                await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
                throw new Error(`HTTP ${res.status}`);
            } else if (res.status === 403) {
                // 403 Forbidden - rotate proxy as this proxy is likely rate limited
                console.warn('[search] HTTP 403 on proxy', proxy, '- rotating proxy (rate limited)');
                rotateProxy(proxy);
                // Longer delay for rate limiting
                await new Promise(resolve => setTimeout(resolve, 3000 + Math.random() * 5000));
                throw new Error(`HTTP ${res.status}`);
            } else if (res.status >= 400 && res.status < 500) {
                // Other client errors (4xx) - don't rotate proxy, just retry
                throw new Error(`HTTP ${res.status}`);
            } else {
                // Server errors (5xx) or other issues - rotate proxy
                rotateProxy(proxy);
                throw new Error(`HTTP ${res.status}`);
            }
        } catch (e) {
            console.warn('[search] fail on proxy', proxy, e.message || e);
            throw e; // Re-throw to trigger retry
        }
    }, 3, 5000); // 3 retries with 5s base delay (longer for rate limiting)
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
