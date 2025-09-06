import { vintedSearch } from "./bot/search.js";
import { postArticles } from "./bot/post.js";
import { initProxyPool } from "./net/http.js";
import { startAutoTopUp } from "./net/proxyHealth.js";
import { createProcessedStore, dedupeKeyForChannel, ttlMs, DEDUPE_SCOPE } from "./utils/dedupe.js";
import { limiter } from "./utils/limiter.js";
import { startStats } from "./utils/stats.js";
import { metrics } from "./infra/metrics.js";
import { EdfScheduler } from "./schedule/edf.js";
import { tierOf } from "./schedule/tiers.js";
import { buildParentGroups, buildExplicitFamily, buildAutoPriceFamilies, canonicalSignature } from "./rules/parenting.js";
import { loadFamiliesFromConfig } from "./rules/families.js";
import { itemMatchesFilters, parseRuleFilters, buildFamilyKey, buildParentKey, debugMatchFailReason, canonicalizeUrl, buildFamilyKeyFromURL, canonicalizeUrlExcept } from "./rules/urlNormalizer.js";
import { recordFirstMatch } from "./bot/matchStore.js";
import { hadSoftFailRecently } from "./state.js";
import { learnFromRules } from "./rules/catalogLearn.js";

// Map of channel names that are already scheduled.  addSearch() consults
// this via `activeSearches.has(name)` so repeated /new_search commands don't
// create duplicate timers. The value holds the last scheduled timeout ID.
const activeSearches = new Map(); // name -> Timeout
// In-memory processed store with TTL; keys are per-rule when configured
let processedStore = createProcessedStore();
try { console.log('[dedupe.scope]', DEDUPE_SCOPE); } catch {}
// Family runtime state
const familiesByParent = new Map(); // parentName -> { parent, children, sig }
const familyState = new Map(); // sig -> { warmup: number, child: Map<name,{zero:number, quarantined:boolean}> }
const quarantinedChildren = new Set(); // child rule names to schedule solo
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
        const fkey = buildFamilyKeyFromURL(url, 'auto');
        const pkey = buildParentKey(url);
        const pkeyNoPrice = canonicalizeUrlExcept(url, ['price_from','price_to','size_ids[]','status_ids[]','size_ids','status_ids']);
        const canUrl = canonicalizeUrl(url);
        console.log('[rule]', 'name=', r.channelName, 'id=', r.channelId, 'host=', host, 'path=', path);
        console.log('[rule.url]', url);
        console.log('[rule.filters]', 'text=', f.text||'', 'currency=', f.currency||'', 'price_from=', f.priceFrom||'', 'price_to=', f.priceTo||'', 'catalogs=', (f.catalogs||[]).join(',')||'');
        console.log('[rule.keys]', 'familyKey(strict)=', fkey, 'parentKey=', pkey, 'parentKey(no_price_no_size_no_status)=', pkeyNoPrice);
        if (String(process.env.LOG_FAMILY_MISMATCH || '1') === '1' && fkey !== pkeyNoPrice) {
          console.warn('[family.mismatch]', 'name=', r.channelName, 'reason=fkey!=parentKey(no_price)');
        }
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
  // Gating: only structured dimensions (price/size/status). No brand-only families.
  try {
    const gated = [];
    for (const fam of (families || [])) {
      const filters = parseRuleFilters(fam.parent?.url || '');
      const g = shouldFanoutByFilters(filters);
      if (!g.ok) continue;
      gated.push(fam);
    }
    families = gated;
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

// Tombstones: prevent re-add races for short window after delete
const tombstoneNames = new Map(); // name -> untilTs
const tombstoneKeys = new Map(); // key -> untilTs
function _isTombstonedName(name) { const until = tombstoneNames.get(String(name)); return !!(until && until > Date.now()); }
function _isTombstonedKey(key) { const until = tombstoneKeys.get(String(key)); return !!(until && until > Date.now()); }
function _gcTombstones() {
  const now = Date.now();
  for (const [k, ts] of Array.from(tombstoneNames.entries())) if (ts <= now) tombstoneNames.delete(k);
  for (const [k, ts] of Array.from(tombstoneKeys.entries())) if (ts <= now) tombstoneKeys.delete(k);
}
setInterval(_gcTombstones, 30_000).unref?.();
export function tombstoneRule(name, url, ttlMs = Number(process.env.DELETE_TOMBSTONE_MS || 60_000)) {
  const until = Date.now() + Math.max(10_000, ttlMs);
  if (name) tombstoneNames.set(String(name), until);
  try { const k = buildParentKey(url); tombstoneKeys.set(String(k), until); } catch {}
  try { console.log('[delete.tombstone]', 'name=', name, 'until=', new Date(until).toISOString()); } catch {}
}

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
                const fkey = (()=>{ try { return buildFamilyKeyFromURL(channel.url, 'auto'); } catch { return '?'; } })();
                ll('[fanout.eval]', 'parent=', channel.channelName, 'items=', articles.length, 'children=', childN, 'parent_url=', canonicalizeUrl(channel.url), 'family_key=', fkey);
              } catch {}
            }
            // Fanout mode: if children defined on the rule, evaluate and post into their channels
            if (Array.isArray(channel.children) && channel.children.length && String(process.env.FANOUT_MODE || '1') === '1') {
              const MIN_PARENT = Math.max(1, Number(process.env.FAMILY_MIN_PARENT_MATCHES || 1));
              if (articles.length < MIN_PARENT) {
                ll('[fanout.eval]', 'parent=', channel.channelName, 'items=', articles.length, 'parent_url=', canonicalizeUrl(channel.url), 'skip=too_few_parent_matches');
              } else {
              const parentFilters = (() => { try { return parseRuleFilters(channel.url); } catch { return null; } })();
              const IGNORE_CAT_WHEN_PARENT_NONE = String(process.env.FANOUT_CHILD_IGNORE_CATALOG_WHEN_PARENT_HAS_NONE || '1') === '1';
              // Treat parent catalog=2050 as effectively "no catalog constraint"
              // to avoid over-filtering children when the parent is a broad "all" search.
              const parentHasWildcard2050 = (() => {
                try { return Array.isArray(parentFilters?.catalogs) && parentFilters.catalogs.map(String).includes('2050'); } catch { return false; }
              })();
              // Optional warmup: let leader run a couple ticks before enabling fanout
              let fanoutEnabled = true;
              try {
                const fam = familiesByParent.get(String(channel.channelName));
                const sig = fam?.sig;
                const st = sig ? familyState.get(sig) : null;
                if (st && st.warmup > 0) { st.warmup -= 1; familyState.set(sig, st); fanoutEnabled = false; }
              } catch {}
              if (!fanoutEnabled) ll('[fanout.warmup]', 'parent=', channel.channelName, 'parent_url=', canonicalizeUrl(channel.url));
  for (const child of (fanoutEnabled ? channel.children : [])) {
    const childRule = child.rule || child; // tolerate shape
    const baseFilters = child.filters || parseRuleFilters(childRule.url);
    // Policy: if parent has no catalog constraint, do not enforce child catalogs to avoid empty buckets
    const filters = { ...baseFilters };
    // Family key guard: ensure child and parent share the same strict key (brand+catalog)
    try {
      const pk = buildFamilyKeyFromURL(channel.url, 'auto');
      const ck = buildFamilyKeyFromURL(childRule.url, 'auto');
      if (pk && ck && pk !== ck) {
        try {
          const fam = await import('./rules/urlNormalizer.js');
          const pa = fam.canonicalizeForFamily(channel.url);
          const ch = fam.canonicalizeForFamily(childRule.url);
          const diff = [];
          if (String(pa.host) !== String(ch.host)) diff.push(`host:${pa.host}!=${ch.host}`);
          if (String(pa.path) !== String(ch.path)) diff.push(`path:${pa.path}!=${ch.path}`);
          const bA = (pa.brandIds||[]).join(','); const bB = (ch.brandIds||[]).join(',');
          if (bA !== bB) diff.push(`b:${bA}!=${bB}`);
          const cA = (pa.catalogs||[]).join(','); const cB = (ch.catalogs||[]).join(',');
          if (cA !== cB) diff.push(`c:${cA}!=${cB}`);
          if (String(pa.currency) !== String(ch.currency)) diff.push(`cur:${pa.currency}!=${ch.currency}`);
          console.warn('[family.url_mismatch]', 'parent_key=', pk, 'child_key=', ck, 'child_rule=', childRule.channelName, 'diff=', diff.join('|'));
        } catch {
          console.warn('[family.url_mismatch]', 'parent_key=', pk, 'child_key=', ck, 'child_rule=', childRule.channelName);
        }
        continue;
      }
    } catch {}
    // Inherit missing filters from parent (brand/catalog/size/status/currency)
    try {
      if ((!Array.isArray(filters.brandIds) || filters.brandIds.length === 0) && Array.isArray(parentFilters?.brandIds)) filters.brandIds = parentFilters.brandIds;
      if ((!Array.isArray(filters.catalogs) || filters.catalogs.length === 0) && Array.isArray(parentFilters?.catalogs)) filters.catalogs = parentFilters.catalogs;
      if ((!Array.isArray(filters.sizeIds) || filters.sizeIds.length === 0) && Array.isArray(parentFilters?.sizeIds)) filters.sizeIds = parentFilters.sizeIds;
      if ((!Array.isArray(filters.statusIds) || filters.statusIds.length === 0) && Array.isArray(parentFilters?.statusIds)) filters.statusIds = parentFilters.statusIds;
      if (!filters.currency && parentFilters?.currency) filters.currency = parentFilters.currency;
    } catch {}
    try {
      if (IGNORE_CAT_WHEN_PARENT_NONE && parentFilters && (
        !Array.isArray(parentFilters.catalogs) || parentFilters.catalogs.length === 0 || parentHasWildcard2050
      )) {
        filters.catalogs = [];
      }
    } catch {}
    // Gating: ensure brand & catalog equality; size/status subset policy
    try {
      const arrEq = (a,b)=>{
        const A = Array.isArray(a)?a.map(String).sort():[];
        const B = Array.isArray(b)?b.map(String).sort():[];
        return A.length===B.length && A.every((x,i)=>x===B[i]);
      };
      const isSubset = (sub, sup) => {
        const S = new Set((Array.isArray(sup)?sup:[]).map(String));
        for (const v of (Array.isArray(sub)?sub:[])) if (!S.has(String(v))) return false;
        return true;
      };
      // Allowed-dimension guard (configurable):
      // Strict mode (default): child may differ from parent in exactly one of: price_to OR size_ids OR status_ids
      // Relaxed mode: allow multiple diffs but still require brand/catalog/text/color/material consistency
      const priceEq = ((filters?.priceFrom ?? null) === (parentFilters?.priceFrom ?? null)) && ((filters?.priceTo ?? null) === (parentFilters?.priceTo ?? null));
      const priceOnly = ((filters?.priceTo ?? null) !== (parentFilters?.priceTo ?? null)) && ((filters?.priceFrom ?? null) === (parentFilters?.priceFrom ?? null));
      const sizeEq = arrEq(filters?.sizeIds, parentFilters?.sizeIds || []);
      const statusEq = arrEq(filters?.statusIds, parentFilters?.statusIds || []);
      const diffs = [];
      if (!priceEq) diffs.push('price');
      if (!sizeEq) diffs.push('size');
      if (!statusEq) diffs.push('status');
      const STRICT = String(process.env.FANOUT_STRICT_DIFF || '1') === '1';
      if (STRICT) {
        if (diffs.length > 1 || (diffs.length === 1 && diffs[0] === 'price' && !priceOnly)) {
          console.warn('[family.dim_mismatch]', 'parent=', channel.channelName, 'child=', childRule.channelName, 'diff=', diffs.join(','));
          continue;
        }
      }
      const pBrands = Array.isArray(parentFilters?.brandIds) ? parentFilters.brandIds : [];
      if (pBrands.length > 0 && !arrEq(pBrands, baseFilters?.brandIds)) {
        try { metrics.fanout_skipped_by_mismatch_total?.inc({ field: 'brand_ids' }); } catch {}
        console.warn('[fanout.skip]', 'reason=brand_mismatch', 'parent=', channel.channelName, 'child=', childRule.channelName);
        continue;
      }
      const pCats = Array.isArray(parentFilters?.catalogs) ? parentFilters.catalogs : [];
      const parentHasWildcard2050 = pCats.map(String).includes('2050');
      if (pCats.length > 0 && !parentHasWildcard2050 && !arrEq(pCats, baseFilters?.catalogs)) {
        try { metrics.fanout_skipped_by_mismatch_total?.inc({ field: 'catalog' }); } catch {}
        console.warn('[fanout.skip]', 'reason=catalog_mismatch', 'parent=', channel.channelName, 'child=', childRule.channelName);
        continue;
      }
      // Enforce equality for all other filters: text, color_ids, material_ids
      const pText = String(parentFilters?.text || '');
      const cText = String(baseFilters?.text || '');
      if (pText !== cText) {
        try { metrics.fanout_skipped_by_mismatch_total?.inc({ field: 'text' }); } catch {}
        console.warn('[fanout.skip]', 'reason=text_mismatch', 'parent=', channel.channelName, 'child=', childRule.channelName);
        continue;
      }
      if (!arrEq(parentFilters?.colorIds || [], baseFilters?.colorIds || [])) {
        try { metrics.fanout_skipped_by_mismatch_total?.inc({ field: 'color_ids' }); } catch {}
        console.warn('[fanout.skip]', 'reason=color_mismatch', 'parent=', channel.channelName, 'child=', childRule.channelName);
        continue;
      }
      if (!arrEq(parentFilters?.materialIds || [], baseFilters?.materialIds || [])) {
        try { metrics.fanout_skipped_by_mismatch_total?.inc({ field: 'material_ids' }); } catch {}
        console.warn('[fanout.skip]', 'reason=material_mismatch', 'parent=', channel.channelName, 'child=', childRule.channelName);
        continue;
      }
      // If parent lacks sizes/status → allow any child sizes/status
      const pSizes = Array.isArray(parentFilters?.sizeIds) ? parentFilters.sizeIds : [];
      const pStatus = Array.isArray(parentFilters?.statusIds) ? parentFilters.statusIds : [];
      if (pSizes.length > 0) {
        if (!isSubset(baseFilters?.sizeIds || [], pSizes)) {
          try { metrics.fanout_skipped_by_mismatch_total?.inc({ field: 'size_ids' }); } catch {}
          console.warn('[fanout.skip]', 'reason=size_subset_violation', 'parent=', channel.channelName, 'child=', childRule.channelName);
          continue;
        }
      }
      if (pStatus.length > 0) {
        if (!isSubset(baseFilters?.statusIds || [], pStatus)) {
          try { metrics.fanout_skipped_by_mismatch_total?.inc({ field: 'status_ids' }); } catch {}
          console.warn('[fanout.skip]', 'reason=status_subset_violation', 'parent=', channel.channelName, 'child=', childRule.channelName);
          continue;
        }
      }
    } catch {}
                const cfk = (()=>{ try { return buildFamilyKeyFromURL(childRule.url, 'auto'); } catch { return '?'; } })();
                ll('[fanout.eval.child]', 'child=', childRule.channelName, 'child_url=', canonicalizeUrl(childRule.url), 'family_key=', cfk);
                const matched = [];
                for (const it of articles) {
                  if (itemMatchesFilters(it, filters)) matched.push(it);
                }
                // Quarantine logic: if leader has items but child keeps matching 0 for several cycles
                try {
                  const fam = familiesByParent.get(String(channel.channelName));
                  const sig = fam?.sig;
                  const st = sig ? familyState.get(sig) : null;
                  const cname = String(childRule.channelName);
                  if (sig && st && st.child?.has?.(cname)) {
                    const rec = st.child.get(cname);
                    const leaderHas = Array.isArray(articles) && articles.length > 0;
                    // Softfail-aware zero-match increment: skip when recent soft-fail observed
                    const hadSoftFail = hadSoftFailRecently(channel.channelName, 30_000);
                    if (leaderHas && matched.length === 0 && typeof filters.priceTo === 'number' && !hadSoftFail) {
                      rec.zero = (rec.zero || 0) + 1;
                      if (rec.zero >= Number(process.env.MONO_QUARANTINE_THRESHOLD || 3)) {
                        rec.quarantined = true;
                        quarantinedChildren.add(cname);
                        console.warn('[family.quarantine]', 'parent=', channel.channelName, 'child=', cname, 'reason=consecutive_zero_matches');
                      }
                    } else if (matched.length > 0) {
                      rec.zero = 0;
                      if (rec.quarantined) {
                        rec.quarantined = false;
                        quarantinedChildren.delete(cname);
                        console.log('[family.rejoin]', 'parent=', channel.channelName, 'child=', cname);
                      }
                    }
                    st.child.set(cname, rec);
                    familyState.set(sig, st);
                  }
                } catch {}
                // Monotonie-Guard: Wenn Preis ≤ child.price_to und Brand/Catalog zum Parent passen,
                // aber das Child nicht matched → Violation loggen.
                try {
                  const cTo = typeof filters.priceTo === 'number' ? filters.priceTo : null;
                  if (cTo != null) {
                    for (const it of articles) {
                      const price = normalizedPrice(it, filters?.currency || 'EUR');
                      const bcOk = brandCatalogMatches(it, parentFilters || {});
                      if (!Number.isNaN(price) && bcOk && price <= cTo && !matched.includes(it)) {
                        const reason = debugMatchFailReason(it, filters) || 'unknown';
                        try { metrics.mono_violation_total?.inc({ parent: String(channel.channelName), child: String(childRule.channelName) }); } catch {}
                        console.warn('[mono_violation]', 'parent=', channel.channelName, 'child=', childRule.channelName, 'item=', it?.id, 'price=', price, 'brand=', String(it?.brand_id ?? it?.brand?.id ?? ''), 'catalog=', String(it?.catalog_id ?? it?.catalog?.id ?? ''), 'reason=', reason);
                      }
                    }
                  }
                } catch {}
                if (FANOUT_DEBUG) {
                  try {
                    ll('[fanout.eval.child]', 'child=', childRule.channelName, 'child_url=', canonicalizeUrl(childRule.url), 'matched=', `${matched.length}/${articles.length}`, 'price_from=', filters.priceFrom, 'price_to=', filters.priceTo, 'catalogs=', (filters.catalogs||[]).join(','));
                  } catch {}
                }
                if (!matched.length && articles.length) {
                  const sample = articles.slice(0, 5);
                  for (const it of sample) {
                    let reason = 'unknown';
                    try { reason = debugMatchFailReason(it, filters) || 'unknown'; } catch {}
                    const price = (()=>{ try { return normalizedPrice(it, filters?.currency || 'EUR'); } catch { return null; } })();
                    const bid = String(it?.brand_id ?? it?.brand?.id ?? '');
                    const cid = String(it?.catalog_id ?? it?.catalog?.id ?? '');
                    const title = String(it?.title || '').toLowerCase();
                    const titleBrand = /(nike|adidas|lacoste|ralph\s*lauren|reebok|puma|new\s*balance|dr\.?\s*martens)/i.test(title);
                    console.log('[match.debug]', 'rule=', childRule.channelName, 'item=', it?.id, 'fail=', reason, 'price=', price, 'price_to=', filters?.priceTo ?? '', 'brand=', bid, 'catalog=', cid, 'titleBrand=', titleBrand, 'childCats=', (filters?.catalogs||[]).join(','));
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
                  try {
                    const fk = (()=>{ try { return buildFamilyKeyFromURL(String(childRule.url || ''), 'auto'); } catch { return null; } })();
                    const key = dedupeKeyForChannel(childRule, article.id, fk);
                    processedStore.set(key, Date.now(), { ttl: ttlMs });
                  } catch {}
                });
                try { metrics.parent_fanout_items_total?.inc({ parent: String(channel.channelName), child: String(childRule.channelName) }, gated.length); } catch {}
              }
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
                // Parent post mode: all|unmatched|fresh (default all)
                const PMODE = String(process.env.FANOUT_PARENT_POST_MODE || 'all').toLowerCase();
                let parentItems = fresh;
                if (PMODE === 'all') parentItems = articles; // ignore freshness gating except ENFORCE_MAX above
                // unmatched mode would require tracking child-covered ids; fallback to fresh for now
                if (Array.isArray(parentItems) && parentItems.length) await postArticles(parentItems, dest, channel.channelName);
                articles.forEach(article => {
                  try {
                    const fk = (()=>{ try { return buildFamilyKeyFromURL(String(channel.url || ''), 'auto'); } catch { return null; } })();
                    const key = dedupeKeyForChannel(channel, article.id, fk);
                    processedStore.set(key, Date.now(), { ttl: ttlMs });
                  } catch {}
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
                        try {
                    const fk = (()=>{ try { return buildFamilyKeyFromURL(String(childRule.url || ''), 'auto'); } catch { return null; } })();
                    const key = dedupeKeyForChannel(childRule, article.id, fk);
                    processedStore.set(key, Date.now(), { ttl: ttlMs });
                  } catch {}
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
    try { const k = buildParentKey(search.url); activeSearches.set(search.channelName, { key: k, url: search.url }); } catch { activeSearches.set(search.channelName, { key: String(search.url||''), url: search.url }); }
    try { metrics.rules_active.set(activeSearches.size); } catch {}
};


function buildFamilies(mySearches) {
  let families = [];
  try {
    if (String(process.env.FANOUT_MODE || '1') === '1') {
      const strat = String(process.env.PARENTING_STRATEGY || 'auto_price');
      // Default: ignore config families for pure URL-based auto-grouping
      const USE_CFG = String(process.env.FANOUT_USE_CONFIG || '0') === '1';
      const allowMismatch = String(process.env.PARENTING_ALLOW_EXPLICIT_MISMATCH || '0') === '1' || strat !== 'exact_url';
      const configFamilies = USE_CFG ? loadFamiliesFromConfig(mySearches) : [];
      const explicit = allowMismatch && (process.env.FANOUT_PARENT_RULE && process.env.FANOUT_CHILD_RULES)
        ? buildExplicitFamily(mySearches, process.env.FANOUT_PARENT_RULE, process.env.FANOUT_CHILD_RULES)
        : null;
      if (configFamilies && configFamilies.length) families = configFamilies;
      else if (explicit && explicit.length) families = explicit;
      else if (strat === 'auto_price') families = buildAutoPriceFamilies(mySearches);
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
        const fk = buildFamilyKeyFromURL(fam.parent.url, 'auto');
        const pk = buildParentKey(fam.parent.url);
        const childNames = (fam.children||[]).map(c => c.rule?.channelName || c.channelName || '');
        ll('[fanout.family.detail]', 'familyKey=', fk, 'parentKey=', pk, 'parent=', fam.parent.channelName, 'parent_url=', canonicalizeUrl(fam.parent.url), 'children=', childNames.join(','));
        try { console.log('[fanout.children]', 'parent=', fam.parent.channelName, 'children_count=', childNames.length); } catch {}
        if (String(process.env.PARENTING_STRATEGY || 'exact_url') === 'exact_url' && fk !== pk) {
          console.warn('[fanout.warn] strategy=exact_url but familyKey!=parentKey for', fam.parent.channelName);
        }
      }
      // Non-family rules
      const inFam = new Set((families||[]).flatMap(f=> [f.parent.channelName, ...(f.children||[]).map(c=>c.rule?.channelName || c.channelName)]));
      for (const r of (mySearches||[])) if (!inFam.has(r.channelName)) ll('[fanout.standalone]', r.channelName);
    } catch {}
  }
  // Build runtime indices for families and initialize state
  try {
    familiesByParent.clear();
    for (const fam of (families || [])) {
      const sig = canonicalSignature(fam.parent);
      familiesByParent.set(String(fam.parent.channelName), { ...fam, sig });
      if (!familyState.has(sig)) {
        const childMap = new Map();
        for (const c of (fam.children || [])) {
          const nm = String(c.rule?.channelName || c.channelName || '');
          childMap.set(nm, { zero: 0, quarantined: false });
        }
        const WARM = Math.max(0, Number(process.env.FANOUT_WARMUP_CYCLES || 0));
        familyState.set(sig, { warmup: WARM, child: childMap });
      }
    }
  } catch {}
  return families;
}

function computeScheduleList(mySearches) {
  const families = buildFamilies(mySearches);
  // Audit price families for missing buckets (e.g., 30€)
  try { auditPriceFamilies(mySearches, families); } catch {}
  const parentNames = new Set();
  for (const fam of (families || [])) {
    const parent = fam.parent;
    parent.children = fam.children || [];
    parentNames.add(parent.channelName);
  }
  const toSchedule = [];
  if (families?.length) {
    // Always schedule parents
    toSchedule.push(...families.map(f => f.parent));
    // Schedule quarantined children solo
    for (const r of (mySearches || [])) if (quarantinedChildren.has(String(r.channelName))) toSchedule.push(r);
    // Schedule standalone rules not in any family
    const inFam = new Set();
    for (const fam of families) {
      inFam.add(fam.parent.channelName);
      for (const c of (fam.children || [])) inFam.add(c.rule?.channelName || c.channelName);
    }
    for (const r of (mySearches || [])) if (!inFam.has(r.channelName)) toSchedule.push(r);
  } else {
    toSchedule.push(...(mySearches || []));
  }
  // Apply tombstone filter (ignore recently deleted rules by name/key)
  const filtered = [];
  for (const r of toSchedule) {
    if (_isTombstonedName(r.channelName)) { console.warn('[rebuild.skip.tombstone]', 'name=', r.channelName); continue; }
    try { const k = buildParentKey(r.url); if (_isTombstonedKey(k)) { console.warn('[rebuild.skip.tombstone]', 'key=', k); continue; } } catch {}
    filtered.push(r);
  }
  return filtered;
}

// Audit price-bucket coverage for families (e.g. ensure 30€ bucket exists)
function auditPriceFamilies(searches, families) {
  try {
    const wantBuckets = (String(process.env.PRICE_BUCKETS || '10,15,20,30').split(',').map(s=>Number(s.trim())).filter(n=>Number.isFinite(n)));
    const wantSet = new Set(wantBuckets);
    for (const fam of (families || [])) {
      const parent = fam.parent;
      const childPriceTos = new Set();
      for (const c of (fam.children || [])) {
        const f = c.filters || parseRuleFilters(c.rule?.url || c.url || '');
        if (typeof f.priceTo === 'number') childPriceTos.add(f.priceTo);
      }
      // Only consider as price family if at least one child has price_to
      if (childPriceTos.size) {
        for (const b of wantSet) {
          if (!childPriceTos.has(b)) {
            try { metrics.missing_price_bucket_total?.inc({ parent: String(parent.channelName), bucket: String(b) }); } catch {}
            console.warn('[price_bucket.missing]', 'parent=', parent.channelName, 'bucket=', b);
          }
        }
      }
    }
  } catch {}
}

export function rebuildFromList(client, list) {
  // Zero-downtime diff update: add/update/remove without stopping all
  const toSchedule = computeScheduleList(list || []);
  try { learnFromRules(list || []); } catch {}
  const newMap = new Map();
  for (const r of toSchedule) newMap.set(r.channelName, r);
  const newKeySet = new Set();
  for (const r of toSchedule) { try { newKeySet.add(buildParentKey(r.url)); } catch { newKeySet.add(String(r.url||'')); } }
  try { metrics.scheduler_reload_events_total.inc(); } catch {}
  try { console.log('[rebuild] applying diff… newRules=%d', newMap.size); } catch {}
  // Update or add
  for (const [name, rule] of newMap.entries()) {
    if (activeSearches.has(name)) {
      try { edf.updateRule(rule); } catch {}
      try { const k = buildParentKey(rule.url); activeSearches.set(name, { key: k, url: rule.url }); } catch { activeSearches.set(name, { key: String(rule.url||''), url: rule.url }); }
    } else {
      addSearch(client, rule);
    }
  }
  // Remove absent
  for (const name of Array.from(activeSearches.keys())) {
    if (!newMap.has(name)) {
      try { console.log('[rule.deleted]', 'name=', name); } catch {}
      try { metrics.rules_removed_total?.inc(); } catch {}
      removeJob(name);
    }
  }
  // Additional pruning by canonical key
  for (const [name, info] of Array.from(activeSearches.entries())) {
    try {
      const k = String(info?.key || '');
      if (k && !newKeySet.has(k)) {
        console.warn('[rule.deleted.extra]', 'name=', name, 'reason=canonical_key_prune');
        try { metrics.rules_removed_total?.inc(); } catch {}
        removeJob(name);
      }
    } catch {}
  }
  edf.start();
  try { metrics.scheduler_rules_total.set(activeSearches.size); } catch {}
}

export async function rebuildFromDisk(client) {
  try {
    const fsmod = await import('fs');
    const path = await import('path');
    const searches = JSON.parse(fsmod.readFileSync(path.resolve('./config/channels.json'),'utf-8'));
    try { learnFromRules(searches || []); } catch {}
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
        try { learnFromRules(searches || []); } catch {}
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
    try { edf.hardRemove?.(name) || edf.removeRule(name); } catch {}
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
export async function restartAll(client, _ignored) {
  // Back-compat shim: always read from disk to avoid stale snapshots
  try {
    console.log('[schedule] restartAll → rebuildFromDisk (compat)');
    await rebuildFromDisk(client);
  } catch (e) {
    console.warn('[schedule] restartAll failed:', e?.message || e);
  }
}

// Introspect currently built families for diagnostics and commands
export function getFamiliesSnapshot() {
  try {
    const list = [];
    for (const [pname, fam] of familiesByParent.entries()) {
      const parentUrl = String(fam?.parent?.url || fam?.parent?.link || '');
      let familyKey = null, parentKey = null;
      try { familyKey = buildFamilyKeyFromURL(parentUrl, 'auto'); } catch {}
      try { parentKey = buildParentKey(parentUrl); } catch {}
      const children = (fam?.children || []).map(c => ({ name: String(c?.rule?.channelName || c?.channelName || ''), url: String(c?.rule?.url || c?.url || '') }));
      list.push({ parent: { name: pname, url: parentUrl }, familyKey, parentKey, children });
    }
    return list;
  } catch { return []; }
}

function countActiveBackfill() {
  const now = Date.now();
  let n = 0; for (const st of ruleState.values()) if ((st.backfillOnUntil || 0) > now) n++;
  return n;
}
