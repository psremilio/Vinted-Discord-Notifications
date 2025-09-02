// Simple Consistent Hash Ring with virtual nodes
import crypto from 'crypto';

export class HashRing {
  constructor(virtualsPerNode = 128) {
    this.virtuals = Math.max(1, Number(virtualsPerNode || 128));
    this.ring = []; // [{ hash: number, id: string }]
    this.nodes = new Map(); // id -> weight (>=1)
  }

  _hash(s) {
    const h = crypto.createHash('md5').update(String(s)).digest();
    // take first 4 bytes as uint32
    return h.readUInt32BE(0);
  }

  _rebuild() {
    const arr = [];
    for (const [id, weight] of this.nodes.entries()) {
      const w = Math.max(1, Math.floor(weight || 1));
      const vn = this.virtuals * w;
      for (let i = 0; i < vn; i++) {
        const key = `${id}#${i}`;
        arr.push({ hash: this._hash(key), id });
      }
    }
    arr.sort((a, b) => a.hash - b.hash);
    this.ring = arr;
  }

  add(id, weight = 1) {
    if (this.nodes.has(id)) {
      const prev = this.nodes.get(id);
      if (prev === weight) return;
    }
    this.nodes.set(id, Math.max(1, Math.floor(weight || 1)));
    this._rebuild();
  }

  remove(id) {
    if (!this.nodes.has(id)) return;
    this.nodes.delete(id);
    this._rebuild();
  }

  size() { return this.nodes.size; }

  get(key) {
    if (!this.ring.length) return null;
    const h = this._hash(String(key));
    // binary search first >= h
    let lo = 0, hi = this.ring.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.ring[mid].hash >= h) { ans = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    return this.ring[ans % this.ring.length]?.id || null;
  }

  next(id) {
    if (!this.ring.length || !id) return null;
    // find first occurrence of id in ring and return next distinct id
    const n = this.ring.length;
    for (let i = 0; i < n; i++) {
      if (this.ring[i].id === id) {
        for (let j = 1; j < n; j++) {
          const cand = this.ring[(i + j) % n].id;
          if (cand !== id) return cand;
        }
        return id; // only one node
      }
    }
    return this.ring[0].id;
  }
}
