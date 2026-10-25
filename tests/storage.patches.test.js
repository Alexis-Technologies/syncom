'use strict';

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { runPatchTests } = require('./suites/patches.js');

test('Patches (node)', async (t) => {
  const dirs = new Map();
  await runPatchTests(t, assert, async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    let dir = dirs.get(key);
    if (!dir) {
      dir = await createTemp();
      dirs.set(key, dir);
      t2.after(() => cleanupTemp(dir));
    }
    const storage = await syncom.open({ path: dir, logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
