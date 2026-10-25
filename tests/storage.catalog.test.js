'use strict';

// Files land at once here (`defer: 0`): what these tests read of the disk is the engine's, not the window's — the window has tests of its own (storage.defer, storage.group).

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { runCatalogTests } = require('./suites/catalog.js');

test('Catalog (node)', async (t) => {
  // The same name within one subtest reopens the same directory.
  const dirs = new Map();
  await runCatalogTests(t, assert, async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    let dir = dirs.get(key);
    if (!dir) {
      dir = await createTemp();
      dirs.set(key, dir);
      t2.after(() => cleanupTemp(dir));
    }
    const storage = await syncom.open({ defer: 0, path: dir, logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
