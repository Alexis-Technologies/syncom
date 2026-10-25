'use strict';

// Files land at once here (`defer: 0`): what these tests read of the disk is the engine's, not the window's — the window has tests of its own (storage.defer, storage.group).

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const syncom = require('../src/all/all.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { runBranchTests } = require('./suites/branch.js');

test('Branches (node)', async (t) => {
  const dirs = new Map();
  const createStorage = async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    let dir = dirs.get(key);
    if (!dir) {
      dir = await createTemp();
      dirs.set(key, dir);
      t2.after(() => cleanupTemp(dir));
    }
    const storage = await syncom.open({ defer: 0, path: dir, logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  };
  const branchPath = (t2, name) => {
    const key = `${t2.name}:branch:${name}`;
    if (!dirs.has(key)) {
      const dir = path.join(dirs.get(`${t2.name}:A`) ?? '/tmp', `branch-${name}-${Date.now()}`);
      dirs.set(key, dir);
    }
    return dirs.get(key);
  };
  await runBranchTests(t, assert, createStorage, branchPath);
});
