'use strict';

// The editor binding over the Node half: in memory, files landing at once (`defer: 0`).

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');
const { runEditorTests } = require('./suites/editor.js');

test('Editor binding (node)', async (t) => {
  await runEditorTests(t, assert, async (t2, name, options = {}) => {
    const storage = await syncom.open({ defer: 0, path: `/${name}`, fsi: memory(), logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
