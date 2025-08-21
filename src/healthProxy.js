import dotenv from 'dotenv';

// Load environment variables from .env if present
dotenv.config();

// Minimal entrypoint to initialize and print proxy health
// Uses the existing proxy health module
import { initProxyPool } from './net/proxyHealth.js';

try {
  await initProxyPool();
} catch (err) {
  console.error('[health:proxy] error:', err?.message || err);
  process.exitCode = 1;
}

