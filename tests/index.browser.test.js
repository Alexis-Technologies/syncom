'use strict';

// The browser barrel is what `browser.js` (and therefore every bundler that
// honours the `browser` condition) resolves to. Loading it under the OPFS +
// WebCrypto mocks proves the browser halves are wired together at all — the
// node barrel passing says nothing about this one.

const test = require('node:test');
const assert = require('node:assert');
const { webcrypto } = require('node:crypto');
const { installMockOpfs } = require('./utils/mock-opfs.js');

test('browser barrel', async (t) => {
  const opfs = installMockOpfs();
  t.after(() => opfs.uninstall());

  const prevCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: true,
    enumerable: true,
  });
  t.after(() => {
    if (prevCrypto) Object.defineProperty(globalThis, 'crypto', prevCrypto);
    else delete globalThis.crypto;
  });

  if (typeof globalThis.btoa !== 'function') {
    globalThis.btoa = (s) => Buffer.from(s, 'latin1').toString('base64');
  }
  if (typeof globalThis.atob !== 'function') {
    globalThis.atob = (s) => Buffer.from(s, 'base64').toString('latin1');
  }

  const browser = require('../src/index.browser.js');
  const node = require('../src/index.js');

  await t.test('exports the same names as the node barrel', () => {
    assert.deepStrictEqual(Object.keys(browser).sort(), Object.keys(node).sort());
  });

  await t.test('picks the browser half of every split module', () => {
    // The node calculateHash is synchronous; the WebCrypto one returns a
    // promise. That difference is the cheapest proof the swap happened.
    const hash = browser.calculateHash({ a: 1 });
    assert.ok(hash instanceof Promise);
    return hash.then((value) => assert.match(value, /^[0-9a-f]{64}$/));
  });

  await t.test('the crdt half is shared, not duplicated; contracts are a subpath, not here', () => {
    assert.strictEqual(browser.diff, node.diff);
    assert.strictEqual(browser.merge, node.merge);
    assert.strictEqual(browser.apply, node.apply);
    assert.strictEqual('SmartContract' in browser, false);
    assert.strictEqual('DataReader' in node, false);
  });

  await t.test('SyncManager is shared: one registry over fsi in both halves', () => {
    assert.strictEqual(browser.SyncManager, node.SyncManager);
    assert.strictEqual(browser.OpLog, node.OpLog);
  });
});
