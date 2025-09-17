import fs from 'fs';
import path from 'path';

// Simple in-memory FIFO mutation queue with optional persistent lock file
// to serialize config mutations across concurrent command handlers.

const queue = [];
let running = false;
const lockPath = path.resolve('./config/.mutations.lock');
const TTL_MS = Math.max(5000, Number(process.env.MUTATION_LOCK_TTL_MS || 15000));

async function acquireFileLock() {
  const now = Date.now();
  try {
    // Try to create exclusively
    const fh = await fs.promises.open(lockPath, 'wx');
    const payload = { ts: now, expires: now + TTL_MS, pid: process.pid };
    await fh.writeFile(JSON.stringify(payload));
    await fh.close();
    return true;
  } catch (e) {
    // If exists, check TTL and remove stale
    try {
      const txt = await fs.promises.readFile(lockPath, 'utf8');
      const data = JSON.parse(txt || '{}');
      if ((data.expires || 0) < now) {
        await fs.promises.unlink(lockPath).catch(()=>{});
      }
    } catch {}
    // final retry
    try {
      const fh = await fs.promises.open(lockPath, 'wx');
      const payload = { ts: now, expires: now + TTL_MS, pid: process.pid };
      await fh.writeFile(JSON.stringify(payload));
      await fh.close();
      return true;
    } catch {}
    return false;
  }
}

async function releaseFileLock() {
  try { await fs.promises.unlink(lockPath); } catch {}
}

async function runNext() {
  if (running) return;
  if (!queue.length) return;
  running = true;
  const task = queue.shift();
  try {
    // Ensure at-most-one across processes using lock file with TTL
    let haveLock = await acquireFileLock();
    if (!haveLock) {
      // Wait a short window for existing mutation to finish
      const start = Date.now();
      while (!haveLock && Date.now() - start < TTL_MS) {
        await new Promise(r => setTimeout(r, 50));
        haveLock = await acquireFileLock();
      }
    }
    await task.fn();
  } catch (e) {
    try { task.onError?.(e); } catch {}
  } finally {
    await releaseFileLock();
    running = false;
    // Schedule next to avoid deep recursion
    setTimeout(runNext, 0);
  }
}

export function enqueueMutation(label, fn, onError) {
  queue.push({ label, fn, onError });
  // Optional: metrics update omitted to avoid ESM import complications here
  setTimeout(runNext, 0);
}

export function pendingMutations() { return queue.length; }
