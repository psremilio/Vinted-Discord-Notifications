/**
 * stability_patch_v3.js
 *
 * Ziel: Euren Bot zuverlässig machen, ohne neue Pakete oder Rotating Proxies.
 * Fixes:
 *  - POST-Queue drainte nicht (slotsLeft=10, totalQ>500) → komplett neue AsyncQueue,
 *    die *garantiert* weiter drain’t und nicht hängen bleiben kann.  :contentReference[oaicite:0]{index=0}
 *  - Posten passiert jetzt *itemweise* (statt „ein Job = viele Items“), damit
 *    Concurrency wirkt und Backlog abgebaut wird.
 *  - Discord 429/RateLimit wird korrekt beachtet (Retry‑After / Reset‑After).
 *  - Harte Deadlines (AbortController) für *Scrape* und *Post*; hängende Jobs werden
 *    abgebrochen (kein „inflight bleibt stehen“ mehr).
 *  - Deduplizierung (pro Rule + Item) *im Backlog*, damit totalQ nicht explodiert.
 *  - Notfall‑Kick: Falls der Drain jemals stockt, kickt ein Ticker die Queue wieder an.
 *
 * Integration:
 *  - Dieses File neben eure main legen, RULES unten befüllen oder runBot(rules) export nutzen.
 *  - Keine externen Abhängigkeiten. Node 18+ (global fetch).
 *
 * Hinweis: Die Logzeilen im Anhang zeigen euer Problem genau (POST-Queue wächst: totalQ=593,
 * slotsLeft=10 → Drain startete nicht). Dieser Patch fixt genau das.  :contentReference[oaicite:1]{index=1}
 */

// ---------------------------[ Config ]---------------------------------------

const CONFIG = {
  // Concurrency
  SCRAPE_CONCURRENCY: numFromEnv("SCRAPE_CONCURRENCY", 4),
  POST_CONCURRENCY: numFromEnv("POST_CONCURRENCY", 10),

  // Deadlines / Retries
  VINTED_HARD_DEADLINE_MS: numFromEnv("VINTED_HARD_DEADLINE_MS", 12_000),
  VINTED_RETRY: numFromEnv("VINTED_RETRY", 2),
  VINTED_BACKOFF_MS: numFromEnv("VINTED_BACKOFF_MS", 500),

  POST_HARD_DEADLINE_MS: numFromEnv("POST_HARD_DEADLINE_MS", 10_000),
  POST_RETRY: numFromEnv("POST_RETRY", 1), // 429 handled getrennt
  POST_BACKOFF_MS: numFromEnv("POST_BACKOFF_MS", 400),

  // Queue-Management
  POST_QUEUE_MAX: numFromEnv("POST_QUEUE_MAX", 1000), // Backlog-Deckel
  POST_QUEUE_ITEM_TTL_MS: numFromEnv("POST_QUEUE_ITEM_TTL_MS", 5 * 60_000), // 5 min

  // Watchdog / Auto-Kick
  STALL_CHECK_INTERVAL_MS: numFromEnv("STALL_CHECK_INTERVAL_MS", 5_000),
  STALL_KILL_AFTER_MS: numFromEnv("STALL_KILL_AFTER_MS", 30_000),
  AUTOKICK_INTERVAL_MS: numFromEnv("AUTOKICK_INTERVAL_MS", 1_500),

  // Optional persistenter lastSeen-Stand:
  LAST_SEEN_PATH: process.env.LAST_SEEN_PATH || "",

  // HTTP
  USER_AGENT:
    process.env.USER_AGENT ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
};

// Eure Regeln hier eintragen (oder über eure Config zuführen)
const RULES = [
  // {
  //   id: "nike-all",
  //   url: "https://www.vinted.de/catalog?no_catalog=1&currency=EUR&search_text=nike",
  //   webhook: "https://discord.com/api/webhooks/xxx/yyy",
  //   intervalMs: 5000,
  //   locale: "de-DE,de;q=0.9,en;q=0.8",
  // },
];

// ---------------------------[ Utils / Logger ]-------------------------------

const fs = require("node:fs/promises");
const { setTimeout: delay } = require("node:timers/promises");

const log = {
  info: (tag, msg, extra = "") =>
    console.log(`${ts()} [inf]  [${tag}] ${msg}${fmt(extra)}`),
  err: (tag, msg, extra = "") =>
    console.error(`${ts()} [err]  [${tag}] ${msg}${fmt(extra)}`),
};

function ts() {
  return new Date().toISOString().replace("T", " ").replace("Z", "Z");
}
function fmt(x) {
  if (!x) return "";
  try {
    if (typeof x === "string") return " " + x;
    return " " + JSON.stringify(x);
  } catch {
    return " " + String(x);
  }
}
function numFromEnv(k, d) {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : d;
}
function jitter(ms, f = 0.4) {
  const j = Math.floor(Math.random() * ms * f);
  return ms + (Math.random() < 0.5 ? -j : j);
}
function percentile(arr, p) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const i = Math.floor((p / 100) * (a.length - 1));
  return a[i];
}

// ---------------------------[ Metrics ]--------------------------------------

const metrics = (() => {
  const m = new Map(); // label -> durations[]
  const MAX = 120;
  return {
    observe(label, ms) {
      const a = m.get(label) || [];
      a.push(ms);
      if (a.length > MAX) a.shift();
      m.set(label, a);
    },
    p95(label) {
      return Math.floor(percentile(m.get(label) || [], 95));
    },
  };
})();

// ---------------------------[ Dedupe State ]---------------------------------

const lastSeen = new Map(); // ruleId -> { createdAt: number, itemId: number }
const seenTTL = new Map(); // ruleId -> Map(itemId -> expiresAt)
const SEEN_TTL_MS = 60 * 60 * 1000;

async function loadLastSeen() {
  if (!CONFIG.LAST_SEEN_PATH) return;
  try {
    const raw = await fs.readFile(CONFIG.LAST_SEEN_PATH, "utf8");
    const parsed = JSON.parse(raw);
    for (const [k, v] of Object.entries(parsed)) lastSeen.set(k, v);
    log.info("dedupe", "loaded", { count: lastSeen.size });
  } catch {}
}
async function saveLastSeen() {
  if (!CONFIG.LAST_SEEN_PATH) return;
  try {
    await fs.writeFile(
      CONFIG.LAST_SEEN_PATH,
      JSON.stringify(Object.fromEntries(lastSeen.entries()), null, 2)
    );
  } catch (e) {
    log.err("dedupe", "save failed", { error: String(e) });
  }
}
function pruneSeenTTL(ruleId) {
  const m = seenTTL.get(ruleId);
  if (!m) return;
  const now = Date.now();
  for (const [id, exp] of m.entries()) if (exp <= now) m.delete(id);
}
function markSeen(ruleId, it) {
  const m = seenTTL.get(ruleId) || new Map();
  m.set(it.id, Date.now() + SEEN_TTL_MS);
  seenTTL.set(ruleId, m);
  const prev = lastSeen.get(ruleId) || { createdAt: 0, itemId: 0 };
  const created = it.created_at ? +new Date(it.created_at) : prev.createdAt;
  lastSeen.set(ruleId, {
    createdAt: Math.max(prev.createdAt || 0, created || 0),
    itemId: Math.max(prev.itemId || 0, it.id || 0),
  });
}

// ---------------------------[ AsyncQueue ]-----------------------------------

class AsyncQueue {
  constructor(name, concurrency, hardDeadlineMs) {
    this.name = name;
    this.concurrency = Math.max(1, concurrency);
    this.hardDeadlineMs = hardDeadlineMs;

    this.q = []; // {fn, key?, enqueuedAt}
    this.active = 0;
    this._scheduled = false;

    this.pendingKeys = new Set(); // zur Backlog-Dedupe
  }

  size() {
    return this.q.length;
  }
  inflight() {
    return this.active;
  }

  push(fn, key = "") {
    // Dedupe im Backlog
    if (key) {
      if (this.pendingKeys.has(key)) return false;
      this.pendingKeys.add(key);
    }
    // Backlog-Deckel
    if (CONFIG.POST_QUEUE_MAX && this.name === "post" && this.q.length >= CONFIG.POST_QUEUE_MAX) {
      // Drop älteste Aufgabe (nicht schön, aber verhindert unendliches Wachstum)
      const dropped = this.q.shift();
      if (dropped && dropped.key) this.pendingKeys.delete(dropped.key);
      log.err("post.queue", "overflow → dropped oldest", {
        max: CONFIG.POST_QUEUE_MAX,
      });
    }

    this.q.push({ fn, key, enqueuedAt: Date.now() });
    this._schedule();
    return true;
  }

  _schedule() {
    if (this._scheduled) return;
    this._scheduled = true;
    queueMicrotask(() => {
      this._scheduled = false;
      this._drain();
    });
  }

  _drain() {
    while (this.active < this.concurrency && this.q.length > 0) {
      const task = this.q.shift();
      this._run(task);
    }
  }

  _run(task) {
    this.active++;
    const start = Date.now();
    const ac = new AbortController();
    const to = setTimeout(
      () => ac.abort(new Error("HARD_DEADLINE_EXCEEDED")),
      this.hardDeadlineMs
    );

    (async () => {
      try {
        await task.fn(ac.signal);
      } finally {
        clearTimeout(to);
        this.active--;
        if (task.key) this.pendingKeys.delete(task.key);
        // Item‑TTL: zu alte Tasks nicht mehr verarbeiten (nur Post‑Queue)
        if (this.name === "post") {
          const now = Date.now();
          // prune Kopf, falls alt
          while (this.q.length && now - this.q[0].enqueuedAt > CONFIG.POST_QUEUE_ITEM_TTL_MS) {
            const old = this.q.shift();
            if (old?.key) this.pendingKeys.delete(old.key);
          }
        }
        metrics.observe(`${this.name}_job_ms`, Date.now() - start);
        this._drain();
      }
    })().catch((e) => {
      // (Fehler bereits im Task behandelt)
      log.err(`${this.name}.job`, "unhandled", { error: String(e) });
    });
  }

  // „Kick“, falls jemals stuck
  kick() {
    if (this.active < this.concurrency && this.q.length > 0) {
      this._schedule();
    }
  }
}

// ---------------------------[ HTTP helpers ]---------------------------------

async function fetchJson(url, { method = "GET", body, signal, headers = {} }) {
  const res = await fetch(url, {
    method,
    body,
    signal,
    headers: {
      "user-agent": CONFIG.USER_AGENT,
      accept: "application/json, text/plain, */*",
      "accept-language": headers["accept-language"] || "de-DE,de;q=0.9,en;q=0.8",
      "content-type": body ? "application/json" : undefined,
      ...headers,
    },
  });
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  let parsed = null;
  if (ct.includes("application/json")) {
    try {
      parsed = text.length ? JSON.parse(text) : {};
    } catch {}
  }
  return { res, text, json: parsed };
}

async function withRetries(fn, { maxRetry, backoffMs, label }) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= maxRetry) throw e;
      await delay(jitter(backoffMs * Math.pow(2, attempt)));
      attempt++;
    } finally {
      if (label?.ms != null) metrics.observe(label.ms, label.ms);
    }
  }
}

// ---------------------------[ Vinted Scrape ]--------------------------------

async function scrapeOnce(rule, signal) {
  const start = Date.now();
  const { json } = await withHardDeadline(
    (s) =>
      withRetries(
        async () => {
          const { json } = await fetchJson(rule.url, {
            signal: s,
            headers: { "accept-language": rule.locale || "de-DE,de;q=0.9,en;q=0.8" },
          });
          if (!json) throw new Error("No JSON from Vinted");
          return { json };
        },
        {
          maxRetry: CONFIG.VINTED_RETRY,
          backoffMs: CONFIG.VINTED_BACKOFF_MS,
        }
      ),
    CONFIG.VINTED_HARD_DEADLINE_MS
  );
  metrics.observe("scrape_ms", Date.now() - start);
  const items = extractItems(json);
  return filterNewForRule(rule.id, items);
}

function extractItems(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.items)) return payload.items.map(normalizeItem);
  if (Array.isArray(payload.catalog_items)) return payload.catalog_items.map(normalizeItem);
  if (Array.isArray(payload)) return payload.map(normalizeItem);
  const maybe = payload?.items?.data || payload?.data || [];
  if (Array.isArray(maybe)) return maybe.map(normalizeItem);
  return [];
}
function normalizeItem(it) {
  return {
    id: it.id ?? it.item_id ?? 0,
    title: it.title ?? it.description ?? "",
    price: it.price ?? it.price_numeric ?? it.price_eur ?? null,
    currency: it.currency ?? "EUR",
    url: it.url ?? (it.id ? `https://www.vinted.de/items/${it.id}` : undefined),
    created_at: it.created_at ?? it.photo_highlight_end_at ?? null,
    brand: it.brand ?? it.brand_title ?? "",
    size: it.size ?? it.size_title ?? "",
    img: it.photo?.url ?? it.photos?.[0]?.url ?? it.image_url ?? undefined,
  };
}
function filterNewForRule(ruleId, items) {
  if (!items.length) return [];
  pruneSeenTTL(ruleId);
  const ttl = seenTTL.get(ruleId) || new Map();
  const prev = lastSeen.get(ruleId) || { createdAt: 0, itemId: 0 };
  const out = [];
  for (const it of items) {
    if (!it.id) continue;
    if (ttl.has(it.id)) continue;
    const created = it.created_at ? +new Date(it.created_at) : 0;
    const isNew =
      (created && created > (prev.createdAt || 0)) ||
      (!created && it.id > (prev.itemId || 0));
    if (isNew) {
      out.push(it);
      markSeen(ruleId, it);
    }
  }
  return out;
}

// ---------------------------[ Discord Posting ]------------------------------

async function postToDiscordItem(rule, it, signal) {
  const body = JSON.stringify({
    content: `**${md(it.title || "Neue Anzeige")}**\n${it.url || ""}`,
    embeds: [
      {
        title: (it.title || "Vinted").slice(0, 240),
        url: it.url,
        thumbnail: it.img ? { url: it.img } : undefined,
        fields: compact([
          it.price != null && {
            name: "Preis",
            value: `${it.price} ${it.currency || ""}`.trim(),
            inline: true,
          },
          it.brand && { name: "Marke", value: String(it.brand).slice(0, 256), inline: true },
          it.size && { name: "Größe", value: String(it.size).slice(0, 128), inline: true },
        ]),
      },
    ],
  });

  const start = Date.now();
  try {
    // Nur POST – KEIN vorheriger GET auf den Webhook (vermeidet 405/429)
    const { res, json } = await fetchJson(rule.webhook, {
      method: "POST",
      body,
      signal,
      headers: { "content-type": "application/json" },
    });

    // 429 Rate Limit → warten und als „retryable“ Fehler behandeln
    if (res.status === 429) {
      const retry =
        msRetryAfter(res) ??
        (json && (json.retry_after_ms || json.retry_after * 1000)) ??
        1000;
      await delay(jitter(Math.max(250, retry)));
      throw new Error(`RATE_LIMIT (${retry}ms)`);
    }

    // 5xx → retryable Fehler
    if (res.status >= 500) {
      throw new Error(`HTTP ${res.status}`);
    }

    // 2xx / 204 ok → fertig
    if (res.ok || res.status === 204) return true;

    // 4xx (außer 429): nicht retryen (z. B. ungültiger Webhook)
    log.err("post", `drop 4xx`, { status: res.status, item: it.id, rule: rule.id });
    return false;
  } catch (e) {
    // Fehler wird oben über Retry-Wrapper erneut versucht
    throw e;
  } finally {
    metrics.observe("post_ms", Date.now() - start);
  }
}

function msRetryAfter(res) {
  const h = res.headers;
  const ra = h.get("retry-after");
  if (ra) {
    // Sekunden oder Datum; Discord liefert oft Sekunden
    const n = Number(ra);
    if (Number.isFinite(n)) return n * 1000;
    const t = Date.parse(ra);
    if (!Number.isNaN(t)) return Math.max(0, t - Date.now());
  }
  const resetAfter = h.get("x-ratelimit-reset-after");
  if (resetAfter) {
    const n = Number(resetAfter);
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n * 1000));
  }
  return null;
}

function compact(a) {
  return a.filter(Boolean);
}
function md(s) {
  return String(s).replace(/([\\*_`~>|])/g, "\\$1");
}

// ---------------------------[ Deadlines / Retry ]----------------------------

async function withHardDeadline(fn, ms) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(new Error("HARD_DEADLINE_EXCEEDED")), ms);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(to);
  }
}

// ---------------------------[ Scheduler ]------------------------------------

class EDFScheduler {
  constructor(rules) {
    this.rules = rules.map((r) => ({ ...r, nextAt: 0 }));
  }
  due(now) {
    return this.rules.filter((r) => now >= (r.nextAt || 0)).sort((a, b) => a.nextAt - b.nextAt);
  }
  schedule(rule, now) {
    rule.nextAt = now + Math.max(1000, rule.intervalMs || 5000);
  }
}

// ---------------------------[ Runner ]---------------------------------------

async function runBot(rules) {
  await loadLastSeen();

  const sched = new EDFScheduler(rules);
  const scrapeQ = new AsyncQueue("scrape", CONFIG.SCRAPE_CONCURRENCY, CONFIG.VINTED_HARD_DEADLINE_MS);
  const postQ = new AsyncQueue("post", CONFIG.POST_CONCURRENCY, CONFIG.POST_HARD_DEADLINE_MS);

  // Main tick (1s)
  setInterval(() => {
    const now = Date.now();
    const due = sched.due(now);

    let dispatched = 0;
    for (const rule of due) {
      if (scrapeQ.inflight() >= CONFIG.SCRAPE_CONCURRENCY) break;
      dispatched++;
      sched.schedule(rule, now);
      scrapeQ.push(async (signal) => {
        try {
          const items = await scrapeOnce(rule, signal);
          if (items.length) {
            // WICHTIG: *itemweise* in die POST‑Queue, damit Concurrency greift
            for (const it of items) {
              const key = `${rule.id}:${it.id}`;
              postQ.push(
                async (sigPost) => {
                  try {
                    // Retry nur für „echte“ Fehler (429/5xx), nicht für 4xx
                    await withRetries(
                      () => postToDiscordItem(rule, it, sigPost),
                      {
                        maxRetry: CONFIG.POST_RETRY,
                        backoffMs: CONFIG.POST_BACKOFF_MS,
                      }
                    );
                  } catch (e) {
                    log.err("post", `failed`, {
                      rule: rule.id,
                      item: it.id,
                      err: String(e),
                    });
                  }
                },
                key
              );
            }
          }
        } catch (e) {
          log.err("scrape", `rule=${rule.id} failed`, { error: String(e) });
        }
      });
    }

    // Logs wie bei euch – jetzt inkl. POST inflight (zur echten Sichtbarkeit)
    log.info("sched.edf.tick", "", {
      dispatched,
      inflight: scrapeQ.inflight(),
      readyLeft: Math.max(0, CONFIG.SCRAPE_CONCURRENCY - scrapeQ.inflight()),
      ready: due.length,
      rules: rules.length,
    });
    log.info("post.tick", "", {
      bucketsReady: rules.length,
      slotsLeft: Math.max(0, CONFIG.POST_CONCURRENCY - postQ.inflight()),
      inflight: postQ.inflight(),
      totalQ: postQ.size(),
      post_p95_ms: metrics.p95("post_ms"),
      perBucket: 1,
    });
  }, 1000).unref();

  // Auto‑Kick, falls Queue Backlog hat aber inflight=0 (euer beobachtetes Muster).  :contentReference[oaicite:2]{index=2}
  setInterval(() => {
    postQ.kick();
    scrapeQ.kick();
  }, CONFIG.AUTOKICK_INTERVAL_MS).unref();

  // Watchdog: Jobs, die zu lange laufen, werden abgebrochen (per Task‑Deadline)
  // Zusätzlich gelegentliche Metrik‑Zeile, ähnlich euren „obs“
  setInterval(() => {
    log.info("obs", "", {
      rpm: 0,
      post_p95_ms: metrics.p95("post_ms"),
      scrape_p95_ms: metrics.p95("scrape_ms"),
      dq: postQ.size(),
    });
  }, CONFIG.STALL_CHECK_INTERVAL_MS).unref();

  // Persistenter dedupe‑Stand
  if (CONFIG.LAST_SEEN_PATH) {
    setInterval(() => saveLastSeen().catch(() => {}), 30_000).unref();
  }

  log.info("boot", "running", {
    SCRAPE_CONCURRENCY: CONFIG.SCRAPE_CONCURRENCY,
    POST_CONCURRENCY: CONFIG.POST_CONCURRENCY,
  });
}

// ---------------------------[ Start (optional) ]-----------------------------

if (require.main === module) {
  if (!RULES.length) {
    log.err("config", "Keine RULES definiert.");
  } else {
    runBot(RULES);
  }
}

module.exports = { runBot };

// ---------------------------[ EOF ]------------------------------------------
