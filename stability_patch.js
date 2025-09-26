/**
 * stability_patch.js
 * Drop-in Stabilitaets-Fixes fuer euren Vinted->Discord Bot:
 *  - Harte Deadlines + AbortController (Requests haengen nicht mehr endlos)
 *  - Getrennte Queues: SCRAPE (Vinted) und POST (Discord)
 *  - Deduplizierung (pro Rule lastSeen)
 *  - Stall-Watchdog (killt haengengebliebene Jobs und gibt Slots frei)
 *
 * Laeuft ohne zusaetzliche Dependencies (Node 18+ fuer global fetch).
 *
 * Integration:
 *  1) RULES unten befuellen ODER eure bestehende Rule-Liste hier durchreichen.
 *  2) runBot(rules) in eurer main() aufrufen (oder Export uebernehmen).
 *  3) Vinted-URL & Discord-Webhook je Rule setzen.
 *
 * WICHTIG: Keine neuen Pakete installieren. Proxy bleibt wie gehabt (ProxyScrape).
 * Falls ihr bereits eigenen Proxy-Fetch nutzt, ersetzt in fetchJson() den fetch()-Call.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const log = {
  info(tag, msg, extra) {
    const base = `${ts()} INF  ${tag} ${msg ?? ''}`.trimEnd();
    if (extra && Object.keys(extra).length > 0) {
      console.log(base, safeJson(extra));
    } else {
      console.log(base);
    }
  },
  err(tag, msg, extra) {
    const base = `${ts()} ERR  ${tag} ${msg ?? ''}`.trimEnd();
    if (extra && Object.keys(extra).length > 0) {
      console.error(base, safeJson(extra));
    } else {
      console.error(base);
    }
  },
};

const CONFIG = {
  SCRAPE_CONCURRENCY: numFromEnv('SCRAPE_CONCURRENCY', 4),
  POST_CONCURRENCY: numFromEnv('POST_CONCURRENCY', 6),
  VINTED_HARD_DEADLINE_MS: numFromEnv('VINTED_HARD_DEADLINE_MS', 15_000),
  VINTED_RETRY: numFromEnv('VINTED_RETRY', 2),
  VINTED_BACKOFF_MS: numFromEnv('VINTED_BACKOFF_MS', 600),
  POST_HARD_DEADLINE_MS: numFromEnv('POST_HARD_DEADLINE_MS', 10_000),
  POST_RETRY: numFromEnv('POST_RETRY', 2),
  POST_BACKOFF_MS: numFromEnv('POST_BACKOFF_MS', 500),
  STALL_CHECK_INTERVAL_MS: numFromEnv('STALL_CHECK_INTERVAL_MS', 5_000),
  STALL_KILL_AFTER_MS: numFromEnv('STALL_KILL_AFTER_MS', 30_000),
  LAST_SEEN_PATH: process.env.LAST_SEEN_PATH || '',
  USER_AGENT: process.env.USER_AGENT || DEFAULT_USER_AGENT,
};

const lastSeen = new Map();
const seenIdsTTL = new Map();
const SEEN_TTL_MS = 60 * 60 * 1000;

const metrics = (() => {
  const win = new Map();
  const MAX = 120;
  return {
    observe(label, ms) {
      if (!label) return;
      const arr = win.get(label) || [];
      arr.push(ms);
      if (arr.length > MAX) arr.shift();
      win.set(label, arr);
    },
    p95(label) {
      const arr = win.get(label);
      if (!arr || arr.length === 0) return 0;
      return Math.floor(percentile(arr, 95));
    },
  };
})();

function ts() {
  try {
    return new Date().toISOString().replace('T', ' ').replace('Z', 'Z');
  } catch {
    return String(Date.now());
  }
}

function safeJson(x) {
  try {
    if (x === null || x === undefined) return '';
    if (typeof x === 'string') return x;
    return JSON.stringify(x);
  } catch (e) {
    try {
      return String(e?.message || e);
    } catch {
      return '[unserializable]';
    }
  }
}

function numFromEnv(key, fallback) {
  const raw = process.env?.[key];
  if (raw === undefined) return fallback;
  const val = Number(raw);
  return Number.isFinite(val) ? val : fallback;
}

function jitter(baseMs) {
  const base = Math.max(0, Number(baseMs) || 0);
  const j = Math.floor(Math.random() * base * 0.4);
  return base + (Math.random() < 0.5 ? -j : j);
}

function percentile(arr, p) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

async function loadLastSeen() {
  if (!CONFIG.LAST_SEEN_PATH) return;
  try {
    const raw = await readFile(CONFIG.LAST_SEEN_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    for (const [k, v] of Object.entries(parsed)) {
      if (v && typeof v === 'object') {
        const createdAt = Number(v.createdAt) || 0;
        const itemId = Number(v.itemId) || 0;
        lastSeen.set(k, { createdAt, itemId });
      }
    }
    log.info('dedupe', 'loaded lastSeen', { count: lastSeen.size });
  } catch (e) {
    log.err('dedupe', 'load failed (ok bei erster Ausfuehrung)', { error: e?.message || String(e) });
  }
}

async function saveLastSeen() {
  if (!CONFIG.LAST_SEEN_PATH) return;
  try {
    const out = Object.fromEntries(lastSeen.entries());
    await writeFile(CONFIG.LAST_SEEN_PATH, JSON.stringify(out, null, 2), 'utf8');
  } catch (e) {
    log.err('dedupe', 'save failed', { error: e?.message || String(e) });
  }
}

function pruneSeenTTL(ruleId) {
  const m = seenIdsTTL.get(ruleId);
  if (!m) return;
  const now = Date.now();
  for (const [id, exp] of [...m.entries()]) {
    if (exp <= now) m.delete(id);
  }
  if (m.size === 0) seenIdsTTL.delete(ruleId);
}

function markSeen(ruleId, item) {
  const ttlMap = seenIdsTTL.get(ruleId) || new Map();
  ttlMap.set(item.id, Date.now() + SEEN_TTL_MS);
  seenIdsTTL.set(ruleId, ttlMap);
  const prev = lastSeen.get(ruleId) || { createdAt: 0, itemId: 0 };
  const createdAt = item.created_at ? Number(new Date(item.created_at)) : prev.createdAt || 0;
  lastSeen.set(ruleId, {
    createdAt: Math.max(prev.createdAt || 0, createdAt || 0),
    itemId: Math.max(prev.itemId || 0, Number(item.id) || 0),
  });
}

async function fetchJson(url, { signal, locale } = {}) {
  const res = await fetch(url, {
    signal,
    headers: {
      'user-agent': CONFIG.USER_AGENT,
      accept: 'application/json, text/plain, */*',
      'accept-language': locale || 'de-DE,de;q=0.9,en;q=0.8',
      'cache-control': 'no-cache',
      pragma: 'no-cache',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` :: ${text.slice(0, 120)}` : ''}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    return res.json();
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Unexpected content-type: ${ct}`);
  }
}

async function withHardDeadline(fn, hardMs, label) {
  const start = Date.now();
  const parsed = Number(hardMs);
  const deadlineMs = Number.isFinite(parsed) ? Math.max(1, parsed) : 1;
  const controller = new AbortController();
  let timeoutId = null;
  let timedOut = false;
  const timeoutErr = new Error('HARD_DEADLINE_EXCEEDED');
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      try { controller.abort(timeoutErr); } catch {}
      reject(timeoutErr);
    }, deadlineMs);
  });
  const fnPromise = (async () => {
    try {
      return await fn(controller.signal);
    } catch (err) {
      if (timedOut && (err === timeoutErr || err?.name === 'AbortError' || err?.message === timeoutErr.message)) {
        throw timeoutErr;
      }
      throw err;
    }
  })();
  try {
    return await Promise.race([fnPromise, timeoutPromise]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
    try { metrics.observe(label, Date.now() - start); } catch {}
    if (timedOut) {
      fnPromise.catch(() => {});
    }
  }
}

async function retryingRequest(requestFn, { hardMs, maxRetry, backoffMs, label }) {
  let attempt = 0;
  while (true) {
    try {
      return await withHardDeadline(requestFn, hardMs, label);
    } catch (e) {
      if (attempt >= maxRetry) throw e;
      await sleep(jitter(backoffMs * Math.pow(2, attempt)));
      attempt += 1;
    }
  }
}

async function retryingJson(url, { hardMs, maxRetry, backoffMs, locale, label }) {
  return retryingRequest((signal) => fetchJson(url, { signal, locale }), {
    hardMs,
    maxRetry,
    backoffMs,
    label,
  });
}

class Queue {
  constructor(name, concurrency, hardDeadlineMs) {
    this.name = name;
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.hardDeadlineMs = Math.max(1_000, Number(hardDeadlineMs) || 1_000);
    this.q = [];
    this.inflight = new Set();
    this._draining = false;
  }

  size() {
    return this.q.length;
  }

  inflightCount() {
    return this.inflight.size;
  }

  push(job) {
    if (typeof job !== 'function') return;
    this.q.push({ job, enqueuedAt: Date.now() });
    this._drain();
  }

  async _drain() {
    if (this._draining) return;
    this._draining = true;
    try {
      while (this.inflight.size < this.concurrency && this.q.length > 0) {
        const task = this.q.shift();
        if (!task) break;
        const controller = new AbortController();
        const record = {
          controller,
          startedAt: Date.now(),
          job: task.job,
        };
        this.inflight.add(record);
        const timeoutId = setTimeout(() => {
          try {
            controller.abort(new Error('HARD_DEADLINE_EXCEEDED'));
          } catch {}
        }, this.hardDeadlineMs);

        (async () => {
          try {
            await task.job(controller.signal);
          } catch (err) {
            log.err(this.name, 'job failed', { error: err?.message || String(err) });
          } finally {
            clearTimeout(timeoutId);
            this.inflight.delete(record);
            this._drain();
          }
        })();
      }
    } finally {
      this._draining = false;
    }
  }

  abortExpired(olderThanMs) {
    const now = Date.now();
    let killed = 0;
    for (const rec of Array.from(this.inflight)) {
      if (now - rec.startedAt >= olderThanMs) {
        try {
          rec.controller.abort(new Error('STALL_KILL'));
        } catch {}
        killed += 1;
      }
    }
    return killed;
  }
}

async function scrapeOnce(rule) {
  const data = await retryingJson(rule.url, {
    hardMs: CONFIG.VINTED_HARD_DEADLINE_MS,
    maxRetry: CONFIG.VINTED_RETRY,
    backoffMs: CONFIG.VINTED_BACKOFF_MS,
    locale: rule.locale,
    label: 'scrape_ms',
  });
  const items = extractItems(data);
  const fresh = filterNewForRule(rule.id, items);
  if (fresh.length) {
    log.info('scrape', `rule=${rule.id} new=${fresh.length}`);
  }
  return fresh;
}

function extractItems(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.items)) return payload.items.map(normalizeItem);
  if (Array.isArray(payload.catalog_items)) return payload.catalog_items.map(normalizeItem);
  if (Array.isArray(payload)) return payload.map(normalizeItem);
  return [];
}

function normalizeItem(it) {
  const id = it?.id ?? it?.item_id ?? 0;
  return {
    id,
    title: it?.title ?? it?.description ?? '',
    price: it?.price ?? it?.price_eur ?? it?.price_numeric ?? null,
    currency: it?.currency ?? 'EUR',
    url: it?.url ?? (id ? `https://www.vinted.de/items/${id}` : undefined),
    created_at: it?.created_at ?? it?.photo_highlight_end_at ?? null,
    brand: it?.brand ?? it?.brand_title ?? '',
    size: it?.size ?? it?.size_title ?? '',
    img: it?.photo?.url ?? it?.photos?.[0]?.url ?? it?.image_url ?? undefined,
  };
}

function filterNewForRule(ruleId, items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  pruneSeenTTL(ruleId);
  const ttl = seenIdsTTL.get(ruleId) || new Map();
  const prev = lastSeen.get(ruleId) || { createdAt: 0, itemId: 0 };
  const out = [];
  for (const it of items) {
    if (!it?.id) continue;
    if (ttl.has(it.id)) continue;
    const created = it.created_at ? Number(new Date(it.created_at)) : 0;
    const isNew = created ? created > (prev.createdAt || 0) : Number(it.id) > (prev.itemId || 0);
    if (!isNew) continue;
    out.push(it);
    markSeen(ruleId, it);
  }
  return out;
}

async function postToDiscord(rule, items) {
  if (!Array.isArray(items) || items.length === 0) return;
  for (const it of items) {
    await retryingRequest(async (signal) => {
      const res = await fetch(rule.webhook, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: `**${escapeMarkdown(it.title || 'Neue Anzeige')}**\n${it.url || ''}`.trim(),
          embeds: [
            {
              title: (it.title || 'Vinted').slice(0, 240),
              url: it.url,
              thumbnail: it.img ? { url: it.img } : undefined,
              fields: compactFields([
                it.price != null
                  ? {
                      name: 'Preis',
                      value: `${it.price} ${it.currency || ''}`.trim(),
                      inline: true,
                    }
                  : null,
                it.brand
                  ? {
                      name: 'Marke',
                      value: it.brand,
                      inline: true,
                    }
                  : null,
                it.size
                  ? {
                      name: 'Groesse',
                      value: it.size,
                      inline: true,
                    }
                  : null,
              ]),
            },
          ],
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Discord HTTP ${res.status} ${res.statusText}${text ? ` :: ${text.slice(0, 120)}` : ''}`);
      }
    }, {
      hardMs: CONFIG.POST_HARD_DEADLINE_MS,
      maxRetry: CONFIG.POST_RETRY,
      backoffMs: CONFIG.POST_BACKOFF_MS,
      label: 'post_ms',
    }).catch((err) => {
      log.err('post', `failed for rule=${rule.id} item=${it.id}`, { error: err?.message || String(err) });
    });
  }
}

function compactFields(arr) {
  return arr.filter(Boolean);
}

function escapeMarkdown(str) {
  return String(str || '').replace(/([*_`])/g, '\$1');
}

class EDFScheduler {
  constructor(rules) {
    this.rules = (rules || []).map((r) => ({ ...r, nextAt: 0 }));
  }

  due(now) {
    return this.rules
      .filter((r) => now >= (r.nextAt || 0))
      .sort((a, b) => (a.nextAt || 0) - (b.nextAt || 0));
  }

  schedule(rule, now) {
    const interval = Math.max(1_000, Number(rule.intervalMs) || 5_000);
    rule.nextAt = now + interval;
  }
}

function ruleWithSignal(rule, signal) {
  return { ...rule, _signal: signal };
}

export async function runBot(rules) {
  const validatedRules = Array.isArray(rules) ? rules.filter(Boolean) : [];
  if (validatedRules.length === 0) {
    log.err('config', 'Keine RULES definiert. rules-Array fuellen oder runBot(rules) extern aufrufen.');
    return;
  }

  await loadLastSeen();

  const sched = new EDFScheduler(validatedRules);
  const scrapeQ = new Queue('scrape', CONFIG.SCRAPE_CONCURRENCY, CONFIG.VINTED_HARD_DEADLINE_MS);
  const postQ = new Queue('post', CONFIG.POST_CONCURRENCY, CONFIG.POST_HARD_DEADLINE_MS);

  setInterval(() => {
    const now = Date.now();
    const due = sched.due(now);
    const readyLeft = Math.max(0, CONFIG.SCRAPE_CONCURRENCY - scrapeQ.inflightCount());
    let dispatched = 0;

    for (const rule of due) {
      if (scrapeQ.inflightCount() >= CONFIG.SCRAPE_CONCURRENCY) break;
      dispatched += 1;
      sched.schedule(rule, now);
      scrapeQ.push(async (signal) => {
        try {
          const items = await scrapeOnce(ruleWithSignal(rule, signal));
          if (items.length) {
            postQ.push(async (signalPost) => {
              try {
                await postToDiscord(ruleWithSignal(rule, signalPost), items);
              } catch (err) {
                log.err('post.queue', 'failed', { error: err?.message || String(err) });
              }
            });
          }
        } catch (err) {
          log.err('scrape', `rule=${rule.id} failed`, { error: err?.message || String(err) });
        }
      });
    }

    log.info('sched.edf.tick', '', {
      dispatched,
      inflight: scrapeQ.inflightCount(),
      readyLeft: Math.max(0, CONFIG.SCRAPE_CONCURRENCY - scrapeQ.inflightCount()),
      ready: due.length,
      rules: validatedRules.length,
    });

    log.info('post.tick', '', {
      slotsLeft: Math.max(0, CONFIG.POST_CONCURRENCY - postQ.inflightCount()),
      totalQ: postQ.size(),
      post_p95_ms: metrics.p95('post_ms'),
    });
  }, 1_000).unref?.();

  setInterval(() => {
    const killedScrape = scrapeQ.abortExpired(CONFIG.STALL_KILL_AFTER_MS);
    const killedPost = postQ.abortExpired(CONFIG.STALL_KILL_AFTER_MS);
    if (killedScrape || killedPost) {
      log.err('sched.edf.stall', 'killed expired', {
        scrapeKilled: killedScrape,
        postKilled: killedPost,
      });
    }
    log.info('obs', '', {
      rpm: 0,
      post_p95_ms: metrics.p95('post_ms'),
      scrape_p95_ms: metrics.p95('scrape_ms'),
    });
  }, CONFIG.STALL_CHECK_INTERVAL_MS).unref?.();

  if (CONFIG.LAST_SEEN_PATH) {
    setInterval(() => {
      saveLastSeen().catch(() => {});
    }, 30_000).unref?.();
  }

  log.info('boot', 'running', {
    SCRAPE_CONCURRENCY: CONFIG.SCRAPE_CONCURRENCY,
    POST_CONCURRENCY: CONFIG.POST_CONCURRENCY,
  });
}

export const RULES = [];

const isMain = (() => {
  try {
    const url = new URL(import.meta.url);
    return url.pathname === new URL(`file://${process.argv[1] || ''}`).pathname;
  } catch {
    return false;
  }
})();

if (isMain) {
  if (RULES.length === 0) {
    log.err('config', 'Keine RULES definiert. RULES-Array fuellen oder runBot(rules) extern aufrufen.');
  } else {
    runBot(RULES).catch((err) => {
      log.err('boot', 'runBot failed', { error: err?.message || String(err) });
      process.exitCode = 1;
    });
  }
}
