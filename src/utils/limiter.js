import Bottleneck from 'bottleneck';

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

const CONC = Math.max(1, getNum('SEARCH_CONCURRENCY', 12));
const TARGET_RPM = Math.max(1, getNum('SEARCH_TARGET_RPM', 3000));
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
