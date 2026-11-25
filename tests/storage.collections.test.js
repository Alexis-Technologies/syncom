'use strict';

// Files land at once here (`defer: 0`): what these tests read of the disk is the engine's, not the window's — the window has tests of its own (storage.defer, storage.group).

const { describe } = require('node:test');
const assert = require('node:assert/strict');
const syncom = require('../src/all/all.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { runCollectionTests } = require('./suites/collections.js');

describe('Collections (node)', () => {
  // The same name within one subtest reopens the same directory.
  const dirs = new Map();
  runCollectionTests(assert, async (t, name, options = {}) => {
    const key = `${t.name}:${name}`;
    let dir = dirs.get(key);
    if (!dir) {
      dir = await createTemp();
      dirs.set(key, dir);
      t.after(() => cleanupTemp(dir));
    }
    const storage = await syncom.createDatabase({ defer: 0, path: dir, logger: false, ...options });
    t.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
