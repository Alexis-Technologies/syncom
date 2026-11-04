'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installBrowserGlobals, requireBrowserAll, prime } = require('./utils/browser-env.js');
// Before the suite and everything it loads: the shared modules resolve to the browser halves.
prime();
const { runSchemaTests } = require('./suites/schema.js');

test('Schema (browser halves)', async (t) => {
  const env = installBrowserGlobals();
  t.after(() => env.uninstall());
  const browser = requireBrowserAll();

  let n = 0;
  const paths = new Map();
  await runSchemaTests(t, assert, async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    if (!paths.has(key)) paths.set(key, `schema-${n++}-${name}`);
    const storage = await browser.createDatabase({ path: paths.get(key), logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
