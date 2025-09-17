import fs from 'node:fs';
import path from 'node:path';

class TTLSet {
  constructor(ttlMs) { this.ttl = ttlMs; this.map = new Map(); }
  has(key) {
    const v = this.map.get(key);
    if (!v) return false;
    if (Date.now() > v) { this.map.delete(key); return false; }
    return true;
  }
  add(key) { this.map.set(key, Date.now() + this.ttl); }
  size() { return this.map.size; }
}

class Spooler {
  constructor(dir, flushMs = 2000, maxBytes = Number(process.env.SPOOL_MAX_BYTES || 10 * 1024 * 1024)) {
    this.dir = dir || null;
    this.buf = [];
    this.itemsSeen = new Set();
    this.file = this.dir ? path.join(this.dir, 'spool.jsonl') : null;
    this.maxBytes = maxBytes;
    if (this.dir) fs.mkdirSync(this.dir, { recursive: true });
    if (flushMs > 0) setInterval(() => this.flush(), flushMs).unref?.();
  }
  hasItem(id) { return this.itemsSeen.has(String(id)); }
  append(entry) {
    if (!this.dir) return;
    try { if (entry?.payload?.embed) this.itemsSeen.add(String(entry.id)); } catch {}
    this.buf.push(entry);
  }
  flush() {
    if (!this.dir || this.buf.length === 0) return;
    try {
      const data = this.buf.map(e => JSON.stringify(e)).join('\n') + '\n';
      this.buf = [];
      // Rotate file if exceeding max bytes
      if (this.file && fs.existsSync(this.file)) {
        try {
          const st = fs.statSync(this.file);
          if (st.size + data.length > this.maxBytes) {
            const rot = path.join(this.dir, `spool-${Date.now()}.jsonl`);
            fs.renameSync(this.file, rot);
          }
        } catch {}
      }
      fs.appendFileSync(this.file, data);
    } catch {}
  }
  restore(agg) {
    if (!this.dir || !fs.existsSync(this.dir)) return;
    const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.jsonl')).sort();
    for (const f of files) {
      const lines = fs.readFileSync(path.join(this.dir, f), 'utf8').split('\n').filter(Boolean);
      for (const ln of lines) {
        try {
          const e = JSON.parse(ln);
          if (e.t === 'enq') {
            if (e.payload) agg.items.set(String(e.id), e.payload);
            agg.ensureChannel(String(e.ch));
            const inQ = agg.inQueues.get(String(e.ch));
            const postedKey = `${String(e.ch)}:${String(e.id)}`;
            if (!inQ.has(String(e.id)) && !agg.posted.has(postedKey)) {
              agg.queues.get(String(e.ch)).push(String(e.id));
              inQ.add(String(e.id));
            }
          } else if (e.t === 'ack') {
            agg.posted.add(`${String(e.ch)}:${String(e.id)}`);
          }
        } catch {}
      }
    }
  }
}

export class AggQueue {
  constructor(spoolDir, flushMs = 2000, ttlMs = 24 * 60 * 60 * 1000) {
    this.queues = new Map();      // channelId -> string[] (itemIds)
    this.inQueues = new Map();    // channelId -> Set<itemId>
    this.items = new Map();       // itemId -> {embed,components,content,createdAtMs,firstSeenMs}
    this.posted = new TTLSet(ttlMs); // key: `${ch}:${itemId}`
    this.stats = { enq: 0, deq: 0, droppedOld: 0 };
    this.spool = new Spooler(spoolDir, flushMs);
    this.restoreFromSpool();
  }
  ensureChannel(channelId) {
    if (!this.queues.has(channelId)) this.queues.set(channelId, []);
    if (!this.inQueues.has(channelId)) this.inQueues.set(channelId, new Set());
  }
  putItemToChannels(item, channelIds) {
    const now = Date.now();
    const maxAge = Math.max(0, Number(process.env.MAX_ITEM_AGE_MS || 60_000));
    if (item.createdAtMs && (now - item.createdAtMs) > maxAge) { this.stats.droppedOld++; return; }
    if (!this.items.has(String(item.id))) {
      this.items.set(String(item.id), {
        embed: item.embed,
        components: item.components || null,
        content: item.content || null,
        createdAtMs: item.createdAtMs || now,
        firstSeenMs: now,
      });
    }
    let totalQ = this.totalQueued();
    const cap = Math.max(1, Number(process.env.CAP_WHEN_Q_HIGH || 20));
    const qHigh = Math.max(0, Number(process.env.Q_HIGH_THRESHOLD || 400));
    for (const ch of (channelIds || [])) {
      this.ensureChannel(String(ch));
      const postedKey = `${String(ch)}:${String(item.id)}`;
      if (this.posted.has(postedKey)) continue;
      const inQ = this.inQueues.get(String(ch));
      if (inQ.has(String(item.id))) continue;
      if (totalQ >= qHigh) {
        // under pressure: soft-cap new enqueues per call
        if (cap <= 0) continue;
      }
      this.queues.get(String(ch)).push(String(item.id));
      inQ.add(String(item.id));
      this.stats.enq++;
      this.spool.append({ t: 'enq', ch: String(ch), id: String(item.id), payload: this.spool.hasItem(String(item.id)) ? undefined : this.items.get(String(item.id)) });
      totalQ++;
    }
  }
  pullForChannel(channelId, n = 1) {
    this.ensureChannel(String(channelId));
    const q = this.queues.get(String(channelId));
    const inQ = this.inQueues.get(String(channelId));
    const out = [];
    while (q.length && out.length < n) {
      const id = q.shift();
      inQ.delete(id);
      const payload = this.items.get(String(id));
      if (!payload) continue;
      out.push({ id: String(id), ...payload });
      this.stats.deq++;
    }
    return out;
  }
  markPosted(channelId, itemId) {
    const key = `${String(channelId)}:${String(itemId)}`;
    this.posted.add(key);
    this.spool.append({ t: 'ack', ch: String(channelId), id: String(itemId) });
  }
  totalQueued() {
    let s = 0; for (const q of this.queues.values()) s += q.length;
    return s;
  }
  restoreFromSpool() { this.spool.restore(this); }
}

export const aggQueue = new AggQueue(process.env.SPOOL_DIR || './spool', Number(process.env.SPOOL_FLUSH_MS || 2000));

