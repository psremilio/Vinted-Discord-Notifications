import fs from 'fs';
import path from 'path';

export function dataDir() {
  try { if (fs.existsSync('/data')) return '/data'; } catch {}
  return path.resolve('./data');
}

export function channelsPath() {
  try { if (process.env.CHANNELS_PATH) return process.env.CHANNELS_PATH; } catch {}
  const data = (() => {
    try { return fs.existsSync('/data') ? '/data/channels.json' : path.resolve('./data/channels.json'); }
    catch { return path.resolve('./data/channels.json'); }
  })();
  const cfg = path.resolve('./config/channels.json');
  try { fs.mkdirSync(path.dirname(data), { recursive: true }); } catch {}
  // Seed-once: copy config -> data if data missing
  try {
    if (fs.existsSync(cfg) && !fs.existsSync(data)) {
      try { fs.copyFileSync(cfg, data); console.log('channels.seed copied', cfg, '→', data); }
      catch (e) { console.warn('channels.seed copy failed:', e?.message || e); }
    }
  } catch {}
  // Always prefer data once present
  try { if (fs.existsSync(data)) return data; } catch {}
  return cfg; // last resort
}

