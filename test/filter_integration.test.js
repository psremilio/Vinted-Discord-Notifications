import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

// Mock channels.json persistence
const realRead = fs.readFileSync;
const realWrite = fs.writeFileSync;
let store = [];
mock.method(fs, 'readFileSync', (path, ...args) => {
  if (typeof path === 'string' && path.endsWith('channels.json')) {
    return JSON.stringify(store);
  }
  return realRead.call(fs, path, ...args);
});
mock.method(fs, 'writeFileSync', (path, data, ...args) => {
  if (typeof path === 'string' && path.endsWith('channels.json')) {
    store = JSON.parse(String(data || '[]'));
    return;
  }
  return realWrite.call(fs, path, data, ...args);
});

const { execute } = await import('../src/commands/filter.js');

function interactionFor(sub, opts = {}) {
  const data = { sub, ...opts };
  const itx = {
    options: {
      getSubcommand: () => sub,
      getString: (k) => data[k] ?? null,
    },
    deferred: false,
    replied: false,
    deferReply: mock.fn(() => { itx.deferred = true; return Promise.resolve(); }),
    reply: mock.fn(() => { itx.replied = true; return Promise.resolve(); }),
    editReply: mock.fn(() => { return Promise.resolve(); }),
    followUp: mock.fn(() => Promise.resolve()),
  };
  return itx;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

test('create → ack → persist', async () => {
  store = [{ channelId: '1', channelName: 'alpha', url: 'https://www.vinted.de/catalog?search_text=a', titleBlacklist: [] }];
  const itx = interactionFor('create', { name: 'alpha', keywords: 'red,blue' });
  await execute(itx);
  await sleep(10);
  assert.equal(itx.deferReply.mock.calls.length >= 1, true);
  assert.deepEqual(store[0].titleBlacklist, ['blue','red']);
});
