import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

// ensure addSearch detects test environment and skips network
process.env.NODE_ENV = 'test';

// Mock filesystem only for channels.json
const realRead = fs.readFileSync;
const realWrite = fs.writeFileSync;
mock.method(fs, 'readFileSync', (path, ...args) => {
  if (typeof path === 'string' && path.endsWith('channels.json')) {
    return '[]';
  }
  return realRead.call(fs, path, ...args);
});
mock.method(fs, 'writeFileSync', (path, data, ...args) => {
  if (typeof path === 'string' && path.endsWith('channels.json')) {
    return;
  }
  return realWrite.call(fs, path, data, ...args);
});

// Import run.js before stubbing timers so undici initializes normally
import { activeSearches } from '../src/run.js';

// Prevent timers from keeping process alive
mock.method(global, 'setTimeout', () => 0);

const { execute } = await import('../src/commands/new_search.js');

function buildInteraction() {
  return {
    options: {
      getString: (name) => {
        switch (name) {
          case 'url':
            return 'https://www.vinted.de/catalog?search_text=test';
          case 'banned_keywords':
            return null;
          case 'frequency':
            return null;
          case 'name':
            return 'test';
          default:
            return null;
        }
      }
    },
    channel: { id: '42' },
    client: {},
    deferReply: mock.fn(() => Promise.resolve()),
    followUp: mock.fn(() => Promise.resolve())
  };
}

test('new search schedules immediately', async () => {
  activeSearches.clear();

  const interaction = buildInteraction();
  await execute(interaction);
  assert.equal(activeSearches.has('test'), true);
});

test('existing search is not rescheduled', async () => {
  activeSearches.clear();
  activeSearches.set('test', true);

  const interaction = buildInteraction();
  await execute(interaction);
  assert.equal(activeSearches.size, 1);
});
