'use strict';

// The convergence properties over IndexedDB (one factory per mesh, one
// database per node), with the browser halves for everything else.

const test = require('node:test');
const assert = require('node:assert');
const { IDBFactory } = require('fake-indexeddb');
const { installBrowserGlobals, requireBrowserAll } = require('./utils/browser-env.js');
const { createIdbFsi } = require('../src/idb/idb.js');
const { runSyncEngineTests } = require('./suites/sync-engine.js');

test('Sync engine (IndexedDB backend)', async (t) => {
  const env = installBrowserGlobals();
  t.after(() => env.uninstall());
  const browser = requireBrowserAll();
  const factory = new IDBFactory();

  let n = 0;
  const backends = new Map();
  await runSyncEngineTests(t, assert, async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    if (!backends.has(key)) {
      const fsi = createIdbFsi({ indexedDB: factory, name: `mesh-${n++}-${name}` });
      backends.set(key, fsi);
      t2.after(() => fsi.close());
    }
    const storage = await browser.open({ path: name, fsi: backends.get(key), logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
