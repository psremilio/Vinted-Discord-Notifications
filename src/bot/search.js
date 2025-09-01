import { getHttp, rotateProxy, hedgedGet } from "../net/http.js";
import { handleParams } from "./handle-params.js";
import { dedupeKey } from "../utils/dedupe.js";
import { stats } from "../utils/stats.js";

const DEBUG_POLL = process.env.DEBUG_POLL === '1';
const TRACE = String(process.env.TRACE_SEARCH || '0') === '1';
const d = (...args) => { if (DEBUG_POLL) console.log(...args); };
const trace = (...a) => { if (TRACE) console.log('[trace]', ...a); };
const RECENT_MAX_MIN = parseInt(process.env.RECENT_MAX_MIN ?? '15', 10);
const recentMs = RECENT_MAX_MIN * 60 * 1000;

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
export const vintedSearch = async (channel, processedStore, { backfillPages = 1 } = {}) => {
    const url = new URL(channel.url);
    const ids = handleParams(url);
    const apiUrl = new URL(`https://${url.host}/api/v2/catalog/items`);
    
    // Add more randomization to the time parameter
    const timeOffset = Math.floor(Math.random() * 300) - 150; // -150 to +150 seconds
    const currentTime = Math.floor(Date.now() / 1000) + timeOffset;
    
    const baseParams = {
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
        _t: String(Date.now()),
    };
    trace('run', { rule: channel.channelName, backfillPages });

    async function fetchPage(page) {
        apiUrl.search = new URLSearchParams({ page: String(page), ...baseParams }).toString();
        try {
            const res = await hedgedGet(apiUrl.href, {
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
            }, `https://${url.host}`);
            
            const ct = String(res.headers['content-type'] || '').toLowerCase();
            if (res.status >= 200 && res.status < 300 && ct.includes('application/json')) {
              const items = Array.isArray(res.data?.items) ? res.data.items : [];
              d(`[debug][rule:${channel.channelName}] scraped=${items.length} page=${page}`);
              trace('resp', { rule: channel.channelName, page, first: items[0] && { id: items[0].id, at: items[0]?.photo?.high_resolution?.timestamp }, got: items.length });
              stats.ok += 1;
              // Optional bypass to test posting end-to-end
              if (String(process.env.DEBUG_ALLOW_ALL || '0') === '1') {
                d(`[debug][rule:${channel.channelName}] DEBUG_ALLOW_ALL=1 → bypass filters`);
                return items;
              }
              const filtered = selectNewArticles(items, processedStore, channel);
              const dedupeSkipped = items.length - filtered.length;
              trace('filter', { rule: channel.channelName, page, new_count: filtered.length, skipped_dedupe: Math.max(0, dedupeSkipped) });
              return filtered;
            }
            
            // Handle HTTP errors
            if (res.status === 401) {
                // 401 Unauthorized - rotate proxy immediately as this proxy is likely blocked
                console.warn('[search] HTTP 401 on proxy', proxy, '- rotating proxy');
                try { rotateProxy(); } catch {}
                stats.s401 += 1;
                // Add small delay to avoid overwhelming the system
                await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
                throw new Error(`HTTP ${res.status}`);
            } else if (res.status === 403) {
                // 403 Forbidden - rotate proxy as this proxy is likely rate limited
                console.warn('[search] HTTP 403 on proxy', proxy, '- rotating proxy (rate limited)');
                try { rotateProxy(); } catch {}
                stats.s403 += 1;
                // Longer delay for rate limiting
                await new Promise(resolve => setTimeout(resolve, 3000 + Math.random() * 5000));
                throw new Error(`HTTP ${res.status}`);
            } else if (res.status >= 400 && res.status < 500) {
                // Other client errors (4xx) - don't rotate proxy, just retry
                stats.s4xx += 1;
                throw new Error(`HTTP ${res.status}`);
            } else {
                // Server errors (5xx) or other issues - rotate proxy
                try { rotateProxy(); } catch {}
                stats.s5xx += 1;
                throw new Error(`HTTP ${res.status}`);
            }
        } catch (e) {
            console.warn('[search] fail', e.message || e);
            throw e; // Re-throw to trigger retry
        }
    }

    // Try with retry logic
    const RETRIES = Number(process.env.RETRIES || 3);
    const BASE = Number(process.env.EXP_BACKOFF_BASE_MS || 400);
    return await retryWithBackoff(async () => {
        const pages = Math.max(1, Number(backfillPages || 1));
        const out = [];
        for (let p = 1; p <= pages; p++) {
            const items = await fetchPage(p);
            out.push(...items);
        }
        return out;
    }, RETRIES, BASE);
};

// chooses only articles not already seen & posted in the last 10min
const selectNewArticles = (items, processedStore, channel) => {
  const titleBlacklist = Array.isArray(channel.titleBlacklist) ? channel.titleBlacklist : [];
  const cutoff = Date.now() - recentMs;
  const filteredArticles = items.filter(({ photo, id, title }) =>
    photo &&
    (photo.high_resolution?.timestamp || 0) * 1000 > cutoff &&
    !processedStore?.has?.(dedupeKey(channel.channelName, id)) &&
    !titleBlacklist.some(word => (title || '').toLowerCase().includes(word))
  );

  d(`[debug][rule:${channel.channelName}] matches=${filteredArticles.length} ` +
    `firstIds=${filteredArticles.slice(0, 5).map(x => x.id).join(',')}`);

  if (filteredArticles.length === 0 && items.length) {
    const sample = items.slice(0, 5).map(item => {
      const hasPhoto = !!item.photo;
      const tsSec = item.photo?.high_resolution?.timestamp || 0;
      const recent = tsSec * 1000 > cutoff;
      const notProcessed = !processedStore?.has?.(dedupeKey(channel.channelName, item.id));
      const notBlacklisted = !titleBlacklist.some(word => (item.title || '').toLowerCase().includes(word));
      return {
        id: item.id,
        price: item.price?.amount,
        seller: item.user?.id || item.user?.login,
        hasPhoto,
        recent,
        notProcessed,
        notBlacklisted,
      };
    });
    d(`[debug][rule:${channel.channelName}] sample_reasons=${JSON.stringify(sample)}`);
  }

  return filteredArticles;
};
