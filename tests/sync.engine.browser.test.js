'use strict';

// Files land at once here (`defer: 0`): what these tests read of the disk is the engine's, not the window's — the window has tests of its own (storage.defer, storage.group).

const test = require('node:test');
const assert = require('node:assert');
const { installBrowserGlobals, requireBrowserAll } = require('./utils/browser-env.js');
const { runSyncEngineTests } = require('./suites/sync-engine.js');

test('Sync engine (browser halves)', async (t) => {
  const env = installBrowserGlobals();
  t.after(() => env.uninstall());
  const browser = requireBrowserAll();

  let n = 0;
  const paths = new Map();
  await runSyncEngineTests(t, assert, async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    if (!paths.has(key)) paths.set(key, `mesh-${n++}-${name}`);
    const storage = await browser.open({ defer: 0, path: paths.get(key), logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});
