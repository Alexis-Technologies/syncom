'use strict';

// Files land at once here (`defer: 0`): what these tests read of the disk is the engine's, not the window's — the window has tests of its own (storage.defer, storage.group).

const test = require('node:test');
const assert = require('node:assert');
const { installBrowserGlobals, requireBrowserAll, prime } = require('./utils/browser-env.js');
// Before the suite and everything it loads: the shared modules resolve to the browser halves.
prime();
const { runCatalogTests } = require('./suites/catalog.js');

test('Catalog (browser halves)', async (t) => {
  const env = installBrowserGlobals();
  t.after(() => env.uninstall());
  const browser = requireBrowserAll();

  let n = 0;
  const paths = new Map();
  await runCatalogTests(t, assert, async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    if (!paths.has(key)) paths.set(key, `catalog-${n++}-${name}`);
    const storage = await browser.createDatabase({ defer: 0, path: paths.get(key), logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
