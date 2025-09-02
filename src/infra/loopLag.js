let samples = [];
let timer = null;

export function startLoopLagMonitor(intervalMs = 1000) {
  if (timer) return;
  let expected = Date.now() + intervalMs;
  timer = setInterval(() => {
    const now = Date.now();
    const lag = Math.max(0, now - expected);
    expected += intervalMs;
    samples.push(lag);
    if (samples.length > 300) samples.shift();
  }, intervalMs);
}

export function getLagP95() {
  if (!samples.length) return 0;
  const arr = samples.slice().sort((a, b) => a - b);
  const idx = Math.min(arr.length - 1, Math.floor(arr.length * 0.95));
  return arr[idx];
}

