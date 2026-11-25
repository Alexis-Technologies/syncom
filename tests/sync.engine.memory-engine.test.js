'use strict';

// The convergence properties over the engine in memory: one engine shared by
// every node of the mesh, a path per node.

const { describe, before } = require('node:test');
const assert = require('node:assert/strict');
const syncom = require('../src/all/all.js');
const { runSyncEngineTests } = require('./suites/sync-engine.js');

describe('Sync engine (memory engine)', () => {
  let engine = null;
  before(() => {
    engine = syncom.memoryEngine();
  });
  let n = 0;
  const paths = new Map();
  runSyncEngineTests(assert, async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    if (!paths.has(key)) paths.set(key, `mesh-${n++}-${name}`);
    const storage = await syncom.createDatabase({ defer: 0, path: paths.get(key), engine, logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
