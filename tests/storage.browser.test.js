'use strict';

// Storage over the BROWSER halves: OPFS for files, Web Crypto for hashing and
// encryption. The shared storage.js is loaded through tests/utils/browser-env.js
// so its nested requires resolve the way package.json#browser says they would.

const test = require('node:test');
const assert = require('node:assert');
const { installBrowserGlobals, requireBrowserBarrel } = require('./utils/browser-env.js');

test('Storage on the browser halves', async (t) => {
  const env = installBrowserGlobals();
  t.after(() => env.uninstall());
  const browser = requireBrowserBarrel();

  await t.test('the shared modules see the browser crypto and fsi', async () => {
    assert.ok(browser.calculateHash({ a: 1 }) instanceof Promise);
    const storage = await browser.open({ path: 'store-basic' });
    const id = await storage.insert({ title: 'Draft', hits: 0 });
    assert.deepStrictEqual(await storage.get(id), { title: 'Draft', hits: 0 });
    assert.strictEqual(await storage.validate(), true);
    // Written to the mock OPFS, not to disk.
    assert.strictEqual(await browser.exists('store-basic/data', `${id}.json`), true);
  });

  await t.test('encryption at rest awaits the async Web Crypto', async () => {
    const storage = await browser.open({ path: 'store-encrypted' });
    const secret = { ssn: '123-45-6789' };
    await storage.saveData('s1', secret, { encrypted: true });

    // The on-disk entry holds ciphertext, not a serialized pending promise.
    const raw = JSON.parse(await browser.read('store-encrypted/data', 's1.json'));
    assert.strictEqual(raw.encrypted, true);
    assert.strictEqual(typeof raw.data, 'string');
    assert.notDeepStrictEqual(raw.data, {});

    // A cold read (fresh Storage, empty cache) decrypts it back.
    const reopened = await browser.open({ path: 'store-encrypted' });
    assert.deepStrictEqual(await reopened.get('s1'), secret);
  });
});
