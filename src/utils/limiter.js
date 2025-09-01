import Bottleneck from 'bottleneck';

const CONC = Math.max(1, Number(process.env.SEARCH_CONCURRENCY || 12));
const TARGET_RPM = Math.max(1, Number(process.env.SEARCH_TARGET_RPM || 60));

export const limiter = new Bottleneck({
  maxConcurrent: CONC,
  reservoir: TARGET_RPM,
  reservoirRefreshAmount: TARGET_RPM,
  reservoirRefreshInterval: 60 * 1000,
});

