'use strict';

// The convergence properties over an engine served across a MessageChannel:
// the engine in memory on one end, every node of the mesh on the other, a
// path per node.

const { describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const syncom = require('../src/all/all.js');
const { serveEngine, remoteEngine } = require('../src/engines/engines.js');
const { runSyncEngineTests } = require('./suites/sync-engine.js');

describe('Sync engine (remote engine)', () => {
  let server = null;
  let engine = null;
  before(() => {
    const inner = syncom.memoryEngine();
    const { port1, port2 } = new MessageChannel();
    server = serveEngine(inner, port1);
    engine = remoteEngine(port2, { name: inner.name, capabilities: inner.capabilities });
  });
  after(async () => {
    await engine.close();
    await server.close();
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
