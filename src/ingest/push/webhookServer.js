import http from 'http';
import { normalizeListing, isValidListing } from '../shapes.js';
import { bus } from '../eventBus.js';

export function startWebhookServer() {
  const port = Number(process.env.PUSH_WEBHOOK_PORT || 0);
  if (!port) {
    console.log('[push.webhook] no PUSH_WEBHOOK_PORT configured, skipping webhook ingest');
    return;
  }
  const path = String(process.env.PUSH_WEBHOOK_PATH || '/push/item');
  const secret = process.env.PUSH_WEBHOOK_SECRET || '';
  const maxBytes = Math.max(8, Number(process.env.PUSH_MAX_BODY_KB || 64)) * 1024;

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url || !req.url.startsWith(path)) {
      res.writeHead(404).end();
      return;
    }

    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        if (secret) {
          const provided = req.headers['x-shared-secret'];
          if (String(provided || '') !== secret) {
            res.writeHead(401).end();
            return;
          }
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const listing = normalizeListing(payload);
        if (isValidListing(listing)) {
          bus.emit('listing', listing);
        }
        res.writeHead(204).end();
      } catch (err) {
        res.writeHead(400).end();
        console.warn('[push.webhook] invalid payload:', err?.message || err);
      }
    });

    req.on('error', (err) => {
      try { console.warn('[push.webhook] request error:', err?.message || err); } catch {}
      try { res.writeHead(500).end(); } catch {}
    });
  });

  server.listen(port, () => {
    try { console.log(`[push.webhook] listening on :${port}${path}`); } catch {}
  });

  server.on('error', (err) => {
    console.error('[push.webhook] server error:', err?.message || err);
  });
}