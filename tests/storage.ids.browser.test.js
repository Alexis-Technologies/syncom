'use strict';

const { describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { installBrowserGlobals, requireBrowserAll, prime } = require('./utils/browser-env.js');
// Before the suite and everything it loads: the shared modules resolve to the browser halves.
prime();
const { runIdTests } = require('./suites/ids.js');

describe('Record ids (browser halves)', () => {
  let env = null;
  let browser = null;
  before(() => {
    env = installBrowserGlobals();
    browser = requireBrowserAll();
  });
  after(() => env.uninstall());

  let n = 0;
  const paths = new Map();
  runIdTests(assert, async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    if (!paths.has(key)) paths.set(key, `ids-${n++}-${name}`);
    const storage = await browser.createDatabase({ path: paths.get(key), logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
