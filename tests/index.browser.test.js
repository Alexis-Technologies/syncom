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
    // The fsi half is the one split the root still has (the crypto halves
    // are the signing and encryption subpaths'): OPFS here, node:fs there.
    assert.notStrictEqual(browser.read, node.read);
    assert.strictEqual(browser.read, require('../src/fsi.browser.js').read);
    assert.strictEqual(node.read, require('../src/fsi.js').read);
  });

  await t.test('the crdt half is shared, not duplicated; contracts are a subpath, not here', () => {
    assert.strictEqual(browser.diff, node.diff);
    assert.strictEqual(browser.merge, node.merge);
    assert.strictEqual(browser.apply, node.apply);
    assert.strictEqual('SmartContract' in browser, false);
    assert.strictEqual('DataReader' in node, false);
  });

  await t.test('the log and the apply path are shared: one engine over fsi in both halves', () => {
    assert.strictEqual(browser.OpLog, node.OpLog);
    assert.strictEqual(browser.applyOp, node.applyOp);
    assert.strictEqual(browser.outbound, node.outbound);
  });
});
