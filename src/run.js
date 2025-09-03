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
import { loadFamiliesFromConfig } from "./rules/families.js";
import { itemMatchesFilters, parseRuleFilters, buildFamilyKey, buildParentKey, debugMatchFailReason, canonicalizeUrl } from "./rules/urlNormalizer.js";
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
const FANOUT_DEBUG = String(process.env.FANOUT_DEBUG || process.env.LOG_FANOUT || '0') === '1';
const ll = (...a) => { if (FANOUT_DEBUG) console.log(...a); };
const RULES_DUMP = String(process.env.RULES_DUMP || '1') === '1';

function dumpRulesConfig(searches) {
  if (!RULES_DUMP && !FANOUT_DEBUG) return;
  try {
    const n = (searches || []).length;
    console.log('[rules.dump] total=%d', n);
    for (const r of (searches || [])) {
      try {
        const url = String(r.url || r.link || '');
        let host='?', path='?';
        try { const u = new URL(url); host=u.host; path=u.pathname; } catch {}
        const f = parseRuleFilters(url);
        const fkey = buildFamilyKey(url);
        const pkey = buildParentKey(url);
        const pkeyNoPrice = buildParentKey(url, { stripPrice: true });
        const canUrl = canonicalizeUrl(url);
        console.log('[rule]', 'name=', r.channelName, 'id=', r.channelId, 'host=', host, 'path=', path);
        console.log('[rule.url]', url);
        console.log('[rule.filters]', 'text=', f.text||'', 'currency=', f.currency||'', 'price_from=', f.priceFrom||'', 'price_to=', f.priceTo||'', 'catalogs=', (f.catalogs||[]).join(',')||'');
        console.log('[rule.keys]', 'familyKey=', fkey, 'parentKey=', pkey, 'parentKey(no_price)=', pkeyNoPrice);
        try {
          const u2 = new URL(url);
          const p2 = new URLSearchParams(u2.search);
          const types = [];
          if (p2.getAll('catalog[]').length) types.push('catalog[]=array');
          if (p2.get('catalog_ids')) types.push('catalog_ids=csv');
          if (p2.getAll('brand_ids[]').length) types.push('brand_ids[]=array');
          if (p2.get('brand_ids')) types.push('brand_ids=csv');
          console.log('[parse.canonical]', 'canonical_url=', canUrl, 'types=', types.join(','));
        } catch {}
      } catch (e) {
        console.warn('[rules.dump] failed:', e?.message || e);
      }
    }
  } catch {}
}

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
            if (FANOUT_DEBUG) {
              try {
                const childN = Array.isArray(channel.children) ? channel.children.length : 0;
                ll('[fanout.eval]', 'parent=', channel.channelName, 'items=', articles.length, 'children=', childN);
              } catch {}
            }
            // Fanout mode: if children defined on the rule, evaluate and post into their channels
            if (Array.isArray(channel.children) && channel.children.length && String(process.env.FANOUT_MODE || '1') === '1') {
              for (const child of channel.children) {
                const childRule = child.rule || child; // tolerate shape
                const filters = child.filters || parseRuleFilters(childRule.url);
                const matched = [];
                for (const it of articles) {
                  if (itemMatchesFilters(it, filters)) matched.push(it);
                }
                if (FANOUT_DEBUG) {
                  try {
                    ll('[fanout.eval.child]', 'child=', childRule.channelName, 'matched=', `${matched.length}/${articles.length}`, 'price_from=', filters.priceFrom, 'price_to=', filters.priceTo, 'catalogs=', (filters.catalogs||[]).join(','));
                  } catch {}
                }
                if (!matched.length && articles.length) {
                  const sample = articles.slice(0, 5);
                  for (const it of sample) {
                    let reason = 'unknown';
                    try { reason = debugMatchFailReason(it, filters) || 'unknown'; } catch {}
                    console.log('[match.debug]', 'rule=', childRule.channelName, 'item=', it?.id, 'fail=', reason);
                  }
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
                const hardMax = (stH?.backfillOnUntil && now < stH.backfillOnUntil)
                  ? Number(process.env.BACKFILL_MAX_AGE_MS || 0)
                  : Number(process.env.MAX_AGE_MS || 0);
                const ENFORCE_MAX = String(process.env.ENFORCE_MAX_AGE || '0') === '1';
                const ENFORCE_MATCH = String(process.env.ENFORCE_MATCH_AGE || '0') === '1';
                const gated = [];
                let dropStale = 0, dropGate = 0;
                for (const it of matched) {
                  let first = now;
                  try { first = recordFirstMatch(childRule.channelName, it.id, now); } catch {}
                  try { it.__firstMatchedAt = first; } catch {}
                  try { metrics.parent_child_drift_ms_histogram?.set({ family: String(channel.channelName) }, Math.max(0, Number(first||now) - Number(it.discoveredAt || now))); } catch {}
                  const age = now - Number(first || now);
                  const createdMs = Number((it.photo?.high_resolution?.timestamp || 0) * 1000) || Number(it.createdAt || 0) || 0;
                  const listedAge = createdMs ? (now - createdMs) : 0;
                  if (ENFORCE_MAX && listedAge > 0 && hardMax > 0 && listedAge > hardMax) {
                    dropStale++; continue; // hard drop stale
                  }
                  if (!ENFORCE_MATCH || age <= maxAge) { gated.push(it); continue; }
                  if (!ENFORCE_MATCH || age <= priceDropMax) {
                    try { it.__priceDrop = true; } catch {}
                    gated.push(it);
                    try { metrics.price_drop_posted_total?.inc({ rule: String(childRule.channelName) }); } catch {}
                  } else dropGate++;
                }
                if (FANOUT_DEBUG) ll('[fanout.child.result]', 'child=', childRule.channelName, 'post=', gated.length, 'drop_stale=', dropStale, 'drop_gate=', dropGate);
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
                // Apply optional hard freshness gate for parent as well
                const now = Date.now();
                const stH2 = ruleState.get(channel.channelName);
                const hardMax = (stH2?.backfillOnUntil && now < stH2.backfillOnUntil)
                  ? Number(process.env.BACKFILL_MAX_AGE_MS || 0)
                  : Number(process.env.MAX_AGE_MS || 0);
                const ENFORCE_MAX = String(process.env.ENFORCE_MAX_AGE || '0') === '1';
                const fresh = [];
                for (const it of articles) {
                  const createdMs = Number((it.photo?.high_resolution?.timestamp || 0) * 1000) || Number(it.createdAt || 0) || 0;
                  const listedAge = createdMs ? (now - createdMs) : 0;
                  if (ENFORCE_MAX && hardMax > 0 && listedAge > hardMax) continue;
                  fresh.push(it);
                }
                if (fresh.length) await postArticles(fresh, dest, channel.channelName);
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


function buildFamilies(mySearches) {
  let families = [];
  try {
    if (String(process.env.FANOUT_MODE || '1') === '1') {
      const strat = String(process.env.PARENTING_STRATEGY || 'exact_url');
      const allowMismatch = String(process.env.PARENTING_ALLOW_EXPLICIT_MISMATCH || '0') === '1' || strat !== 'exact_url';
      const configFamilies = allowMismatch ? loadFamiliesFromConfig(mySearches) : [];
      const explicit = allowMismatch && (process.env.FANOUT_PARENT_RULE && process.env.FANOUT_CHILD_RULES)
        ? buildExplicitFamily(mySearches, process.env.FANOUT_PARENT_RULE, process.env.FANOUT_CHILD_RULES)
        : null;
      if (configFamilies && configFamilies.length) families = configFamilies;
      else if (explicit && explicit.length) families = explicit;
      else if (String(process.env.FANOUT_AUTO_GROUP || (strat === 'exact_url' ? '0' : '1')) === '1') families = buildParentGroups(mySearches);
    }
  } catch {}
  // Fallback: name-based prefixes, if no families built
  try {
    if ((!families || families.length === 0) && String(process.env.FANOUT_NAME_PREFIXES || '').trim()) {
      const prefixes = String(process.env.FANOUT_NAME_PREFIXES).split(',').map(s => s.trim()).filter(Boolean);
      const byPref = new Map();
      for (const r of (mySearches || [])) {
        const name = String(r.channelName || '');
        const pref = prefixes.find(p => name.toLowerCase().startsWith(p.toLowerCase()));
        if (!pref) continue;
        if (!byPref.has(pref)) byPref.set(pref, []);
        byPref.get(pref).push(r);
      }
      for (const [pref, list] of byPref.entries()) {
        if (!list.length) continue;
        // Parent heuristic: name containing 'all' else minimal length
        let parent = list.find(r => /\ball\b|all-|-all/i.test(String(r.channelName))) || list.slice().sort((a,b)=>String(a.channelName).length-String(b.channelName).length)[0];
        const children = list.filter(r => r !== parent).map(r => ({ rule: r }));
        families.push({ parent, parentFilters: null, children });
      }
    }
  } catch {}
  if (FANOUT_DEBUG || String(process.env.RULES_DUMP || '1') === '1') {
    try {
      const famCount = families?.length || 0;
      console.log('[fanout.family] families_loaded=%d', famCount);
      for (const fam of families || []) {
        const fk = buildFamilyKey(fam.parent.url);
        const pk = buildParentKey(fam.parent.url);
        const childNames = (fam.children||[]).map(c => c.rule?.channelName || c.channelName || '');
        ll('[fanout.family.detail]', 'familyKey=', fk, 'parentKey=', pk, 'parent=', fam.parent.channelName, 'children=', childNames.join(','));
        if (String(process.env.PARENTING_STRATEGY || 'exact_url') === 'exact_url' && fk !== pk) {
          console.warn('[fanout.warn] strategy=exact_url but familyKey!=parentKey for', fam.parent.channelName);
        }
      }
      // Non-family rules
      const inFam = new Set((families||[]).flatMap(f=> [f.parent.channelName, ...(f.children||[]).map(c=>c.rule?.channelName || c.channelName)]));
      for (const r of (mySearches||[])) if (!inFam.has(r.channelName)) ll('[fanout.standalone]', r.channelName);
    } catch {}
  }
  return families;
}

function computeScheduleList(mySearches) {
  const families = buildFamilies(mySearches);
  const parentNames = new Set();
  for (const fam of (families || [])) {
    const parent = fam.parent;
    parent.children = fam.children || [];
    parentNames.add(parent.channelName);
  }
  const toSchedule = [];
  if (families?.length) {
    toSchedule.push(...families.map(f => f.parent));
    for (const r of (mySearches || [])) if (!parentNames.has(r.channelName)) toSchedule.push(r);
  } else {
    toSchedule.push(...(mySearches || []));
  }
  return toSchedule;
}

export function rebuildFromList(client, list) {
  // Zero-downtime diff update: add/update/remove without stopping all
  const toSchedule = computeScheduleList(list || []);
  const newMap = new Map();
  for (const r of toSchedule) newMap.set(r.channelName, r);
  try { metrics.scheduler_reload_events_total.inc(); } catch {}
  try { console.log('[rebuild] applying diff… newRules=%d', newMap.size); } catch {}
  // Update or add
  for (const [name, rule] of newMap.entries()) {
    if (activeSearches.has(name)) {
      try { edf.updateRule(rule); } catch {}
    } else {
      addSearch(client, rule);
    }
  }
  // Remove absent
  for (const name of Array.from(activeSearches.keys())) {
    if (!newMap.has(name)) removeJob(name);
  }
  edf.start();
  try { metrics.scheduler_rules_total.set(activeSearches.size); } catch {}
}

export async function rebuildFromDisk(client) {
  try {
    const fsmod = await import('fs');
    const path = await import('path');
    const searches = JSON.parse(fsmod.readFileSync(path.resolve('./config/channels.json'),'utf-8'));
    rebuildFromList(client, searches);
  } catch (e) {
    console.warn('[schedule] rebuildFromDisk failed:', e?.message || e);
  }
}

// Non-blocking incremental rebuild wrapper for commands
export async function incrementalRebuildFromDisk(client) {
  try {
    const fsmod = await import('fs');
    const path = await import('path');
    const searches = JSON.parse(fsmod.readFileSync(path.resolve('./config/channels.json'),'utf-8'));
    setTimeout(() => {
      try {
        console.log('[rebuild] mode=incremental');
        rebuildFromList(client, searches);
      } catch {}
    }, 0);
  } catch (e) {
    console.warn('[schedule] incrementalRebuildFromDisk failed:', e?.message || e);
  }
}

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

    // Dump configured rules early to diagnose URL/filters/family-keys
    dumpRulesConfig(mySearches);

    // Build families and schedule list
    const toSchedule = computeScheduleList(mySearches);
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
    try { edf.removeRule(name); } catch {}
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
