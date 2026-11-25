'use strict';

// src/signing/sign.js over the browser crypto half: the cache is primed by
// requireBrowserBarrel(), so its `./ed25519.js` resolves to ed25519.browser.js.

const { describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { installBrowserGlobals, requireBrowserBarrel, prime } = require('./utils/browser-env.js');
// Before the suite and everything it loads: the shared modules resolve to the browser halves.
prime();
const { runSigningTests } = require('./suites/signing.js');

describe('signing (browser)', () => {
  // The browser halves touch no global at load: the modules are taken here, the globals before the tests.
  requireBrowserBarrel();
  const signing = require('../src/signing/sign.js');
  const ed25519 = require('../src/signing/ed25519.js');
  let env = null;
  before(() => {
    env = installBrowserGlobals();
    assert.ok(ed25519.calculateHash({}) instanceof Promise, 'the browser half is in');
  });
  after(() => env.uninstall());
  runSigningTests(assert, signing, ed25519);
});
