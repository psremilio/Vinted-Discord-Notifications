import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

// Mock filesystem
mock.method(fs, 'readFileSync', () => '[]');
mock.method(fs, 'writeFileSync', () => {});

// Import run.js before stubbing timers so undici initializes normally
import { activeSearches } from '../src/run.js';

// Prevent timers from keeping process alive
mock.method(global, 'setTimeout', () => 0);

const { execute } = await import('../src/commands/new_search.js');

test('new search schedules immediately', async () => {
  activeSearches.clear();

  const interaction = {
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

  await execute(interaction);
  assert.equal(activeSearches.has('test'), true);
});
