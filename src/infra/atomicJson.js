import fs from 'fs';
import path from 'path';
import { dataDir } from './paths.js';

export function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const bak = path.join(dir, `${path.basename(file)}.bak`);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  try { if (fs.existsSync(file)) fs.copyFileSync(file, bak); } catch {}
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

export function appendWal(event, payload = {}) {
  try {
    const log = path.join(dataDir(), 'channels.wal');
    const rec = { ts: new Date().toISOString(), event, ...payload };
    fs.appendFileSync(log, JSON.stringify(rec) + '\n');
  } catch {}
}

