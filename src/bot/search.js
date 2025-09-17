import { fetchRule, hedgedGet } from "../net/http.js";
import { buildHeaders } from "../net/headers.js";
import { handleParams } from "./handle-params.js";
import { dedupeKeyForChannel, ttlMs } from "../utils/dedupe.js";
import { buildFamilyKeyFromURL, canonicalizeUrl } from "../rules/urlNormalizer.js";
import { stats } from "../utils/stats.js";
import { state, markFetchAttempt, markFetchSuccess, markFetchError, recordSoftFail } from "../state.js";
import { metrics } from "../infra/metrics.js";

const DEBUG_POLL = process.env.DEBUG_POLL === '1';
const TRACE = String(process.env.TRACE_SEARCH || '0') === '1';
const d = (...args) => { if (DEBUG_POLL || String(process.env.LOG_LEVEL||'').toLowerCase()==='debug') console.log(...args); };
const trace = (...a) => { if (TRACE) console.log('[trace]', ...a); };
const RECENT_MAX_MIN = parseInt(process.env.RECENT_MAX_MIN ?? '15', 10);
function computeRecentMs() {
  // Base recency window
  let ms = Math.max(0, RECENT_MAX_MIN) * 60 * 1000;
  // Optional bootstrap: relax recency on cold start until first successful post
  try {
    const bootMin = Math.max(0, parseInt(process.env.RECENT_BOOTSTRAP_MIN ?? '60', 10));
    if (!state.lastPostAt && bootMin > 0) {
      const bootMs = bootMin * 60 * 1000;
      if (bootMs > ms) ms = bootMs;
    }
  } catch {}
  return ms;
}
// When DISABLE_RECENT_FILTER=1, we still want a safety cap on ingest age to
// avoid flooding the queue with very old items. Use INGEST_DEFAULT_CAP_MS when
// RECENT filter is disabled.
const DISABLE_RECENT = String(process.env.DISABLE_RECENT_FILTER || '0') === '1';
const IGNORE_PROCESSED_BOOT = String(process.env.BOOTSTRAP_IGNORE_PROCESSED || '1') === '1';
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
    const baseParams = {
        per_page: '96',
        search_text: ids.text,
        catalog_ids: ids.catalog,
        price_from: ids.min,
        price_to: ids.max,
        currency: ids.currency,
        order: 'newest_first',
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
            // Build headers lazily so each request reuses the proxied session (no legacy tokens.ensure())
            const requestConfig = () => ({ headers: buildHeaders(undefined, channel.url, `https://${url.host}`) });
            let result;
            if (USE_HEDGE) {
              try {
                // Hedged fetch across proxies for lower tail latency
                const res = await hedgedGet(
                  apiUrl.href,
                  requestConfig(),
                  `https://${url.host}`
                );
                result = { ok: res && res.status >= 200 && res.status < 300, res };
              } catch (e) {
                // Fallback to sticky fetchRule rather than failing the page
                result = await fetchRule(channel.channelName, apiUrl.href, requestConfig());
              }
            } else {
              result = await fetchRule(channel.channelName, apiUrl.href, requestConfig());
            }
            if (result?.skipped) return [];
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
              // Startup old-drop window: only apply AFTER the first successful post
              // to avoid starving initial posting. Disabled by default.
              const skipMin = Number(process.env.STARTUP_SKIP_OLD_MINUTES || 0);
              if (skipMin > 0 && state.lastPostAt) {
                const cutoff = Date.now() - skipMin * 60 * 1000;
                const old = [];
                const fresh = [];
                for (const it of filtered) {
                  const ts = Number(((it.created_at_ts || 0) * 1000)) || Number((it.photo?.high_resolution?.timestamp || 0) * 1000) || 0;
                  if (ts && ts < cutoff) old.push(it); else fresh.push(it);
                }
                // mark old as processed to avoid later posting, but do not return them
                for (const it of old) {
                  try {
                    processedStore.set(dedupeKeyForChannel(channel, it.id, familyKey), Date.now(), { ttl: ttlMs });
                    if (String(process.env.LOG_LEVEL || '').toLowerCase() === 'debug') {
                      console.log('[dedupe.mark.old]', 'rule=', channel.channelName, 'item=', it.id, 'ttl_ms=', ttlMs);
                    }
                  } catch {}
                }
                if (old.length) { try { metrics.fetch_skipped_total.inc(old.length); } catch {} }
                filtered = fresh;
              }
              // annotate discovery time for posting/metrics
              const tdisc = Date.now();
              filtered.forEach(it => { try { it.discoveredAt = tdisc; } catch {} });
              // optional diagnostics: measure age at discovery
              try {
                if (String(process.env.DIAG_TIMING || '0') === '1' && filtered.length) {
                  const sample = filtered.slice(0, Math.min(3, filtered.length));
                  for (const it of sample) {
                    const createdMs = Number(((it.created_at_ts || 0) * 1000)) || Number((it.photo?.high_resolution?.timestamp || 0) * 1000) || 0;
                    const age = createdMs ? (tdisc - createdMs) : -1;
                    console.log('[diag.discovery]', 'rule=', channel.channelName, 'item=', it.id, 'age_ms=', age);
                  }
                }
              } catch {}
              // record first-age (listed->discovered) samples
              try {
                for (const it of filtered) {
                  const createdMs = Number(((it.created_at_ts || 0) * 1000)) || Number((it.photo?.high_resolution?.timestamp || 0) * 1000) || 0;
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
  const cutoff = Date.now() - computeRecentMs();
  let familyKey = null; try { familyKey = buildFamilyKeyFromURL(String(channel.url || ''), 'auto'); } catch {}
  // Respect DISABLE_RECENT_FILTER for ingest default cap as well (bugfix)
  const defaultCap = (DISABLE_RECENT || String(process.env.DISABLE_RECENT || '0') === '1')
    ? Number(process.env.INGEST_DEFAULT_CAP_MS || 30 * 60 * 1000)
    : 0; // 30min when recent filter disabled
  const INGEST_MAX_AGE_MS = Math.max(0, Number(process.env.INGEST_MAX_AGE_MS || defaultCap));
  const now = Date.now();
  const filteredArticles = items.filter((it) => {
    try {
      const id = it.id;
      const title = it.title;
      const photo = it.photo;
      const hasPhoto = !!photo;
      const createdMs = Number(((it.created_at_ts || 0) * 1000)) || Number((photo?.high_resolution?.timestamp || 0) * 1000) || 0;
      const recentOk = DISABLE_RECENT || (createdMs > cutoff);
      const key = dedupeKeyForChannel(channel, id, familyKey);
      const dup = !!processedStore?.has?.(key);
      // Hard ingest age cap (created_at_ts preferred, else photo.timestamp)
      const tooOldIngest = INGEST_MAX_AGE_MS > 0 && createdMs > 0 && (now - createdMs) > INGEST_MAX_AGE_MS;
      if (tooOldIngest) {
        try { processedStore?.set?.(key, Date.now(), { ttl: ttlMs }); } catch {}
        try { metrics.ingest_dropped_too_old_total?.inc({ rule: String(channel.channelName || '') }); } catch {}
      }
      const titleBlocked = titleBlacklist.some(word => String(title || '').toLowerCase().includes(word));
      return hasPhoto && recentOk && !dup && !tooOldIngest && !titleBlocked;
    } catch {
      return false;
    }
  });

  d(`[debug][rule:${channel.channelName}] matches=${filteredArticles.length} ` +
    `firstIds=${filteredArticles.slice(0, 5).map(x => x.id).join(',')}`);

  if (filteredArticles.length === 0 && items.length) {
    try { const mins = Math.round(computeRecentMs() / 60000); console.log('[recent.window]', 'mins=', mins, 'rule=', String(channel.channelName||'')); } catch {}
    const sample = items.slice(0, 5);
    for (const item of sample) {
      const hasPhoto = !!item.photo;
      const createdMs = Number(((item.created_at_ts || 0) * 1000)) || Number((item.photo?.high_resolution?.timestamp || 0) * 1000) || 0;
      const isRecent = createdMs > cutoff;
      const wasProcessed = !!processedStore?.has?.(dedupeKeyForChannel(channel, item.id, familyKey));
      const isBlacklisted = titleBlacklist.some(word => (item.title || '').toLowerCase().includes(word));
      let reason = 'unknown';
      if (!hasPhoto) reason = 'no_photo';
      else if (!isRecent) reason = 'too_old';
      else if (wasProcessed) reason = 'already_processed';
      else if (isBlacklisted) reason = 'title_blacklist';
      console.log('[match.debug]', 'rule=', channel.channelName, 'item=', item.id, 'fail=', reason);
    }
    // Bootstrapping fallback: if no matches and we have never posted since boot,
    // allow a small number of newest items within a safe max age window.
    try {
      if (!state.lastPostAt) {
        const allowN = Math.max(0, Number(process.env.BOOTSTRAP_ALLOW_TOPN || 3));
        const maxAgeMs = Math.max(0, Number(process.env.BOOTSTRAP_MAX_AGE_MS || 24 * 60 * 60 * 1000));
        if (allowN > 0 && maxAgeMs > 0) {
          const now = Date.now();
          // Sort by created desc
          const sorted = items.slice().sort((a,b) => {
            const ac = Number(((a.created_at_ts || 0) * 1000)) || Number((a.photo?.high_resolution?.timestamp || 0) * 1000) || 0;
            const bc = Number(((b.created_at_ts || 0) * 1000)) || Number((b.photo?.high_resolution?.timestamp || 0) * 1000) || 0;
            return bc - ac;
          });
          const picked = [];
          for (const it of sorted) {
            if (picked.length >= allowN) break;
            try {
              const createdMs = Number(((it.created_at_ts || 0) * 1000)) || Number((it.photo?.high_resolution?.timestamp || 0) * 1000) || 0;
              if (createdMs && (now - createdMs) > maxAgeMs) continue;
              const key = dedupeKeyForChannel(channel, it.id, familyKey);
              const wasSeen = !!processedStore?.has?.(key);
              if (wasSeen && !IGNORE_PROCESSED_BOOT) continue;
              const isBlacklisted = titleBlacklist.some(word => (it.title || '').toLowerCase().includes(word));
              if (isBlacklisted) continue;
              picked.push(it);
              try { processedStore?.set?.(key, Date.now(), { ttl: ttlMs }); } catch {}
            } catch {}
          }
          if (picked.length) {
            console.warn('[bootstrap.select]', 'rule=', channel.channelName, 'picked=', picked.length, 'window_ms=', maxAgeMs);
            return picked;
          }
        }
      }
    } catch {}
  }

  // Load-adaptive fresh-first capping
  try {
    const MAX_ITEM_AGE_MS = Math.max(0, Number(process.env.MAX_ITEM_AGE_MS || 60_000));
    const CAP_BASE = Math.max(1, Number(process.env.CAP_BASE || 999));
    const CAP_WHEN_Q_HIGH = Math.max(1, Number(process.env.CAP_WHEN_Q_HIGH || 15));
    const Q_HIGH_THRESHOLD = Math.max(0, Number(process.env.Q_HIGH_THRESHOLD || 800));
    // filter by max item age (created_at or photo timestamp)
    const nowTs = Date.now();
    const ageOk = filteredArticles.filter(it => {
      try {
        const createdMs = Number(((it.created_at_ts || 0) * 1000)) || Number((it.photo?.high_resolution?.timestamp || 0) * 1000) || 0;
        return !createdMs || (nowTs - createdMs) <= MAX_ITEM_AGE_MS;
      } catch { return true; }
    });
    // determine queue depth
    let totalQ = 0; try { totalQ = Number(metrics.discord_queue_depth?.get?.() || 0); } catch {}
    const cap = totalQ >= Q_HIGH_THRESHOLD ? CAP_WHEN_Q_HIGH : CAP_BASE;
    // sort newest first by created timestamp
    const sorted = ageOk.slice().sort((a,b) => {
      const ac = Number(((a.created_at_ts || 0) * 1000)) || Number((a.photo?.high_resolution?.timestamp || 0) * 1000) || 0;
      const bc = Number(((b.created_at_ts || 0) * 1000)) || Number((b.photo?.high_resolution?.timestamp || 0) * 1000) || 0;
      return bc - ac;
    });
    return sorted.slice(0, cap);
  } catch {}
  return filteredArticles;
};
