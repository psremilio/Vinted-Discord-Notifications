import Bottleneck from 'bottleneck';

const CONC = Math.max(1, Number(process.env.SEARCH_CONCURRENCY || 12));
const TARGET_RPM = Math.max(1, Number(process.env.SEARCH_TARGET_RPM || 3000));
const DISABLE_RES = String(process.env.SEARCH_DISABLE_RESERVOIR || '0') === '1';

export const limiter = DISABLE_RES
  ? new Bottleneck({ maxConcurrent: CONC })
  : new Bottleneck({
      maxConcurrent: CONC,
      reservoir: TARGET_RPM,
      reservoirRefreshAmount: TARGET_RPM,
      reservoirRefreshInterval: 60 * 1000,
    });
