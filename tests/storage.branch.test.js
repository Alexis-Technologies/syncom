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

test('drop() on the lean core, and a drop cut short: the branch closes first, its branch.json goes last', async () => {
  const { memory } = require('../src/memory/memory.js');
  const { branch, drop, branchInfo } = require('../src/branch/branch.js');
  const { open } = require('../src/index.js');
  const fsi = memory();
  // The lean core: no versions plugin, so no tags() — drop must not need it.
  const parent = await open({ path: 'p', fsi, logger: false, defer: 0, lock: false });
  await parent.insert({ n: 1 });
  const child = await branch(parent, { path: 'b', fsi, logger: false, defer: 0 });
  await drop(child);
  assert.deepStrictEqual(await fsi.list('b'), [], 'every file of the branch went');
  // A drop whose removal fails half way leaves branch.json, so drop() takes it again.
  const again = await branch(parent, { path: 'c', fsi, logger: false, defer: 0 });
  const remove = fsi.remove;
  let failing = true;
  fsi.remove = async (dir, name) => {
    if (failing && dir === 'c/log') throw new Error('disk gone');
    return remove(dir, name);
  };
  await assert.rejects(drop(again), /disk gone/);
  failing = false;
  assert.ok(await fsi.exists('c', 'branch.json'), 'branch.json stays until the end');
  const reopened = await open({ path: 'c', fsi, logger: false, defer: 0 });
  assert.notStrictEqual(await branchInfo(reopened), null);
  await drop(reopened);
  assert.strictEqual(await fsi.exists('c', 'branch.json'), false);
  await parent.close();
});
