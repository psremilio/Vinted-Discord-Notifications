import { vintedSearch } from "./bot/search.js";
import { postArticles } from "./bot/post.js";
import { initProxyPool } from "./net/http.js";
import { startAutoTopUp } from "./net/proxyHealth.js";
import { createProcessedStore, dedupeKey, ttlMs } from "./utils/dedupe.js";
import { limiter } from "./utils/limiter.js";
import { startStats } from "./utils/stats.js";
import { metrics } from "./infra/metrics.js";
import { EdfScheduler } from "./schedule/edf.js";
import { tierOf } from "./schedule/tiers.js";
import { buildParentGroups, buildExplicitFamily } from "./rules/parenting.js";
import { itemMatchesFilters, parseRuleFilters } from "./rules/urlNormalizer.js";
import { recordFirstMatch } from "./bot/matchStore.js";

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

const ruleState = new Map(); // name -> { noNewStreak: number, tokens: number, backfillOnUntil?: number, backfillCooldownUntil?: number, noDataCycles?: number }
const RULE_MIN_RPM = Math.max(0, Number(process.env.RULE_MIN_RPM || 1));

export const runSearch = async (client, channel, opts = {}) => {
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
        const tPoll0 = Date.now();
        const articles = await limiter.schedule(() => vintedSearch(channel, processedStore, { ...opts, backfillPages: bfPages }));
        const elapsedPoll = Date.now() - tPoll0;
        try { const tier = tierOf(channel.channelName); metrics.tier_poll_latency_ms.set({ tier }, elapsedPoll); } catch {}

        //if new articles are found post them
        if (articles && articles.length > 0) {
            console.log(`${channel.channelName} => +${articles.length}`);
            // Fanout mode: if children defined on the rule, evaluate and post into their channels
            if (Array.isArray(channel.children) && channel.children.length && String(process.env.FANOUT_MODE || '1') === '1') {
              for (const child of channel.children) {
                const childRule = child.rule || child; // tolerate shape
                const filters = child.filters || parseRuleFilters(childRule.url);
                const matched = [];
                for (const it of articles) {
                  if (itemMatchesFilters(it, filters)) matched.push(it);
                }
                if (!matched.length) continue;
                const dest = await getChannelById(client, childRule.channelId);
                if (!dest) {
                  if (!warnedMissing.has(childRule.channelId)) {
                    console.warn(`[post] no valid targets for child ${childRule.channelName} (${childRule.channelId})`);
                    warnedMissing.add(childRule.channelId);
                  }
                  continue;
                }
                // annotate firstMatchedAt and apply match-age gate / optional price-drop label
                const now = Date.now();
                const maxAge = Number(process.env.MATCH_MAX_AGE_MS || 45000);
                const priceDropMax = Number(process.env.PRICE_DROP_MAX_AGE_MS || 300000);
                const gated = [];
                for (const it of matched) {
                  let first = now;
                  try { first = recordFirstMatch(childRule.channelName, it.id, now); } catch {}
                  try { it.__firstMatchedAt = first; } catch {}
                  try { metrics.parent_child_drift_ms_histogram?.set({ family: String(channel.channelName) }, Math.max(0, Number(first||now) - Number(it.discoveredAt || now))); } catch {}
                  const age = now - Number(first || now);
                  if (age <= maxAge) { gated.push(it); continue; }
                  if (age <= priceDropMax) {
                    try { it.__priceDrop = true; } catch {}
                    gated.push(it);
                    try { metrics.price_drop_posted_total?.inc({ rule: String(childRule.channelName) }); } catch {}
                  }
                }
                if (!gated.length) continue;
                await postArticles(gated, dest, childRule.channelName);
                // mark seen for child rule after post
                gated.forEach(article => {
                  const key = dedupeKey(childRule.channelName, article.id);
                  processedStore.set(key, Date.now(), { ttl: ttlMs });
                });
                try { metrics.parent_fanout_items_total?.inc({ parent: String(channel.channelName), child: String(childRule.channelName) }, gated.length); } catch {}
              }
            }
            // Also post to parent rule's channel as usual, unless FANOUT suppresses it
            if (String(process.env.FANOUT_SUPPRESS_PARENT_POST || '0') !== '1') {
              const dest = await getChannelById(client, channel.channelId);
              if (!dest) {
                if (!warnedMissing.has(channel.channelId)) {
                  console.warn(`[post] no valid targets for ${channel.channelName} (${channel.channelId})`);
                  warnedMissing.add(channel.channelId);
                }
              } else {
                await postArticles(articles, dest, channel.channelName);
                articles.forEach(article => {
                  const key = dedupeKey(channel.channelName, article.id);
                  processedStore.set(key, Date.now(), { ttl: ttlMs });
                });
              }
            }
            // reset streak on success
            st.noNewStreak = 0;
            st.noDataCycles = 0;
        } else {
            st.noNewStreak = (st.noNewStreak || 0) + 1;
            st.noDataCycles = (st.noDataCycles || 0) + 1;
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
            // Optional: allow child to fetch once if parent had 2 consecutive cycles without data
            if (String(process.env.FANOUT_CHILD_FALLBACK || '0') === '1' && Array.isArray(channel.children) && channel.children.length) {
              if ((st.noDataCycles || 0) >= 2) {
                for (const child of channel.children) {
                  const childRule = child.rule || child;
                  try {
                    const childArts = await limiter.schedule(() => vintedSearch(childRule, processedStore, { ...opts, backfillPages: 1 }));
                    if (childArts?.length) {
                      const dest = await getChannelById(client, childRule.channelId);
                      if (dest) await postArticles(childArts, dest, childRule.channelName);
                      childArts.forEach(article => {
                        const key = dedupeKey(childRule.channelName, article.id);
                        processedStore.set(key, Date.now(), { ttl: ttlMs });
                      });
                      try { metrics.child_fetch_saved_total?.inc({ child: String(childRule.channelName) }, childArts.length); } catch {}
                    }
                  } catch {}
                }
                st.noDataCycles = 0;
              }
            }
        }
    } catch (err) {
        console.error('\nError running bot:', err);
    }
};

// Attach a new search to the scheduler (EDF)
const edf = new EdfScheduler(async (client, rule) => {
  await runSearch(client, rule);
});

const addSearch = (client, search) => {
    if (activeSearches.has(search.channelName)) return;
    // Log scheduling info
    const tier = tierOf(search.channelName);
    console.log(`[schedule] ${search.channelName}: EDF tier=${tier}` + (NO_JITTER ? '' : ' (±jitter)'));
    edf.addRule(client, search);
    activeSearches.set(search.channelName, true);
    try { metrics.rules_active.set(activeSearches.size); } catch {}
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

    // Parenting groups (fanout)
    let families = [];
    try {
      if (String(process.env.FANOUT_MODE || '1') === '1') {
        const explicit = (process.env.FANOUT_PARENT_RULE && process.env.FANOUT_CHILD_RULES)
          ? buildExplicitFamily(mySearches, process.env.FANOUT_PARENT_RULE, process.env.FANOUT_CHILD_RULES)
          : null;
        if (explicit && explicit.length) families = explicit;
        else if (String(process.env.FANOUT_AUTO_GROUP || '1') === '1') families = buildParentGroups(mySearches);
      }
    } catch {}

    const parentNames = new Set();
    for (const fam of (families || [])) {
      const parent = fam.parent;
      parent.children = fam.children || [];
      parentNames.add(parent.channelName);
    }
    const toSchedule = [];
    if (families?.length) {
      toSchedule.push(...families.map(f => f.parent));
      // Add any non-family rule as standalone
      for (const r of (mySearches || [])) if (!parentNames.has(r.channelName)) toSchedule.push(r);
    } else {
      toSchedule.push(...(mySearches || []));
    }

    // Register rules into EDF then start
    toSchedule.forEach((channel) => addSearch(client, channel));
    edf.start();

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
    if (!activeSearches.has(name)) return false;
    activeSearches.delete(name);
    console.log(`[schedule] stopped ${name}`);
    try { metrics.rules_active.set(activeSearches.size); } catch {}
    return true;
}

function stopAll() {
    edf.stop();
    for (const [name] of activeSearches.entries()) activeSearches.delete(name);
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
