'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installBrowserGlobals, requireBrowserAll, prime } = require('./utils/browser-env.js');
// Before the suite and everything it loads: the shared modules resolve to the browser halves.
prime();
const { runSignatureTests } = require('./suites/signatures.js');

test('Signatures (browser halves)', async (t) => {
  const env = installBrowserGlobals();
  t.after(() => env.uninstall());
  const browser = requireBrowserAll();

  let n = 0;
  await runSignatureTests(t, assert, async (t2, name, options = {}) => {
    const storage = await browser.createDatabase({ path: `signatures-${n++}-${name}`, logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
