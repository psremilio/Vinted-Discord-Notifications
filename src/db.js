import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const DEFAULT_DIR = process.env.DATA_DIR || '/data';

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {
    // ignore
  }
}

let dataDir = DEFAULT_DIR;
ensureDir(dataDir);

try {
  fs.accessSync(dataDir, fs.constants.W_OK);
} catch {
  dataDir = path.resolve('./data');
  ensureDir(dataDir);
}

const dbPath = path.join(dataDir, 'vinted.sqlite');

const db = new Database(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY,
  channel_id TEXT NOT NULL,
  filter_key TEXT NOT NULL,
  UNIQUE(channel_id, filter_key)
);
CREATE TABLE IF NOT EXISTS last_seen (
  sub_id INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  UNIQUE(sub_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_last_seen_sub ON last_seen(sub_id);
`);

const upsertSub = db.prepare(`
  INSERT OR IGNORE INTO subscriptions(channel_id, filter_key) VALUES(?, ?)
`);
const getSub = db.prepare(`
  SELECT id FROM subscriptions WHERE channel_id = ? AND filter_key = ?
`);
const insertSeen = db.prepare(`
  INSERT OR IGNORE INTO last_seen(sub_id, item_id, seen_at) VALUES(?, ?, ?)
`);

export function ensureSubscription(channelId, filterKey) {
  upsertSub.run(String(channelId), String(filterKey));
  const row = getSub.get(String(channelId), String(filterKey));
  return row.id;
}

export function markSeen(subId, itemId) {
  return insertSeen.run(subId, String(itemId), Math.floor(Date.now() / 1000)).changes > 0;
}
