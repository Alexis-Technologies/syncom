'use strict';

// Storage over IndexedDB, with the browser halves for everything else: what
// a browser without OPFS runs.

const test = require('node:test');
const assert = require('node:assert');
const { IDBFactory } = require('fake-indexeddb');
const { installBrowserGlobals, requireBrowserAll } = require('./utils/browser-env.js');
const { createIdbFsi } = require('../src/idb/idb.js');

test('Storage over IndexedDB', async (t) => {
  const env = installBrowserGlobals();
  t.after(() => env.uninstall());
  const browser = requireBrowserAll();

  await t.test('insert, get, replicate-shaped reads, reopen', async () => {
    const factory = new IDBFactory();
    const fsi = createIdbFsi({ indexedDB: factory, name: 'app' });
    const storage = await browser.open({ path: 'store', fsi, logger: false });
    const id = await storage.insert({ title: 'Draft' });
    await storage.update(id, { title: 'Final' });
    assert.deepStrictEqual(await storage.get(id), { title: 'Final' });
    assert.strictEqual(await storage.validate(), true);
    assert.deepStrictEqual(await storage.list(), [id]);
    const { nodeId } = storage;
    await storage.close();
    // Not in OPFS: the mock has nothing under the path.
    assert.deepStrictEqual(await browser.list('store/data'), []);
    assert.deepStrictEqual(await fsi.list('store/data'), [`${id}.json`]);

    const reopened = await browser.open({ path: 'store', fsi, logger: false });
    assert.strictEqual(reopened.nodeId, nodeId);
    assert.deepStrictEqual(await reopened.get(id), { title: 'Final' });
    await reopened.close();
    await fsi.close();
  });
});
