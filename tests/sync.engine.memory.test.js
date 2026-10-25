'use strict';

// The convergence properties over one memory backend shared by every node
// of the mesh — the path is the node's name, so they never collide.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { runSyncEngineTests } = require('./suites/sync-engine.js');

test('Sync engine (memory backend)', async (t) => {
  const fsi = syncom.createMemoryFsi();
  let n = 0;
  const paths = new Map();
  await runSyncEngineTests(t, assert, async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    if (!paths.has(key)) paths.set(key, `mesh-${n++}-${name}`);
    const storage = await syncom.open({ path: paths.get(key), fsi, logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
