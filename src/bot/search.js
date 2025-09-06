import { fetchRule, hedgedGet } from "../net/http.js";
import { handleParams } from "./handle-params.js";
import { dedupeKeyForChannel } from "../utils/dedupe.js";
import { buildFamilyKeyFromURL, canonicalizeUrl } from "../rules/urlNormalizer.js";
import { stats } from "../utils/stats.js";
import { state, markFetchAttempt, markFetchSuccess, markFetchError, recordSoftFail } from "../state.js";
import { metrics } from "../infra/metrics.js";

const DEBUG_POLL = process.env.DEBUG_POLL === '1';
const TRACE = String(process.env.TRACE_SEARCH || '0') === '1';
const d = (...args) => { if (DEBUG_POLL || String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log(...args); };
const trace = (...a) => { if (TRACE) console.log('[trace]', ...a); };
const RECENT_MAX_MIN = parseInt(process.env.RECENT_MAX_MIN ?? '15', 10);
const recentMs = RECENT_MAX_MIN * 60 * 1000;
const DISABLE_RECENT = String(process.env.DISABLE_RECENT_FILTER || '0') === '1';
const firstAgeByRule = new Map(); // rule -> number[]
function recordFirstAge(rule, ms) {
  try {
    let arr = firstAgeByRule.get(rule);
    if (!arr) { arr = []; firstAgeByRule.set(rule, arr); }
    arr.push(ms);
    if (arr.length > 300) arr.shift();
    const a = arr.slice().sort((x,y)=>x-y);
    const p95 = a[Math.min(a.length - 1, Math.floor(a.length * 0.95))];
    metrics.first_age_ms_p95?.set({ rule: String(rule) }, p95);
  } catch {}
}

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
    
    
        time: 'now',
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
            const t0 = Date.now();
            markFetchAttempt();
            // Enable hedged requests by default to cut tail latency across proxies
            const USE_HEDGE = String(process.env.SEARCH_HEDGE || '1') === '1';
            let result;
            if (USE_HEDGE) {
              try {
                // Hedged fetch across proxies for lower tail latency
                const res = await hedgedGet(apiUrl.href, {
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
                }
                }, `https://${url.host}`);
                result = { ok: res && res.status >= 200 && res.status < 300, res };
              } catch (e) {
                // Fallback to sticky fetchRule rather than failing the page
                result = await fetchRule(channel.channelName, apiUrl.href, {
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
                });
              }
            } else {
              result = await fetchRule(channel.channelName, apiUrl.href, {
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
              });
            }
            if (result?.skipped) {
              // token not available → skip this slot without error
              return [];
            }
            if (result?.softFail) {
              // soft failure counted by controller → no retry within this page
              try { recordSoftFail(channel.channelName); } catch {}
              return [];
            }
            const res = result.res;
            
            const ct = String(res.headers['content-type'] || '').toLowerCase();
            if (res.status >= 200 && res.status < 300 && ct.includes('application/json')) {
              const items = Array.isArray(res.data?.items) ? res.data.items : [];
              d(`[debug][rule:${channel.channelName}] scraped=${items.length} page=${page} canonical_url=${canonicalizeUrl(channel.url)}`);
              trace('resp', { rule: channel.channelName, page, first: items[0] && { id: items[0].id, at: items[0]?.photo?.high_resolution?.timestamp }, got: items.length });
              const dur = Date.now() - t0;
              stats.ok += 1;
              markFetchSuccess(dur, res.status);
              // Optional bypass to test posting end-to-end
              if (String(process.env.DEBUG_ALLOW_ALL || '0') === '1') {
                d(`[debug][rule:${channel.channelName}] DEBUG_ALLOW_ALL=1 → bypass filters`);
                return items;
              }
              let filtered = selectNewArticles(items, processedStore, channel);
              if ((DEBUG_POLL || String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') && filtered.length) {
                const ts0 = (filtered[0]?.photo?.high_resolution?.timestamp||0)*1000;
                const age0 = ts0 ? (Date.now()-ts0) : null;
                console.log(`[found] rule=${channel.channelName} items=${filtered.length} firstId=${filtered[0]?.id} firstAgeMs=${age0}`);
              }
              // Startup fresh-only window: skip posting of old items for first N minutes
              const skipMin = Number(process.env.STARTUP_SKIP_OLD_MINUTES || 0);
              if (skipMin > 0) {
                const sinceStartMs = Date.now() - (state.startedAt?.getTime?.() || 0);
                if (sinceStartMs < skipMin * 60 * 1000) {
                  const cutoff = Date.now() - skipMin * 60 * 1000;
                  const old = [];
                  const fresh = [];
                  for (const it of filtered) {
                    const ts = (it.photo?.high_resolution?.timestamp || 0) * 1000;
                    if (ts && ts < cutoff) old.push(it); else fresh.push(it);
                  }
                  // mark old as processed to avoid later posting, but do not return them
                  for (const it of old) {
                    try { processedStore.set(dedupeKeyForChannel(channel, it.id, familyKey), Date.now()); } catch {}
                  }
                  if (old.length) { try { metrics.fetch_skipped_total.inc(old.length); } catch {} }
                  filtered = fresh;
                }
              }
              // annotate discovery time for posting/metrics
              const tdisc = Date.now();
              filtered.forEach(it => { try { it.discoveredAt = tdisc; } catch {} });
              // optional diagnostics: measure age at discovery
              try {
                if (String(process.env.DIAG_TIMING || '0') === '1' && filtered.length) {
                  const sample = filtered.slice(0, Math.min(3, filtered.length));
                  for (const it of sample) {
                    const createdMs = Number((it.photo?.high_resolution?.timestamp || 0) * 1000) || 0;
                    const age = createdMs ? (tdisc - createdMs) : -1;
                    console.log('[diag.discovery]', 'rule=', channel.channelName, 'item=', it.id, 'age_ms=', age);
                  }
                }
              } catch {}
              // record first-age (listed->discovered) samples
              try {
                for (const it of filtered) {
                  const createdMs = Number((it.photo?.high_resolution?.timestamp || 0) * 1000) || 0;
                  if (createdMs) recordFirstAge(channel.channelName, Math.max(0, tdisc - createdMs));
                }
              } catch {}
              const dedupeSkipped = items.length - filtered.length;
              trace('filter', { rule: channel.channelName, page, new_count: filtered.length, skipped_dedupe: Math.max(0, dedupeSkipped) });
              return filtered;
            }
            
            // Handle HTTP errors
            if (res.status === 401) {
                stats.s401 += 1;
                await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1500));
                throw new Error(`HTTP ${res.status}`);
            } else if (res.status === 403) {
                stats.s403 += 1;
                await new Promise(resolve => setTimeout(resolve, 1500 + Math.random() * 2000));
                throw new Error(`HTTP ${res.status}`);
            } else if (res.status >= 400 && res.status < 500) {
                // Other client errors (4xx) - don't rotate proxy, just retry
                stats.s4xx += 1;
                throw new Error(`HTTP ${res.status}`);
            } else {
                // Server errors (5xx) or other issues → count & retry
                stats.s5xx += 1;
                throw new Error(`HTTP ${res.status}`);
            }
        } catch (e) {
            console.warn('[search] fail', e.message || e);
            markFetchError();
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
  let familyKey = null; try { familyKey = buildFamilyKeyFromURL(String(channel.url || ''), 'auto'); } catch {}
  const filteredArticles = items.filter(({ photo, id, title }) =>
    photo &&
    (DISABLE_RECENT || (photo.high_resolution?.timestamp || 0) * 1000 > cutoff) &&
    !processedStore?.has?.(dedupeKeyForChannel(channel, id, familyKey)) &&
    !titleBlacklist.some(word => (title || '').toLowerCase().includes(word))
  );

  d(`[debug][rule:${channel.channelName}] matches=${filteredArticles.length} ` +
    `firstIds=${filteredArticles.slice(0, 5).map(x => x.id).join(',')}`);

  if (filteredArticles.length === 0 && items.length) {
    const sample = items.slice(0, 5);
    for (const item of sample) {
      const hasPhoto = !!item.photo;
      const tsSec = item.photo?.high_resolution?.timestamp || 0;
      const isRecent = tsSec * 1000 > cutoff;
      const wasProcessed = !!processedStore?.has?.(dedupeKeyForChannel(channel, item.id, familyKey));
      const isBlacklisted = titleBlacklist.some(word => (item.title || '').toLowerCase().includes(word));
      let reason = 'unknown';
      if (!hasPhoto) reason = 'no_photo';
      else if (!isRecent) reason = 'too_old';
      else if (wasProcessed) reason = 'already_processed';
      else if (isBlacklisted) reason = 'title_blacklist';
      console.log('[match.debug]', 'rule=', channel.channelName, 'item=', item.id, 'fail=', reason);
    }
  }

  return filteredArticles;
};
