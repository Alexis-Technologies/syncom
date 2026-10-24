'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installBrowserGlobals, requireBrowserBarrel } = require('./utils/browser-env.js');
const { runBranchTests } = require('./suites/branch.js');

test('Branches (browser halves)', async (t) => {
  const env = installBrowserGlobals();
  t.after(() => env.uninstall());
  const browser = requireBrowserBarrel();

  let n = 0;
  const paths = new Map();
  const createStorage = async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    if (!paths.has(key)) paths.set(key, `branch-${n++}-${name}`);
    const storage = await browser.open({ path: paths.get(key), logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  };
  const branchPath = (t2, name) => {
    const key = `${t2.name}:branch:${name}`;
    if (!paths.has(key)) paths.set(key, `branch-${n++}-${name}`);
    return paths.get(key);
  };
  await runBranchTests(t, assert, createStorage, branchPath);
});
