'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installBrowserGlobals, requireBrowserBarrel } = require('./utils/browser-env.js');
const { runSignatureTests } = require('./suites/signatures.js');

test('Signatures (browser halves)', async (t) => {
  const env = installBrowserGlobals();
  t.after(() => env.uninstall());
  const browser = requireBrowserBarrel();

  let n = 0;
  await runSignatureTests(t, assert, async (t2, name, options = {}) => {
    const storage = await browser.open({ path: `signatures-${n++}-${name}`, logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
