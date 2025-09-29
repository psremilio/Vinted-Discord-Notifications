import WebSocket from 'ws';
import { normalizeListing, isValidListing } from '../shapes.js';
import { bus } from '../eventBus.js';

const MIN = Math.max(200, Number(process.env.PUSH_WS_RECONNECT_MIN_MS || 1000));
const MAX = Math.max(MIN, Number(process.env.PUSH_WS_RECONNECT_MAX_MS || 15000));

export function startWsClient() {
  const url = process.env.PUSH_WS_URL;
  if (!url) {
    console.log('[push.ws] no PUSH_WS_URL configured, skipping WebSocket ingest');
    return;
  }

  let backoff = MIN;
  let ws = null;

  const headers = {};
  if (process.env.PUSH_WS_AUTH) headers['Authorization'] = process.env.PUSH_WS_AUTH;

  function scheduleReconnect() {
    const delay = backoff + Math.floor(Math.random() * 200);
    backoff = Math.min(MAX, Math.floor(backoff * 1.8));
    setTimeout(connect, delay).unref?.();
  }

  function connect() {
    try {
      ws = new WebSocket(url, { headers });
    } catch (err) {
      console.warn('[push.ws] connect failed:', err?.message || err);
      scheduleReconnect();
      return;
    }

    ws.on('open', () => {
      backoff = MIN;
      try { console.log('[push.ws] connected'); } catch {}
    });

    ws.on('message', (buffer) => {
      try {
        const text = buffer?.toString?.('utf8') ?? String(buffer ?? '');
        if (!text) return;
        const msg = JSON.parse(text);
        const envelope = msg?.message ?? msg?.data ?? msg;
        const listing = normalizeListing(envelope);
        if (isValidListing(listing)) {
          bus.emit('listing', listing);
        }
      } catch (err) {
        console.warn('[push.ws] invalid frame:', err?.message || err);
      }
    });

    ws.on('close', (code) => {
      try { console.warn('[push.ws] closed', code); } catch {}
      scheduleReconnect();
    });

    ws.on('error', (err) => {
      try { console.warn('[push.ws] error:', err?.message || err); } catch {}
      try { ws.close(); } catch {}
    });
  }

  connect();
}