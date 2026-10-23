'use strict';

// src/signing.js over the browser crypto half: the cache is primed by
// requireBrowserBarrel(), so its `./crypto.js` resolves to crypto.browser.js.

const test = require('node:test');
const assert = require('node:assert');
const { installBrowserGlobals, requireBrowserBarrel } = require('./utils/browser-env.js');
const { runSigningTests } = require('./suites/signing.js');

test('signing (browser)', async (t) => {
  const env = installBrowserGlobals();
  t.after(() => env.uninstall());
  const browser = requireBrowserBarrel();
  const signing = require('../src/signing.js');
  assert.ok(browser.calculateHash({}) instanceof Promise, 'the browser half is in');
  await runSigningTests(t, assert, signing, browser);
});
