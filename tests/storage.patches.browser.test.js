'use strict';

const { describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { installBrowserGlobals, requireBrowserAll, prime } = require('./utils/browser-env.js');
// Before the suite and everything it loads: the shared modules resolve to the browser halves.
prime();
const { runPatchTests } = require('./suites/patches.js');

describe('Patches (browser halves)', () => {
  let env = null;
  let browser = null;
  before(() => {
    env = installBrowserGlobals();
    browser = requireBrowserAll();
  });
  after(() => env.uninstall());

  let n = 0;
  const paths = new Map();
  runPatchTests(assert, async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    if (!paths.has(key)) paths.set(key, `patches-${n++}-${name}`);
    const storage = await browser.createDatabase({ path: paths.get(key), logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
