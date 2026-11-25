'use strict';

// The convergence properties over SQLite encrypted at rest: one engine over a
// `:memory:` database under one key, shared by every node of the mesh, a path
// per node — every row a ciphertext bound to its place and its database, every
// statement on one lane.

const { describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
require('./utils/quiet-sqlite.js');
const syncom = require('../src/all/all.js');
const { atRest } = require('../src/encryption/encryption.js');
const { sqliteEngine } = require('../src/sqlite/sqlite.js');
const { runSyncEngineTests } = require('./suites/sync-engine.js');

describe('Sync engine (at-rest engine over SQLite)', () => {
  let engine = null;
  before(() => {
    engine = atRest(sqliteEngine(), { key: Uint8Array.from({ length: 32 }, (_, i) => i * 5 + 1) });
  });
  after(() => engine.close());
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
