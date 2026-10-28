'use strict';

// src/signing/sign.js over the browser crypto half: the cache is primed by
// requireBrowserBarrel(), so its `./ed25519.js` resolves to ed25519.browser.js.

const test = require('node:test');
const assert = require('node:assert');
const { installBrowserGlobals, requireBrowserBarrel } = require('./utils/browser-env.js');
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
