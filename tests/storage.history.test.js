'use strict';

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('..');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { runHistoryTests } = require('./suites/history.js');

test('History (node)', async (t) => {
  // The same name within one subtest reopens the same directory.
  const dirs = new Map();
  await runHistoryTests(t, assert, async (t2, name, options = {}) => {
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
