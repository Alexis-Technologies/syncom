'use strict';

// src/signing/sign.js over the browser crypto half: the cache is primed by
// requireBrowserBarrel(), so its `./ed25519.js` resolves to ed25519.browser.js.

const test = require('node:test');
const assert = require('node:assert');
const { installBrowserGlobals, requireBrowserBarrel, prime } = require('./utils/browser-env.js');
// Before the suite and everything it loads: the shared modules resolve to the browser halves.
prime();
const { runSigningTests } = require('./suites/signing.js');

test('signing (browser)', async (t) => {
  const env = installBrowserGlobals();
  t.after(() => env.uninstall());
  requireBrowserBarrel();
  const signing = require('../src/signing/sign.js');
  const ed25519 = require('../src/signing/ed25519.js');
  assert.ok(ed25519.calculateHash({}) instanceof Promise, 'the browser half is in');
  await runSigningTests(t, assert, signing, ed25519);
});
