'use strict';

// The editor binding over the Node half: in memory, files landing at once (`defer: 0`).

const { describe } = require('node:test');
const assert = require('node:assert/strict');
const syncom = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');
const { runEditorTests } = require('./suites/editor.js');

describe('Editor binding (node)', () => {
  runEditorTests(assert, async (t2, name, options = {}) => {
    const storage = await syncom.createDatabase({
      defer: 0,
      path: `/${name}`,
      fsi: memory(),
      logger: false,
      ...options,
    });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
