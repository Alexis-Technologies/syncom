'use strict';

const { describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { installBrowserGlobals, requireBrowserAll, prime } = require('./utils/browser-env.js');
// Before the suite and everything it loads: the shared modules resolve to the browser halves.
prime();
const { runSyncManagerCoreTests } = require('./suites/sync-manager.js');

describe('SyncManager (browser)', () => {
  let env = null;
  let browser = null;
  before(() => {
    env = installBrowserGlobals();
    browser = requireBrowserAll();
  });
  after(() => env.uninstall());

  // The registry lives in OPFS now, so the reopen case is real in the browser too.
  const dirs = new WeakMap();
  let n = 0;
  runSyncManagerCoreTests(assert, async (t2, previous) => {
    const path = (previous && dirs.get(previous)) || `sync-${n++}`;
    const storage = await browser.createDatabase({ path });
    dirs.set(storage.sync, path);
    return storage.sync;
  });
});
