// Minimal Prometheus-like metrics registry and /metrics serialization

class Counter {
  constructor(name) { this.name = name; this.value = 0; }
  inc(v = 1) { this.value += v; }
  get() { return this.value; }
}

class LabeledGauge {
  constructor(name, labelNames = []) {
    this.name = name; this.labelNames = labelNames; this.map = new Map();
  }
  _key(labels) {
    const parts = this.labelNames.map(k => `${k}=${JSON.stringify(String(labels?.[k] ?? ''))}`);
    return parts.join(',');
  }
  set(labels, value) { this.map.set(this._key(labels), { labels, value }); }
  entries() { return Array.from(this.map.values()); }
}

class Gauge { constructor(name) { this.name = name; this.value = 0; } set(v) { this.value = v; } get() { return this.value; } }

class LabeledCounter {
  constructor(name, labelNames = []) { this.name = name; this.labelNames = labelNames; this.map = new Map(); }
  _key(labels) { const parts = this.labelNames.map(k => `${k}=${JSON.stringify(String(labels?.[k] ?? ''))}`); return parts.join(','); }
  inc(labels, v = 1) { const k = this._key(labels); const cur = this.map.get(k) || { labels, value: 0 }; cur.value += v; this.map.set(k, cur); }
  entries() { return Array.from(this.map.values()); }
}

export const metrics = {
  // split 429 rate gauges by domain
  vinted_http_429_rate_60s: new Gauge('vinted_http_429_rate_60s'),
  vinted_req_60s_count: new Gauge('vinted_req_60s_count'),
  discord_http_429_rate_60s: new Gauge('discord_http_429_rate_60s'),
  // per-proxy gauges
  proxy_rpm_current: new LabeledGauge('proxy_rpm_current', ['proxy']),
  proxy_rpm_target: new LabeledGauge('proxy_rpm_target', ['proxy']),
  // counters
  http_429_total: new Counter('http_429_total'),
  http_403_total: new Counter('http_403_total'),
  fetch_ok_total: new Counter('fetch_ok_total'),
  fetch_skipped_total: new Counter('fetch_skipped_total'),
  fetch_softfail_total: new Counter('fetch_softfail_total'),
  ingest_dropped_too_old_total: new LabeledCounter('ingest_dropped_too_old_total', ['rule']),
  discord_rate_limit_hits: new Counter('discord_rate_limit_hits'),
  discord_queue_depth: new Gauge('discord_queue_depth'),
  discord_dropped_total: new Counter('discord_dropped_total'),
  fresh_skipped_total: new Counter('fresh_skipped_total'),
  // misc gauges
  rules_active: new Gauge('rules_active'),
  proxy_healthy: new Gauge('proxy_healthy'),
  families_count: new Gauge('families_count'),
  global_rpm_effective: new Gauge('global_rpm_effective'),
  rules_invalid_target_total: new Gauge('rules_invalid_target_total'),
  // aggregated, low-cardinality gauges
  http_429_rate_60s: new Gauge('http_429_rate_60s'),
  global_latency_p95_ms: new Gauge('global_latency_p95_ms'),
  backfill_pages_active: new Gauge('backfill_pages_active'),
  rules_reassigned_total: new Counter('rules_reassigned_total'),
  discord_cooldown_active: new Gauge('discord_cooldown_active'),
  skipped_ratio_p95: new Gauge('skipped_ratio_p95'),
  // scheduler/posting extras
  reorder_buffer_depth: new LabeledGauge('reorder_buffer_depth', ['channel']),
  tier_poll_latency_ms: new LabeledGauge('tier_poll_latency_ms', ['tier']),
  post_latency_ms_p95: new Gauge('post_latency_ms_p95'),
  discord_webhook_send_ok_total: new LabeledCounter('discord_webhook_send_ok_total', ['channel']),
  discord_webhook_send_429_total: new LabeledCounter('discord_webhook_send_429_total', ['channel']),
  discord_webhook_cooldowns_total: new LabeledCounter('discord_webhook_cooldowns_total', ['channel']),
  discord_channel_send_ok_total: new LabeledCounter('discord_channel_send_ok_total', ['channel']),
  // embeds validation/diagnostics
  post_embed_sanitized_total: new Counter('post_embed_sanitized_total'),
  post_embed_invalid_total: new Counter('post_embed_invalid_total'),
  post_embed_suspected_suppressed_total: new LabeledCounter('post_embed_suspected_suppressed_total', ['channel']),
  // fanout + gating + http extras
  parent_fanout_items_total: new LabeledCounter('parent_fanout_items_total', ['parent','child']),
  child_fetch_saved_total: new LabeledCounter('child_fetch_saved_total', ['child']),
  mono_violation_total: new LabeledCounter('mono_violation_total', ['parent','child']),
  family_shape_invalid_total: new LabeledCounter('family_shape_invalid_total', ['family','parent']),
  missing_price_bucket_total: new LabeledCounter('missing_price_bucket_total', ['parent','bucket']),
  brand_ok_total: new Counter('brand_ok_total'),
  brand_alias_ok_total: new Counter('brand_alias_ok_total'),
  catalog_ok_total: new Counter('catalog_ok_total'),
  subcatalog_ok_total: new Counter('subcatalog_ok_total'),
  no_token_skips_total: new LabeledCounter('no_token_skips_total', ['rule']),
  fetch_timeout_total: new LabeledCounter('fetch_timeout_total', ['proxy']),
  price_drop_posted_total: new LabeledCounter('price_drop_posted_total', ['rule']),
  rule_catchup_grants_total: new Counter('rule_catchup_grants_total'),
  // pseudo-histograms
  match_age_ms_histogram: new LabeledGauge('match_age_ms_histogram', ['rule']),
  post_age_ms_histogram: new LabeledGauge('post_age_ms_histogram', ['channel']),
  parent_child_drift_ms_histogram: new LabeledGauge('parent_child_drift_ms_histogram', ['family']),
  proxy_latency_ewma_ms: new LabeledGauge('proxy_latency_ewma_ms', ['proxy']),
  // p95 diagnostics
  queue_age_ms_p95: new LabeledGauge('queue_age_ms_p95', ['channel']),
  first_age_ms_p95: new LabeledGauge('first_age_ms_p95', ['rule']),
  proxy_fetch_ms_p95: new LabeledGauge('proxy_fetch_ms_p95', ['proxy']),
  // fanout mismatch counters
  fanout_skipped_by_mismatch_total: new LabeledCounter('fanout_skipped_by_mismatch_total', ['field']),
  // commands
  commands_heartbeat: new Gauge('commands_heartbeat'),
  cmd_exec_ms_p95: new LabeledGauge('cmd_exec_ms_p95', ['command']),
  interaction_defer_latency_ms: new LabeledGauge('interaction_defer_latency_ms', ['command']),
  // scheduler
  scheduler_reload_events_total: new Counter('scheduler_reload_events_total'),
  scheduler_rules_total: new Gauge('scheduler_rules_total'),
  rules_removed_total: new Counter('rules_removed_total'),
  // alias for E2E (found->sent)
  e2e_latency_ms_p95: new LabeledGauge('e2e_latency_ms_p95', ['channel']),
  // per-route queue depth
  route_queue_depth: new LabeledGauge('route_queue_depth', ['channel']),
};

export function serializeMetrics() {
  const out = [];
  function lineHelpType(name, help, type) {
    out.push(`# HELP ${name} ${help}`);
    out.push(`# TYPE ${name} ${type}`);
  }
  // Gauges (labeled)
  lineHelpType('proxy_rpm_current', 'Current rpm per proxy', 'gauge');
  for (const e of metrics.proxy_rpm_current.entries()) {
    out.push(`proxy_rpm_current{proxy="${e.labels.proxy}"} ${e.value}`);
  }
  lineHelpType('proxy_rpm_target', 'Target rpm per proxy', 'gauge');
  for (const e of metrics.proxy_rpm_target.entries()) {
    out.push(`proxy_rpm_target{proxy="${e.labels.proxy}"} ${e.value}`);
  }
  // Counters
  lineHelpType('http_429_total', 'Total HTTP 429s', 'counter'); out.push(`http_429_total ${metrics.http_429_total.get()}`);
  lineHelpType('http_403_total', 'Total HTTP 403s', 'counter'); out.push(`http_403_total ${metrics.http_403_total.get()}`);
  lineHelpType('fetch_ok_total', 'Total successful fetches', 'counter'); out.push(`fetch_ok_total ${metrics.fetch_ok_total.get()}`);
  lineHelpType('fetch_skipped_total', 'Total skipped fetch slots', 'counter'); out.push(`fetch_skipped_total ${metrics.fetch_skipped_total.get()}`);
  lineHelpType('fetch_softfail_total', 'Total soft fails', 'counter'); out.push(`fetch_softfail_total ${metrics.fetch_softfail_total.get()}`);
  lineHelpType('ingest_dropped_too_old_total', 'Ingest drops due to age over threshold', 'counter');
  for (const e of metrics.ingest_dropped_too_old_total.entries()) out.push(`ingest_dropped_too_old_total{rule=\"${e.labels.rule}\"} ${e.value}`);
  lineHelpType('discord_rate_limit_hits', 'Discord 429 hits observed', 'counter'); out.push(`discord_rate_limit_hits ${metrics.discord_rate_limit_hits.get()}`);
  // Gauges (scalar)
  lineHelpType('rules_active', 'Active rules', 'gauge'); out.push(`rules_active ${metrics.rules_active.get()}`);
  lineHelpType('proxy_healthy', 'Healthy proxies', 'gauge'); out.push(`proxy_healthy ${metrics.proxy_healthy.get()}`);
  lineHelpType('global_rpm_effective', 'Sum of per-proxy rpm', 'gauge'); out.push(`global_rpm_effective ${metrics.global_rpm_effective.get()}`);
  lineHelpType('vinted_http_429_rate_60s', 'Vinted 429 rate over 60s window (percent)', 'gauge'); out.push(`vinted_http_429_rate_60s ${metrics.vinted_http_429_rate_60s.get()}`);
  lineHelpType('discord_http_429_rate_60s', 'Discord 429 rate over 60s window (percent)', 'gauge'); out.push(`discord_http_429_rate_60s ${metrics.discord_http_429_rate_60s.get()}`);
  lineHelpType('http_429_rate_60s', 'Global 429/403 rate over 60s window', 'gauge'); out.push(`http_429_rate_60s ${metrics.http_429_rate_60s.get()}`);
  lineHelpType('global_latency_p95_ms', 'Global p95 latency over window (ms)', 'gauge'); out.push(`global_latency_p95_ms ${metrics.global_latency_p95_ms.get()}`);
  lineHelpType('discord_queue_depth', 'Discord posting queue depth', 'gauge'); out.push(`discord_queue_depth ${metrics.discord_queue_depth.get()}`);
  lineHelpType('discord_dropped_total', 'Discord posts dropped due to full queue', 'counter'); out.push(`discord_dropped_total ${metrics.discord_dropped_total.get()}`);
  lineHelpType('fresh_skipped_total', 'Items skipped by startup fresh-only window', 'counter'); out.push(`fresh_skipped_total ${metrics.fresh_skipped_total.get()}`);
  lineHelpType('backfill_pages_active', 'Number of rules in backfill mode', 'gauge'); out.push(`backfill_pages_active ${metrics.backfill_pages_active.get()}`);
  lineHelpType('rules_reassigned_total', 'Rules reassigned due to skew', 'counter'); out.push(`rules_reassigned_total ${metrics.rules_reassigned_total.get()}`);
  lineHelpType('discord_cooldown_active', 'Discord hard cooldown active (0/1)', 'gauge'); out.push(`discord_cooldown_active ${metrics.discord_cooldown_active.get()}`);
  lineHelpType('skipped_ratio_p95', 'p95 skipped slot ratio across rules', 'gauge'); out.push(`skipped_ratio_p95 ${metrics.skipped_ratio_p95.get()}`);
  // labeled gauges
  lineHelpType('reorder_buffer_depth', 'Per channel reorder buffer depth', 'gauge');
  for (const e of metrics.reorder_buffer_depth.entries()) out.push(`reorder_buffer_depth{channel="${e.labels.channel}"} ${e.value}`);
  lineHelpType('tier_poll_latency_ms', 'Last poll latency per tier (ms)', 'gauge');
  for (const e of metrics.tier_poll_latency_ms.entries()) out.push(`tier_poll_latency_ms{tier="${e.labels.tier}"} ${e.value}`);
  // scalar post latency p95
  lineHelpType('post_latency_ms_p95', 'Posting latency p95 (ms)', 'gauge'); out.push(`post_latency_ms_p95 ${metrics.post_latency_ms_p95.get()}`);
  // webhook labeled counters
  lineHelpType('discord_webhook_send_ok_total', 'Webhook sends OK by channel', 'counter');
  for (const e of metrics.discord_webhook_send_ok_total.entries()) out.push(`discord_webhook_send_ok_total{channel="${e.labels.channel}"} ${e.value}`);
  lineHelpType('discord_webhook_send_429_total', 'Webhook sends 429 by channel', 'counter');
  for (const e of metrics.discord_webhook_send_429_total.entries()) out.push(`discord_webhook_send_429_total{channel="${e.labels.channel}"} ${e.value}`);
  lineHelpType('discord_webhook_cooldowns_total', 'Webhook cooldowns by channel', 'counter');
  for (const e of metrics.discord_webhook_cooldowns_total.entries()) out.push(`discord_webhook_cooldowns_total{channel="${e.labels.channel}"} ${e.value}`);
  lineHelpType('discord_channel_send_ok_total', 'Plain channel.send posts (no webhook)', 'counter');
  for (const e of metrics.discord_channel_send_ok_total.entries()) out.push(`discord_channel_send_ok_total{channel="${e.labels.channel}"} ${e.value}`);
  // embeds
  lineHelpType('post_embed_sanitized_total', 'Embeds sanitized (clamped/truncated)', 'counter'); out.push(`post_embed_sanitized_total ${metrics.post_embed_sanitized_total.get()}`);
  lineHelpType('post_embed_invalid_total', 'Embeds invalid (400 errors)', 'counter'); out.push(`post_embed_invalid_total ${metrics.post_embed_invalid_total.get()}`);
  lineHelpType('post_embed_suspected_suppressed_total', 'Suspected suppressed embeds by channel', 'counter');
  for (const e of metrics.post_embed_suspected_suppressed_total.entries()) out.push(`post_embed_suspected_suppressed_total{channel="${e.labels.channel}"} ${e.value}`);
  // fanout + gating + http extras
  lineHelpType('parent_fanout_items_total', 'Items fanned out from parent to child', 'counter');
  for (const e of metrics.parent_fanout_items_total.entries()) out.push(`parent_fanout_items_total{parent="${e.labels.parent}",child="${e.labels.child}"} ${e.value}`);
  lineHelpType('child_fetch_saved_total', 'Items posted via child fallback fetch', 'counter');
  for (const e of metrics.child_fetch_saved_total.entries()) out.push(`child_fetch_saved_total{child="${e.labels.child}"} ${e.value}`);
  lineHelpType('mono_violation_total', 'Monotonicity violations (price family)', 'counter');
  for (const e of metrics.mono_violation_total.entries()) out.push(`mono_violation_total{parent="${e.labels.parent}",child="${e.labels.child}"} ${e.value}`);
  lineHelpType('family_shape_invalid_total', 'Invalid family shape detected', 'counter');
  for (const e of metrics.family_shape_invalid_total.entries()) out.push(`family_shape_invalid_total{family="${e.labels.family}",parent="${e.labels.parent}"} ${e.value}`);
  lineHelpType('missing_price_bucket_total', 'Missing price bucket detected', 'counter');
  for (const e of metrics.missing_price_bucket_total.entries()) out.push(`missing_price_bucket_total{parent="${e.labels.parent}",bucket="${e.labels.bucket}"} ${e.value}`);
  lineHelpType('brand_ok_total', 'Brand matches (exact)', 'counter'); out.push(`brand_ok_total ${metrics.brand_ok_total.get()}`);
  lineHelpType('brand_alias_ok_total', 'Brand matches via alias group', 'counter'); out.push(`brand_alias_ok_total ${metrics.brand_alias_ok_total.get()}`);
  lineHelpType('catalog_ok_total', 'Catalog matches (exact)', 'counter'); out.push(`catalog_ok_total ${metrics.catalog_ok_total.get()}`);
  lineHelpType('subcatalog_ok_total', 'Catalog matches via subtree', 'counter'); out.push(`subcatalog_ok_total ${metrics.subcatalog_ok_total.get()}`);
  lineHelpType('no_token_skips_total', 'Per-rule fetch skips due to no token', 'counter');
  for (const e of metrics.no_token_skips_total.entries()) out.push(`no_token_skips_total{rule="${e.labels.rule}"} ${e.value}`);
  lineHelpType('fetch_timeout_total', 'Per-proxy fetch timeouts', 'counter');
  for (const e of metrics.fetch_timeout_total.entries()) out.push(`fetch_timeout_total{proxy="${e.labels.proxy}"} ${e.value}`);
  lineHelpType('price_drop_posted_total', 'Posts labeled as price drop', 'counter');
  for (const e of metrics.price_drop_posted_total.entries()) out.push(`price_drop_posted_total{rule="${e.labels.rule}"} ${e.value}`);
  lineHelpType('rule_catchup_grants_total', 'Catch-up grant count', 'counter'); out.push(`rule_catchup_grants_total ${metrics.rule_catchup_grants_total.get()}`);
  // pseudo-histograms
  lineHelpType('match_age_ms_histogram', 'Match age sample (ms) per rule', 'gauge');
  for (const e of metrics.match_age_ms_histogram.entries()) out.push(`match_age_ms_histogram{rule="${e.labels.rule}"} ${e.value}`);
  lineHelpType('post_age_ms_histogram', 'Post age sample (ms) per channel', 'gauge');
  for (const e of metrics.post_age_ms_histogram.entries()) out.push(`post_age_ms_histogram{channel="${e.labels.channel}"} ${e.value}`);
  lineHelpType('parent_child_drift_ms_histogram', 'Parent-child drift sample (ms) per family', 'gauge');
  for (const e of metrics.parent_child_drift_ms_histogram.entries()) out.push(`parent_child_drift_ms_histogram{family="${e.labels.family}"} ${e.value}`);
  lineHelpType('proxy_latency_ewma_ms', 'Per-proxy EWMA latency (ms)', 'gauge');
  for (const e of metrics.proxy_latency_ewma_ms.entries()) out.push(`proxy_latency_ewma_ms{proxy="${e.labels.proxy}"} ${e.value}`);
  // p95 diagnostics
  lineHelpType('queue_age_ms_p95', 'Queue age p95 (ms) per channel', 'gauge');
  for (const e of metrics.queue_age_ms_p95.entries()) out.push(`queue_age_ms_p95{channel="${e.labels.channel}"} ${e.value}`);
  lineHelpType('first_age_ms_p95', 'First age (listed->discovered) p95 per rule', 'gauge');
  for (const e of metrics.first_age_ms_p95.entries()) out.push(`first_age_ms_p95{rule="${e.labels.rule}"} ${e.value}`);
  lineHelpType('proxy_fetch_ms_p95', 'Per-proxy fetch latency p95 (ms)', 'gauge');
  for (const e of metrics.proxy_fetch_ms_p95.entries()) out.push(`proxy_fetch_ms_p95{proxy="${e.labels.proxy}"} ${e.value}`);
  // fanout mismatch
  lineHelpType('fanout_skipped_by_mismatch_total', 'Fanout child skipped due to filter mismatch', 'counter');
  for (const e of metrics.fanout_skipped_by_mismatch_total.entries()) out.push(`fanout_skipped_by_mismatch_total{field="${e.labels.field}"} ${e.value}`);
  // scheduler
  lineHelpType('scheduler_reload_events_total', 'Scheduler rebuild/reload events', 'counter'); out.push(`scheduler_reload_events_total ${metrics.scheduler_reload_events_total.get()}`);
  lineHelpType('scheduler_rules_total', 'Scheduler rules total', 'gauge'); out.push(`scheduler_rules_total ${metrics.scheduler_rules_total.get()}`);
  lineHelpType('rules_removed_total', 'Rules removed from scheduler', 'counter'); out.push(`rules_removed_total ${metrics.rules_removed_total.get()}`);
  lineHelpType('families_count', 'Number of active families', 'gauge'); out.push(`families_count ${metrics.families_count.get()}`);
  lineHelpType('vinted_http_429_rate_60s', 'Vinted 429 rate over last 60s (percent)', 'gauge'); out.push(`vinted_http_429_rate_60s ${metrics.vinted_http_429_rate_60s.get()}`);
  lineHelpType('vinted_req_60s_count', 'Vinted request samples over last 60s (count)', 'gauge'); out.push(`vinted_req_60s_count ${metrics.vinted_req_60s_count.get()}`);
  lineHelpType('rules_invalid_target_total', 'Rules with invalid targets (no channel or unsupported)', 'gauge'); out.push(`rules_invalid_target_total ${metrics.rules_invalid_target_total.get()}`);
  // E2E latency alias
  lineHelpType('e2e_latency_ms_p95', 'End-to-end latency p95 (found->sent) per channel', 'gauge');
  for (const e of metrics.e2e_latency_ms_p95.entries()) out.push(`e2e_latency_ms_p95{channel="${e.labels.channel}"} ${e.value}`);
  // per-route queue depth
  lineHelpType('route_queue_depth', 'Per-route queue depth by channel', 'gauge');
  for (const e of metrics.route_queue_depth.entries()) out.push(`route_queue_depth{channel="${e.labels.channel}"} ${e.value}`);
  // commands
  lineHelpType('interaction_defer_latency_ms', 'Interaction defer latency (ms) per command', 'gauge');
  for (const e of metrics.interaction_defer_latency_ms.entries()) out.push(`interaction_defer_latency_ms{command="${e.labels.command}"} ${e.value}`);
  lineHelpType('commands_heartbeat', 'Commands worker heartbeat (epoch ms)', 'gauge'); out.push(`commands_heartbeat ${metrics.commands_heartbeat.get()}`);
  lineHelpType('cmd_exec_ms_p95', 'Command exec p95 (ms) per command', 'gauge');
  for (const e of metrics.cmd_exec_ms_p95.entries()) out.push(`cmd_exec_ms_p95{command="${e.labels.command}"} ${e.value}`);
  return out.join('\n');
}
