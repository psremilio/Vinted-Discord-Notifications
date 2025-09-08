import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

// Mock filesystem only for channels.json
const realRead = fs.readFileSync;
const realWrite = fs.writeFileSync;
const CHANNELS_PATH = '/config/channels.json';
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
  return {
    options: {
      getSubcommand: () => sub,
      getString: (k) => data[k] ?? null,
    },
    deferReply: mock.fn(() => Promise.resolve()),
    reply: mock.fn(() => Promise.resolve()),
    editReply: mock.fn(() => Promise.resolve()),
    followUp: mock.fn(() => Promise.resolve()),
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

test('create/replace/delete filter is idempotent', async () => {
  store = [{ channelId: '1', channelName: 'rule', url: 'https://www.vinted.de/catalog?search_text=a', titleBlacklist: [] }];

  // create append
  let itx = interactionFor('create', { name: 'rule', keywords: 'foo, bar', mode: 'append' });
  await execute(itx);
  await sleep(10);
  assert.deepEqual(store[0].titleBlacklist, ['bar', 'foo']);

  // create append duplicates ignored
  itx = interactionFor('create', { name: 'rule', keywords: 'bar', mode: 'append' });
  await execute(itx);
  await sleep(10);
  assert.deepEqual(store[0].titleBlacklist, ['bar', 'foo']);

  // replace
  itx = interactionFor('create', { name: 'rule', keywords: 'baz', mode: 'replace' });
  await execute(itx);
  await sleep(10);
  assert.deepEqual(store[0].titleBlacklist, ['baz']);

  // delete specific
  itx = interactionFor('delete', { name: 'rule', keywords: 'baz' });
  await execute(itx);
  await sleep(10);
  assert.deepEqual(store[0].titleBlacklist, []);

  // delete all (no keywords)
  store[0].titleBlacklist = ['x'];
  itx = interactionFor('delete', { name: 'rule' });
  await execute(itx);
  await sleep(10);
  assert.deepEqual(store[0].titleBlacklist, []);
});
