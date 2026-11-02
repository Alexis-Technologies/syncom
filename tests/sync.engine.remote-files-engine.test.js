'use strict';

// The convergence properties over the FILES engine served across a
// MessageChannel: the one combination where a scrub, a failed append and a
// compaction cross the port into a journal (ENG-12) — the hazard walk runs
// over it, not over the engine in memory alone.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');
const { serveEngine, remoteEngine } = require('../src/engines/engines.js');
const { runSyncEngineTests } = require('./suites/sync-engine.js');

test('Sync engine (remote engine over files)', async (t) => {
  const inner = syncom.filesEngine(memory());
  const { port1, port2 } = new MessageChannel();
  const server = serveEngine(inner, port1);
  const engine = remoteEngine(port2, { name: inner.name, capabilities: inner.capabilities });
  t.after(async () => {
    await engine.close();
    await server.close();
  });
  let n = 0;
  const paths = new Map();
  await runSyncEngineTests(t, assert, async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    if (!paths.has(key)) paths.set(key, `/mesh-${n++}-${name}`);
    const storage = await syncom.createDatabase({ defer: 0, path: paths.get(key), engine, logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
