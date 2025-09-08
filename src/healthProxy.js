import dotenv from 'dotenv';

// Load environment variables from .env if present
dotenv.config();

// Minimal entrypoint to initialize and print proxy health
// Uses the existing proxy health module
import { initProxyPool } from './net/proxyHealth.js';

try {
  if (String(process.env.HEALTH_ONLY || '0') === '1') {
    // Pure health mode: run pool init (will print stats) and exit
    await initProxyPool();
    console.log('[health:proxy] completed; HEALTH_ONLY=1 → exiting');
  } else {
    // App mode: start the main bot immediately; proxy pool will be
    // initialized by main.js in parallel to avoid startup stalls.
    console.log('[health:proxy] starting main immediately (no blocking init)…');
    await import('../main.js');
  }
} catch (err) {
  console.error('[health:proxy] error:', err?.message || err);
  process.exitCode = 1;
}
