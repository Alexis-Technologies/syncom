'use strict';

// Files land at once here (`defer: 0`): what these tests read of the disk is the engine's, not the window's — the window has tests of its own (storage.defer, storage.group).

// The convergence properties over one memory backend shared by every node
// of the mesh — the path is the node's name, so they never collide.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { runSyncEngineTests } = require('./suites/sync-engine.js');
const { memory } = require('../src/memory/memory.js');

test('Sync engine (memory backend)', async (t) => {
  const fsi = memory();
  let n = 0;
  const paths = new Map();
  await runSyncEngineTests(t, assert, async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    if (!paths.has(key)) paths.set(key, `mesh-${n++}-${name}`);
    const storage = await syncom.open({ defer: 0, path: paths.get(key), fsi, logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
