'use strict';

// Files land at once here (`defer: 0`): what these tests read of the disk is the engine's, not the window's — the window has tests of its own (storage.defer, storage.group).

const test = require('node:test');
const assert = require('node:assert');
const { installBrowserGlobals, requireBrowserAll, prime } = require('./utils/browser-env.js');
// Before the suite and everything it loads: the shared modules resolve to the browser halves.
prime();
const { runCollectionTests } = require('./suites/collections.js');

test('Collections (browser halves)', async (t) => {
  const env = installBrowserGlobals();
  t.after(() => env.uninstall());
  const browser = requireBrowserAll();

  // The shared modules the suite loaded (the mesh's link requires src/utils.js) run on the browser halves.
  assert.strictEqual(require('../src/utils.js'), require('../src/utils.browser.js'), 'primed before the suite');

  let n = 0;
  const paths = new Map();
  const createStorage = async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    if (!paths.has(key)) paths.set(key, `collections-${n++}-${name}`);
    const storage = await browser.createDatabase({ defer: 0, path: paths.get(key), logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  };
  createStorage.browser = true;
  await runCollectionTests(t, assert, createStorage);
});
