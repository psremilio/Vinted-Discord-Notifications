import Bottleneck from 'bottleneck';
import { metrics } from '../infra/metrics.js';

function unquote(v) {
  if (v == null) return v;
  const s = String(v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function getNum(name, defVal) {
  const raw = unquote(process.env[name]);
  if (raw == null || raw === '') return defVal;
  const n = Number(raw);
  return Number.isFinite(n) ? n : defVal;
}

function getBool(name, defVal = false) {
  const raw = unquote(process.env[name]);
  if (raw == null || raw === '') return defVal;
  const s = String(raw).toLowerCase();
  if (["1","true","yes","y","on"].includes(s)) return true;
  if (["0","false","no","n","off"].includes(s)) return false;
  return defVal;
}

// Discovery limiter defaults (safer baseline)
const CONC = Math.max(1, getNum('SEARCH_CONCURRENCY', 16));
const TARGET_RPM = Math.max(1, getNum('SEARCH_TARGET_RPM', 300));
const DISABLE_RES = getBool('SEARCH_DISABLE_RESERVOIR', false);

export const limiter = DISABLE_RES
  ? new Bottleneck({ maxConcurrent: CONC })
  : new Bottleneck({
      maxConcurrent: CONC,
      reservoir: TARGET_RPM,
      reservoirRefreshAmount: TARGET_RPM,
      reservoirRefreshInterval: 60 * 1000,
    });

// Transparentes Logging der aktiven Limits (einmalig)
try {
  const mode = DISABLE_RES ? 'concurrency-only' : 'concurrency+reservoir';
  const msg = DISABLE_RES
    ? `[limiter] mode=${mode} conc=${CONC}`
    : `[limiter] mode=${mode} conc=${CONC} rpm=${TARGET_RPM}`;
  console.log(msg);
} catch {}

// Adaptive search RPM based on recent softfail/429 rate (via http_429_rate_60s gauge)
const ADAPTIVE = getBool('SEARCH_ADAPTIVE', true);
const MODE = String(unquote(process.env.SEARCH_ADAPTIVE_MODE || 'conservative')).toLowerCase();
const MIN_RPM = Math.max(60, getNum('SEARCH_MIN_RPM', 120));
const MAX_RPM = Math.max(MIN_RPM, getNum('SEARCH_MAX_RPM', 800));
const INC_FACTOR = MODE === 'aggressive' ? Math.max(1.01, Number(getNum('SEARCH_INC_FACTOR', 1.2))) : Math.max(1.01, Number(getNum('SEARCH_INC_FACTOR', 1.05)));
const DEC_FACTOR = MODE === 'aggressive' ? Math.min(0.99, Number(getNum('SEARCH_DEC_FACTOR', 0.85))) : Math.min(0.99, Number(getNum('SEARCH_DEC_FACTOR', 0.7)));
const RATE_THR = MODE === 'aggressive' ? Math.max(0, Math.min(1, Number(getNum('SEARCH_429_RATE_THR', 0.08)))) : Math.max(0, Math.min(1, Number(getNum('SEARCH_429_RATE_THR', 0.01))));
let currentRpm = TARGET_RPM;

if (!DISABLE_RES && ADAPTIVE) {
  try { console.log(`[limiter.adapt] on rpm=${currentRpm} min=${MIN_RPM} max=${MAX_RPM} inc=${INC_FACTOR} dec=${DEC_FACTOR} thr=${RATE_THR}`); } catch {}
  setInterval(() => {
    try {
      // Use Vinted-specific 429 rate only for search adaptation
      const ratePct = Number(metrics.vinted_http_429_rate_60s?.get?.() ?? 0);
      const rate = isFinite(ratePct) ? Math.max(0, Math.min(1, ratePct / 100)) : 0;
      let next = currentRpm;
      if (rate > RATE_THR) {
        next = Math.max(MIN_RPM, Math.floor(currentRpm * DEC_FACTOR));
      } else {
        next = Math.min(MAX_RPM, Math.ceil(currentRpm * INC_FACTOR));
      }
      if (next !== currentRpm) {
        currentRpm = next;
        limiter.updateSettings({ reservoir: currentRpm, reservoirRefreshAmount: currentRpm });
        try { console.log(`[limiter.adapt] http429_rate60=${Math.round(rate*100)}% -> rpm=${currentRpm}`); } catch {}
      }
    } catch {}
  }, 60 * 1000).unref?.();
}

// --- Search bucket bootstrap (per-host) -----------------------------------

const hostBuckets = new Map(); // host -> SearchBucket

function normHost(host) {
  if (!host) return null;
  const str = String(host).trim().toLowerCase();
  return str || null;
}

function clamp(val, min, max) {
  const value = Number(val);
  if (!Number.isFinite(value)) return Math.min(max, Math.max(min, min));
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

class SearchBucket {
  constructor({ targetRpm, minRpm, maxRpm }) {
    this.minRpm = Math.max(1, Number(minRpm || 1));
    this.maxRpm = Math.max(this.minRpm, Number(maxRpm || this.minRpm));
    this.targetRpm = clamp(targetRpm, this.minRpm, this.maxRpm);
    this.tokens = Math.max(1, this.targetRpm);
    this._last = Date.now();
  }

  get capacity() {
    return Math.max(1, this.targetRpm);
  }

  update({ targetRpm, minRpm, maxRpm } = {}) {
    if (typeof minRpm === 'number' && Number.isFinite(minRpm)) {
      this.minRpm = Math.max(1, minRpm);
    }
    if (typeof maxRpm === 'number' && Number.isFinite(maxRpm)) {
      this.maxRpm = Math.max(this.minRpm, maxRpm);
    }
    if (typeof targetRpm === 'number' && Number.isFinite(targetRpm)) {
      this.targetRpm = clamp(targetRpm, this.minRpm, this.maxRpm);
    } else {
      // ensure target stays within updated bounds
      this.targetRpm = clamp(this.targetRpm, this.minRpm, this.maxRpm);
    }
    this.tokens = Math.min(this.tokens ?? 0, this.capacity);
    if (!Number.isFinite(this.tokens) || this.tokens <= 0) {
      this.tokens = this.capacity;
    }
  }

  refill(now = Date.now()) {
    const dt = Math.max(0, now - this._last);
    if (dt === 0) return;
    this._last = now;
    const perMs = this.targetRpm / 60_000;
    this.tokens = Math.min(this.capacity, this.tokens + perMs * dt);
  }

  take(n = 1) {
    if (n <= 0) return true;
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  giveBack(n = 1) {
    if (n <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + n);
  }

  fillToCapacity() {
    this.tokens = this.capacity;
    this._last = Date.now();
  }
}

export function hasBucket(host) {
  return hostBuckets.has(normHost(host));
}

export function ensureBucket(host, opts = {}) {
  const key = normHost(host);
  if (!key) return null;
  const min = Number(opts.minRpm ?? getNum('SEARCH_MIN_RPM', 120));
  const max = Number(opts.maxRpm ?? getNum('SEARCH_MAX_RPM', 2000));
  const target = Number(opts.targetRpm ?? getNum('SEARCH_TARGET_RPM', TARGET_RPM));
  const bucketOpts = {
    minRpm: Math.max(1, min),
    maxRpm: Math.max(Math.max(1, min), max),
    targetRpm: clamp(target, Math.max(1, min), Math.max(Math.max(1, min), max)),
  };
  let bucket = hostBuckets.get(key);
  if (!bucket) {
    bucket = new SearchBucket(bucketOpts);
    hostBuckets.set(key, bucket);
  } else {
    bucket.update(bucketOpts);
    if (opts.prefill || opts.warmup) bucket.fillToCapacity();
  }
  if (opts.prefill || opts.warmup || !Number.isFinite(bucket.tokens)) {
    bucket.fillToCapacity();
  }
  return bucket;
}

export function takeBucket(host, tokens = 1, opts = {}) {
  const bucket = ensureBucket(host, opts);
  if (!bucket) return false;
  return bucket.take(tokens);
}

export function giveBackBucket(host, tokens = 1) {
  const bucket = hostBuckets.get(normHost(host));
  if (!bucket) return;
  bucket.giveBack(tokens);
}
