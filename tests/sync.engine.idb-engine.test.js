'use strict';

// The convergence properties over the IndexedDB engine (one factory and one
// engine per mesh, a path per node), with the browser halves for everything else.

const test = require('node:test');
const assert = require('node:assert');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const { installBrowserGlobals, requireBrowserAll } = require('./utils/browser-env.js');
const { idbEngine } = require('../src/idb/idb.js');
const { runSyncEngineTests } = require('./suites/sync-engine.js');

test('Sync engine (IndexedDB engine)', async (t) => {
  const env = installBrowserGlobals();
  t.after(() => env.uninstall());
  const browser = requireBrowserAll();
  const engine = idbEngine({ indexedDB: new IDBFactory(), IDBKeyRange, channel: null });
  t.after(() => engine.close());

  let n = 0;
  const paths = new Map();
  await runSyncEngineTests(t, assert, async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    if (!paths.has(key)) paths.set(key, `mesh-${n++}-${name}`);
    const storage = await browser.createDatabase({ defer: 0, path: paths.get(key), engine, logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
