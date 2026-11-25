'use strict';

// The convergence properties over the IndexedDB engine (one factory and one
// engine per mesh, a path per node), with the browser halves for everything else.

const { describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const { installBrowserGlobals, requireBrowserAll, prime } = require('./utils/browser-env.js');
// Before the suite and everything it loads: the shared modules resolve to the browser halves.
prime();
const { idbEngine } = require('../src/idb/idb.js');
const { runSyncEngineTests } = require('./suites/sync-engine.js');

describe('Sync engine (IndexedDB engine)', () => {
  let env = null;
  let browser = null;
  let engine = null;
  before(() => {
    env = installBrowserGlobals();
    browser = requireBrowserAll();
    engine = idbEngine({ indexedDB: new IDBFactory(), IDBKeyRange, channel: null });
  });
  after(() => env.uninstall());
  after(() => engine.close());

  let n = 0;
  const paths = new Map();
  runSyncEngineTests(assert, async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    if (!paths.has(key)) paths.set(key, `mesh-${n++}-${name}`);
    const storage = await browser.createDatabase({ defer: 0, path: paths.get(key), engine, logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
