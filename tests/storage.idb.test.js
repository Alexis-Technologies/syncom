'use strict';

// Storage over IndexedDB, with the browser halves for everything else: what
// a browser without OPFS runs.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const { installBrowserGlobals, requireBrowserAll, prime } = require('./utils/browser-env.js');
// Before the suite and everything it loads: the shared modules resolve to the browser halves.
prime();
const { createIdbFsi } = require('../src/idb/idb.js');

describe('Storage over IndexedDB', () => {
  let env = null;
  let browser = null;
  before(() => {
    env = installBrowserGlobals();
    browser = requireBrowserAll();
  });
  after(() => env.uninstall());

  it('should serve insert, get, replicate-shaped reads and a reopen', async () => {
    const factory = new IDBFactory();
    const fsi = createIdbFsi({ indexedDB: factory, name: 'app' });
    const storage = await browser.createDatabase({ path: 'store', fsi, logger: false });
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

    const reopened = await browser.createDatabase({ path: 'store', fsi, logger: false });
    assert.strictEqual(reopened.nodeId, nodeId);
    assert.deepStrictEqual(await reopened.get(id), { title: 'Final' });
    await reopened.close();
    await fsi.close();
  });
});
