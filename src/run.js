import { vintedSearch } from "./bot/search.js";
import { postArticles } from "./bot/post.js";
import { initProxyPool } from "./net/http.js";
import { startAutoTopUp } from "./net/proxyHealth.js";
import { createProcessedStore, dedupeKey, ttlMs } from "./utils/dedupe.js";
import { limiter } from "./utils/limiter.js";
import { startStats } from "./utils/stats.js";
import { metrics } from "./infra/metrics.js";

// Map of channel names that are already scheduled.  addSearch() consults
// this via `activeSearches.has(name)` so repeated /new_search commands don't
// create duplicate timers. The value holds the last scheduled timeout ID.
const activeSearches = new Map(); // name -> Timeout
// In-memory processed store with TTL; keys are per-rule when configured
let processedStore = createProcessedStore();
// Optional env overrides for quick testing
const OVERRIDE_SEC = Number(process.env.POLL_INTERVAL_SEC || 0);
const NO_JITTER = String(process.env.POLL_NO_JITTER || '0') === '1';

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

const ruleState = new Map(); // name -> { noNewStreak: number, tokens: number, backfillOnUntil?: number, backfillCooldownUntil?: number }
const RULE_MIN_RPM = Math.max(0, Number(process.env.RULE_MIN_RPM || 1));

const runSearch = async (client, channel, opts = {}) => {
    try {
        // Optional heartbeat dots (disabled by default)
        if (String(process.env.DEBUG_DOTS || '0') === '1') process.stdout.write('.');
        const JITTER_MS = Number(process.env.JITTER_MS || 0);
        if (JITTER_MS > 0) await new Promise(r => setTimeout(r, Math.random() * JITTER_MS));
        // Per-rule token bucket fairness
        const st = ruleState.get(channel.channelName) || { noNewStreak: 0, tokens: RULE_MIN_RPM };
        ruleState.set(channel.channelName, st);
        if (st.tokens <= 0 && RULE_MIN_RPM > 0) {
            return;
        }
        if (RULE_MIN_RPM > 0) st.tokens -= 1;
        // Hysterese: Backfill-Mode nur zeitweise aktivieren
        const now = Date.now();
        const stH = ruleState.get(channel.channelName);
        const minMs = Number(process.env.NO_NEW_STREAK_MIN_MS || 300000);
        let useBackfill = false;
        if (stH?.backfillOnUntil && now < stH.backfillOnUntil) {
            useBackfill = true;
        }
        const bfPages = useBackfill ? Number(process.env.NO_NEW_BACKFILL_PAGES || Math.max(2, Number(process.env.BACKFILL_PAGES || 1))) : Number(process.env.BACKFILL_PAGES || 1);
        try { metrics.backfill_pages_active.set(countActiveBackfill()); } catch {}
        const articles = await limiter.schedule(() => vintedSearch(channel, processedStore, { ...opts, backfillPages: bfPages }));

        //if new articles are found post them
        if (articles && articles.length > 0) {
            console.log(`${channel.channelName} => +${articles.length}`);
            const dest = await getChannelById(client, channel.channelId);
            if (!dest) {
                if (!warnedMissing.has(channel.channelId)) {
                    console.warn(`[post] no valid targets for ${channel.channelName} (${channel.channelId})`);
                    warnedMissing.add(channel.channelId);
                }
            } else {
                await postArticles(articles, dest, channel.channelName);
                // Commit-on-post: mark seen only after posting succeeds
                articles.forEach(article => {
                  const key = dedupeKey(channel.channelName, article.id);
                  processedStore.set(key, Date.now(), { ttl: ttlMs });
                });
                // reset streak on success
                st.noNewStreak = 0;
            }
        } else {
            st.noNewStreak = (st.noNewStreak || 0) + 1;
            const thr = Number(process.env.NO_NEW_THRESHOLD || 6);
            if (st.noNewStreak >= thr) {
                const now = Date.now();
                const minMs = Number(process.env.NO_NEW_STREAK_MIN_MS || 300000);
                const inCooldown = (st.backfillCooldownUntil || 0) > now;
                const active = (st.backfillOnUntil || 0) > now;
                if (!active && !inCooldown) {
                    st.backfillOnUntil = now + minMs; // enable mode
                    st.backfillCooldownUntil = now + 2 * minMs; // ensure off-period later
                }
                st.noNewStreak = 0;
            }
        }
    } catch (err) {
        console.error('\nError running bot:', err);
    }
};

//run the search and set a timeout to run it again   
const runInterval = async (client, channel) => {
    await runSearch(client, channel);
    const baseSec = OVERRIDE_SEC > 0 ? OVERRIDE_SEC : channel.frequency;
    const factor = NO_JITTER ? 1 : (0.8 + Math.random() * 0.4);
    const delay = baseSec * 1000 * factor;
    const t = setTimeout(() => runInterval(client, channel), delay);
    activeSearches.set(channel.channelName, t);
};

// Attach a new search to the scheduler
const addSearch = (client, search) => {
    if (activeSearches.has(search.channelName)) return;
    // Log scheduling info once so you see which interval is active
    const baseSec = OVERRIDE_SEC > 0 ? OVERRIDE_SEC : search.frequency;
    console.log(
      `[schedule] ${search.channelName}: every ${baseSec}s` +
      (NO_JITTER ? '' : ' (±20% jitter)') +
      (OVERRIDE_SEC > 0 ? ' [override via POLL_INTERVAL_SEC]' : '')
    );
    if (process.env.NODE_ENV === 'test') {
        const t = setTimeout(() => { runInterval(client, search); }, 1000);
        activeSearches.set(search.channelName, t);
        try { metrics.rules_active.set(activeSearches.size); } catch {}
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
        activeSearches.set(search.channelName, t);
        try { metrics.rules_active.set(activeSearches.size); } catch {}
    })();
};

//init the article id set, then launch the simultaneous searches
export const run = async (client, mySearches) => {
    processedStore = createProcessedStore();
    // background top-up keeps the pool filled without blocking
    startAutoTopUp();
    startStats();
    try {
        const rpm = Number(process.env.SEARCH_TARGET_RPM || 60);
        const conc = Number(process.env.SEARCH_CONCURRENCY || 12);
        console.log(`[limiter] rpm=${rpm} conc=${conc}`);
    } catch {}
    const REFRESH_H = parseInt(process.env.PROXY_REFRESH_HOURS || '6', 10);
    setInterval(async () => {
        try {
            console.log('[proxy] refreshing pool…');
            await initProxyPool();
        } catch (e) {
            console.warn('[proxy] refresh failed:', e.message || e);
        }
    }, REFRESH_H * 60 * 60 * 1000);

    // Validate configured channel IDs up-front to surface misconfig early
    try {
        await Promise.all((mySearches || []).map(async (s) => {
            const ch = await getChannelById(client, s.channelId);
            if (!ch) {
                console.warn(`[post] Warnung: Zielkanal ungültig oder nicht erreichbar für "${s.channelName}" (id=${s.channelId}).`);
            }
        }));
    } catch {}

    //stagger start time for searches to avoid too many simultaneous requests
    mySearches.forEach((channel, index) => {
        setTimeout(() => addSearch(client, channel), index * 1000 + 5000);
    });

    // Periodic cleanup of expired dedupe entries
    setInterval(() => {
        processedStore.purgeExpired();
        try {
          console.log(`[dedupe] purge expired; size=${processedStore.size()}`);
        } catch { /* ignore logging failures */ }
    }, 60 * 60 * 1000);

    // Refill per-rule tokens each minute (fairness)
    if (RULE_MIN_RPM > 0) {
        setInterval(() => {
            for (const [name, st] of ruleState.entries()) {
                st.tokens = RULE_MIN_RPM;
                ruleState.set(name, st);
            }
        }, 60 * 1000);
    }
};

// Stop and remove a scheduled job by name, if present
function removeJob(name) {
    const t = activeSearches.get(name);
    if (!t) return false;
    try { clearTimeout(t); } catch {}
    activeSearches.delete(name);
    console.log(`[schedule] stopped ${name}`);
    try { metrics.rules_active.set(activeSearches.size); } catch {}
    return true;
}

function stopAll() {
    for (const [name, t] of activeSearches.entries()) {
        try { clearTimeout(t); } catch {}
        activeSearches.delete(name);
    }
    console.log('[schedule] all jobs stopped');
    try { metrics.rules_active.set(0); } catch {}
}

export { addSearch, activeSearches, removeJob, stopAll };

// Restart all searches: stop existing timers and re-schedule from config
export async function restartAll(client, mySearches) {
  try { stopAll(); } catch {}
  try {
    mySearches.forEach((channel, index) => {
      setTimeout(() => addSearch(client, channel), index * 1000 + 1000);
    });
  } catch (e) {
    console.warn('[schedule] restartAll failed:', e?.message || e);
  }
}

function countActiveBackfill() {
  const now = Date.now();
  let n = 0; for (const st of ruleState.values()) if ((st.backfillOnUntil || 0) > now) n++;
  return n;
}
