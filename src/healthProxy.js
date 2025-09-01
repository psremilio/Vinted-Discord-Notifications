import dotenv from 'dotenv';

// Load environment variables from .env if present
dotenv.config();

// Minimal entrypoint to initialize and print proxy health
// Uses the existing proxy health module
import { initProxyPool } from './net/proxyHealth.js';

try {
  await initProxyPool();
  // On Railway, keep running by chaining to the main bot unless explicitly disabled.
  if (String(process.env.HEALTH_ONLY || '0') === '1') {
    console.log('[health:proxy] completed; HEALTH_ONLY=1 → exiting');
  } else if (process.env.RAILWAY_ENVIRONMENT) {
    console.log('[health:proxy] chaining to main (Railway detected)…');
    // Import the main entrypoint to start the bot process
    await import('../main.js');
  }
} catch (err) {
  console.error('[health:proxy] error:', err?.message || err);
  process.exitCode = 1;
}
