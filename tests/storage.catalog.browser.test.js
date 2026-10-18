'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installBrowserGlobals, requireBrowserBarrel } = require('./utils/browser-env.js');
const { runCatalogTests } = require('./suites/catalog.js');

test('Catalog (browser halves)', async (t) => {
  const env = installBrowserGlobals();
  t.after(() => env.uninstall());
  const browser = requireBrowserBarrel();

  let n = 0;
  const paths = new Map();
  await runCatalogTests(t, assert, async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    if (!paths.has(key)) paths.set(key, `catalog-${n++}-${name}`);
    const storage = await browser.open({ path: paths.get(key), logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
