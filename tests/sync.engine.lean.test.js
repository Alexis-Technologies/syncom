'use strict';

// The convergence properties over the lean core with the blocks registered
// by hand — `open({ plugins: [text, tree, signing] })` from the root, no
// chain, no sealing — the way an application that picks its blocks opens a
// storage. The same suite as the `/all` wrappers run: the registry changes
// nothing of what converges.

const test = require('node:test');
const assert = require('node:assert');
const core = require('../index.js');
const { text } = require('../src/text/text.js');
const { tree } = require('../src/tree/tree.js');
const { signing } = require('../src/signing/signing.js');
const { runSyncEngineTests } = require('./suites/sync-engine.js');
const { memory } = require('../src/memory/memory.js');

test('Sync engine (lean core, plugins by hand)', async (t) => {
  const fsi = memory();
  let n = 0;
  const paths = new Map();
  await runSyncEngineTests(t, assert, async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    if (!paths.has(key)) paths.set(key, `lean-${n++}-${name}`);
    const storage = await core.open({
      path: paths.get(key),
      fsi,
      logger: false,
      plugins: [text, tree, signing],
      ...options,
    });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
