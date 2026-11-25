'use strict';

const { describe } = require('node:test');
const assert = require('node:assert/strict');
const syncom = require('../src/all/all.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { runPatchTests } = require('./suites/patches.js');

describe('Patches (node)', () => {
  const dirs = new Map();
  runPatchTests(assert, async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    let dir = dirs.get(key);
    if (!dir) {
      dir = await createTemp();
      dirs.set(key, dir);
      t2.after(() => cleanupTemp(dir));
    }
    const storage = await syncom.createDatabase({ path: dir, logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
