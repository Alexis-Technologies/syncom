'use strict';

// Exclusive open in the browser: the Web Locks API where there is one, the
// lockfile in OPFS otherwise — without a pid, so staleness is by age.

const test = require('node:test');
const assert = require('node:assert');
const { installBrowserGlobals, requireBrowserBarrel, installMockLocks } = require('./utils/browser-env.js');

test('Exclusive open (browser halves)', async (t) => {
  const env = installBrowserGlobals();
  t.after(() => env.uninstall());
  const browser = requireBrowserBarrel();

  await t.test('without Web Locks: a lockfile in OPFS, held while the storage is open', async () => {
    const first = await browser.open({ path: 'locked', logger: false });
    assert.strictEqual(await browser.exists('locked', 'lock.json'), true);
    await assert.rejects(() => browser.open({ path: 'locked', logger: false }), { code: 'LOCKED' });
    await first.close();
    assert.strictEqual(await browser.exists('locked', 'lock.json'), false);
    const second = await browser.open({ path: 'locked', logger: false });
    await second.close();
  });

  await t.test("with Web Locks: 'fail' is refused at once, 'wait' waits, close() releases", async (t2) => {
    const locks = installMockLocks();
    t2.after(() => locks.uninstall());
    const first = await browser.open({ path: 'web', logger: false });
    assert.deepStrictEqual(globalThis.navigator.locks.held(), ['syncom:web']);
    assert.strictEqual(await browser.exists('web', 'lock.json'), false, 'no lockfile with Web Locks');
    await assert.rejects(() => browser.open({ path: 'web', logger: false }), { code: 'LOCKED' });
    let resolved = false;
    const waiting = browser.open({ path: 'web', logger: false, lock: 'wait' }).then((s) => {
      resolved = true;
      return s;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(resolved, false);
    await first.close();
    const second = await waiting;
    assert.deepStrictEqual(globalThis.navigator.locks.held(), ['syncom:web']);
    await second.close();
    assert.deepStrictEqual(globalThis.navigator.locks.held(), []);
    // A failing open lets the Web Lock go too.
    const failing = {
      ...browser,
      read: async (d, n) => (n === 'node.json' ? Promise.reject(new Error('nope')) : browser.read(d, n)),
    };
    const fsi = {
      read: failing.read,
      write: browser.write,
      exists: browser.exists,
      remove: browser.remove,
      list: browser.list,
    };
    await assert.rejects(() => browser.open({ path: 'web', logger: false, fsi }), /nope/);
    assert.deepStrictEqual(globalThis.navigator.locks.held(), []);
  });
});
