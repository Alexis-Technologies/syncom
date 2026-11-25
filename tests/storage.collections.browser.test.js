'use strict';

// Files land at once here (`defer: 0`): what these tests read of the disk is the engine's, not the window's — the window has tests of its own (storage.defer, storage.group).

const { describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { installBrowserGlobals, requireBrowserAll, prime } = require('./utils/browser-env.js');
// Before the suite and everything it loads: the shared modules resolve to the browser halves.
prime();
const { runCollectionTests } = require('./suites/collections.js');

describe('Collections (browser halves)', () => {
  let env = null;
  let browser = null;
  before(() => {
    env = installBrowserGlobals();
    browser = requireBrowserAll();
    // The shared modules the suite loaded (the mesh's link requires src/utils.js) run on the browser halves.
    assert.strictEqual(require('../src/utils.js'), require('../src/utils.browser.js'), 'primed before the suite');
  });
  after(() => env.uninstall());

  let n = 0;
  const paths = new Map();
  const createStorage = async (t, name, options = {}) => {
    const key = `${t.name}:${name}`;
    if (!paths.has(key)) paths.set(key, `collections-${n++}-${name}`);
    const storage = await browser.createDatabase({ defer: 0, path: paths.get(key), logger: false, ...options });
    t.after(() => storage.close().catch(() => {}));
    return storage;
  };
  createStorage.browser = true;
  runCollectionTests(assert, createStorage);
});
