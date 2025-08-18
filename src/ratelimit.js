import Bottleneck from 'bottleneck';

export const limiter = new Bottleneck({
  maxConcurrent: Number(process.env.MAX_CONCURRENCY || 4),
});
