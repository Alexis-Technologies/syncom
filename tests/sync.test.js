'use strict';

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { runSyncManagerCoreTests } = require('./suites/sync-manager.js');

test('SyncManager', async (t) => {
  // `previous` asks for the SAME directory again — the reopen case.
  const dirs = new WeakMap();
  await runSyncManagerCoreTests(t, assert, async (t2, previous) => {
    let tempDir = previous ? dirs.get(previous) : null;
    if (!tempDir) {
      tempDir = await createTemp();
      t2.after(() => cleanupTemp(tempDir));
    }
    const storage = await syncom.open({ path: tempDir });
    dirs.set(storage.sync, tempDir);
    return storage.sync;
  });
});
