Fast Posting Tuning (10–30s target)

Goal
- Keep discovery→post latency typically in the 10–30s range (p95 ≤ ~60s) while avoiding Discord 429s and old-item spam.

Recommended ENV
- Parent/Fanout
  - `FANOUT_ALWAYS_PARENT=1`
  - `FANOUT_MIRROR_TO_PARENT=1`
  - `MONO_QUARANTINE_DISABLE=1`
- Scheduler/Intervals
  - `TIER_HOT_GLOBS=*-all,*-all-*€`
  - `T0_TARGET_SEC=6`
  - `T1_TARGET_SEC=10`
  - `T2_TARGET_SEC=15`
  - `SEARCH_SCHED_CONCURRENCY=16`
  - `SEARCH_SCHED_MAX_CONC=32`
- Search/Recency (optional)
  - `RECENT_MAX_MIN=5` (only post items <5min old)
  - `INGEST_MAX_AGE_MS=120000` (cap ingest to ≤2min when RECENT disabled)
  - `SEARCH_HEDGE=1`
- Posting/Webhooks
  - `WEBHOOKS_PER_CHANNEL=6`
  - `DISCORD_POST_CONCURRENCY=8`
  - `DISCORD_POST_CONCURRENCY_MAX=16`
  - `DISCORD_QPS_MIN=10`
  - `DISCORD_QPS_MAX=80`
  - `DISCORD_ROUTE_MAX_CONC=1` (per-webhook)
  - `MIGRATE_ON_COOLDOWN=0` (avoid 429 cascades)
  - `POST_BATCHING=1`, `POST_BATCH_EMBEDS_MAX=5`, `POST_BATCH_WINDOW_MS=250`
  - `FRESH_FASTPATH_MS=120000`
- Dedupe
  - `DEDUPE_SCOPE=global` or `CROSS_RULE_DEDUP=1` to avoid cross-rule duplicates
- Diagnostics (optional)
  - `DIAG_TIMING=1`
  - `LOG_LEVEL=debug`
  - `LOG_ROUTE=1`

Notes
- Hot defaults: Without ENV, rules matching `*-all` and `*-all-*€` are treated as T0 (6s target).
- Use `/reschedule all` after changing ENV or rules to refresh the scheduler.
- Watch `diag.post`: `age_listed_ms` (freshness) and `queued_ms` (queue delay). Aim for median ≤30s age and ≤1s queue. If 429s appear, ensure `DISCORD_ROUTE_MAX_CONC=1`, `MIGRATE_ON_COOLDOWN=0`, and batching is enabled.

