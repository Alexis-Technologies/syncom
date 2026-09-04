'use strict';

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('..');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { runSyncManagerCoreTests } = require('./suites/sync-manager.js');

test('SyncManager', async (t) => {
  await runSyncManagerCoreTests(t, assert, async (t2) => {
    const tempDir = await createTemp();
    t2.after(() => cleanupTemp(tempDir));
    const storage = await syncom.open({ path: tempDir });
    return storage.sync;
  });
});
