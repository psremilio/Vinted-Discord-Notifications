import fs from 'fs';
import path from 'path';

export function dataDir() {
  try { if (fs.existsSync('/data')) return '/data'; } catch {}
  return path.resolve('./data');
}

export function channelsPath() {
  // 1) Explicit env override takes precedence; ensure parent dir and file exist
  try {
    const envP = process.env.CHANNELS_PATH;
    if (envP && typeof envP === 'string') {
      try { fs.mkdirSync(path.dirname(envP), { recursive: true }); } catch {}
      try { if (!fs.existsSync(envP)) fs.writeFileSync(envP, '[]'); } catch {}
      return envP;
    }
  } catch {}

  // 2) Determine preferred data path under /data (if mounted) or ./data
  const data = (() => {
    try { return fs.existsSync('/data') ? '/data/channels.json' : path.resolve('./data/channels.json'); }
    catch { return path.resolve('./data/channels.json'); }
  })();
  const cfg = path.resolve('./config/channels.json');

  // Ensure data dir exists
  try { fs.mkdirSync(path.dirname(data), { recursive: true }); } catch {}

  // 3) Seed-once: copy config -> data if config exists and data missing
  try {
    if (fs.existsSync(cfg) && !fs.existsSync(data)) {
      try { fs.copyFileSync(cfg, data); console.log('channels.seed copied', cfg, '→', data); }
      catch (e) { console.warn('channels.seed copy failed:', e?.message || e); }
    }
  } catch {}

  // 4) Prefer data once present; otherwise create empty file at data and use it
  try { if (fs.existsSync(data)) return data; } catch {}
  try { fs.writeFileSync(data, '[]'); } catch {}
  return data;
}

