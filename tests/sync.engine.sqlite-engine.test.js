'use strict';

// The convergence properties over the SQLite engine: one `:memory:` database
// shared by every node of the mesh, a path per node.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { runSyncEngineTests } = require('./suites/sync-engine.js');

// node:sqlite is experimental: Node says so once per process at the require, which this test is not about.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name !== 'ExperimentalWarning') console.error(warning.stack);
});
const { sqliteEngine } = require('../src/sqlite/sqlite.js');

test('Sync engine (SQLite engine)', async (t) => {
  const engine = sqliteEngine();
  t.after(() => engine.close());
  let n = 0;
  const paths = new Map();
  await runSyncEngineTests(t, assert, async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    if (!paths.has(key)) paths.set(key, `mesh-${n++}-${name}`);
    const storage = await syncom.createDatabase({ defer: 0, path: paths.get(key), engine, logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
