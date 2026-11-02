'use strict';

// The convergence properties over the MongoDB engine (the driver in memory,
// one client and one engine per mesh in transactions, a path per node).

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { mongoEngine } = require('../src/mongodb/mongodb.js');
const { createFakeMongo } = require('./utils/fake-mongo.js');
const { runSyncEngineTests } = require('./suites/sync-engine.js');

test('Sync engine (MongoDB engine)', async (t) => {
  const engine = mongoEngine({ client: createFakeMongo(), transactions: true });
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
