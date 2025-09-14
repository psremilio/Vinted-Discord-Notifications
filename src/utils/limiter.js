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
