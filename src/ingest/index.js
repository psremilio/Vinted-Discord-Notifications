import { bus } from './eventBus.js';
import { routeListing, startRouterReloadLoop } from './router.js';
import { startWsClient } from './push/wsClient.js';
import { startWebhookServer } from './push/webhookServer.js';

let started = false;

export function startPushIngest(discordClient) {
  if (started) return;
  started = true;
  try { console.log('[push.ingest] starting push ingestion pipeline'); } catch {}

  startRouterReloadLoop();
  startWsClient();
  startWebhookServer();

  bus.on('listing', async (listing) => {
    try {
      await routeListing(discordClient, listing);
    } catch (err) {
      console.warn('[push.ingest] route failed:', err?.message || err);
    }
  });
}