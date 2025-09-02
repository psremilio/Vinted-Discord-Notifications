import fs from 'fs';
import path from 'path';

const STATE_DIR = process.env.STATE_DIR || '/data';
const FILE = path.join(STATE_DIR, 'webhooks.json');

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }

let cache = null;

export async function load() {
  ensureDir(STATE_DIR);
  try {
    const raw = fs.readFileSync(FILE, 'utf-8');
    cache = JSON.parse(raw);
  } catch {
    cache = {};
  }
  return cache;
}

export async function save(map) {
  ensureDir(STATE_DIR);
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map || cache || {}, null, 2));
  fs.renameSync(tmp, FILE);
  cache = map;
}

function ensureLoadedSync() {
  if (cache) return;
  try {
    const raw = fs.readFileSync(FILE, 'utf-8');
    cache = JSON.parse(raw);
  } catch { cache = {}; }
}

export function get(channelId) {
  ensureLoadedSync();
  return Array.isArray(cache[channelId]) ? cache[channelId] : [];
}

export function set(channelId, urls) {
  ensureLoadedSync();
  cache[channelId] = Array.from(new Set(urls || [])).filter(Boolean);
  fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
}

export function add(channelId, url) {
  if (!url) return;
  ensureLoadedSync();
  const arr = Array.isArray(cache[channelId]) ? cache[channelId] : [];
  if (!arr.includes(url)) arr.push(url);
  cache[channelId] = arr;
  fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
}

export function remove(channelId, url) {
  ensureLoadedSync();
  const arr = Array.isArray(cache[channelId]) ? cache[channelId] : [];
  cache[channelId] = arr.filter(u => u !== url);
  fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
}

