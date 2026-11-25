'use strict';

const { describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { installBrowserGlobals, requireBrowserAll, prime } = require('./utils/browser-env.js');
// Before the suite and everything it loads: the shared modules resolve to the browser halves.
prime();
const { runSignatureTests } = require('./suites/signatures.js');

describe('Signatures (browser halves)', () => {
  let env = null;
  let browser = null;
  before(() => {
    env = installBrowserGlobals();
    browser = requireBrowserAll();
  });
  after(() => env.uninstall());

  let n = 0;
  runSignatureTests(assert, async (t2, name, options = {}) => {
    const storage = await browser.createDatabase({ path: `signatures-${n++}-${name}`, logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
