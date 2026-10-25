'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installBrowserGlobals, requireBrowserAll } = require('./utils/browser-env.js');
const { runSyncManagerCoreTests } = require('./suites/sync-manager.js');

test('SyncManager (browser)', async (t) => {
  const env = installBrowserGlobals();
  t.after(() => env.uninstall());
  const browser = requireBrowserAll();

  // The registry lives in OPFS now, so the reopen case is real in the browser too.
  const dirs = new WeakMap();
  let n = 0;
  await runSyncManagerCoreTests(t, assert, async (t2, previous) => {
    const path = (previous && dirs.get(previous)) || `sync-${n++}`;
    const storage = await browser.open({ path });
    dirs.set(storage.sync, path);
    return storage.sync;
  });
});
