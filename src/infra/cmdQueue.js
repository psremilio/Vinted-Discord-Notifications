import Bottleneck from 'bottleneck';

// High-priority queue for slash command execution to avoid contention
// with posting/webhook work. Keep concurrency small and no artificial delay.
export const cmdQueue = new Bottleneck({
  maxConcurrent: Math.max(1, Number(process.env.CMD_CONCURRENCY || 2)),
  minTime: 0,
  trackDoneStatus: false,
});

