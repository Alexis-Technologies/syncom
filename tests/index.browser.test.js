'use strict';

// The browser barrel is what `browser.js` (and therefore every bundler that
// honours the `browser` condition) resolves to. Loading it under the OPFS +
// WebCrypto mocks proves the browser halves are wired together at all — the
// node barrel passing says nothing about this one.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { installMockOpfs } = require('./utils/mock-opfs.js');

describe('browser barrel', () => {
  let opfs = null;
  let prevCrypto = null;
  let browser = null;
  let node = null;
  before(() => {
    opfs = installMockOpfs();

    prevCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', {
      value: webcrypto,
      configurable: true,
      writable: true,
      enumerable: true,
    });

    if (typeof globalThis.btoa !== 'function') {
      globalThis.btoa = (s) => Buffer.from(s, 'latin1').toString('base64');
    }
    if (typeof globalThis.atob !== 'function') {
      globalThis.atob = (s) => Buffer.from(s, 'base64').toString('latin1');
    }

    browser = require('../src/index.browser.js');
    node = require('../src/index.js');
  });
  after(() => opfs.uninstall());
  after(() => {
    if (prevCrypto) Object.defineProperty(globalThis, 'crypto', prevCrypto);
    else delete globalThis.crypto;
  });

  it('should export the same names as the node barrel', () => {
    assert.deepStrictEqual(Object.keys(browser).sort(), Object.keys(node).sort());
  });

  it('should pick the browser half of every split module', () => {
    // The fsi half is the one split the root still has (the crypto halves
    // are the signing and encryption subpaths'): OPFS here, node:fs there.
    assert.notStrictEqual(browser.read, node.read);
    assert.strictEqual(browser.read, require('../src/fsi.browser.js').read);
    assert.strictEqual(node.read, require('../src/fsi.js').read);
    // The backend whole: node:fs with its three optional functions, OPFS with none of them.
    assert.deepStrictEqual(Object.keys(node.defaultFsi), Object.keys(require('../src/fsi.js')));
    assert.deepStrictEqual(Object.keys(browser.defaultFsi), Object.keys(require('../src/fsi.browser.js')));
    assert.strictEqual(browser.defaultFsi.read, browser.read);
    assert.strictEqual(browser.defaultFsi.sync, undefined);
    assert.strictEqual(typeof node.defaultFsi.sync, 'function');
  });

  it('should share the crdt half, not duplicate it; contracts are a subpath, not here', () => {
    assert.strictEqual(browser.diff, node.diff);
    assert.strictEqual(browser.merge, node.merge);
    assert.strictEqual(browser.apply, node.apply);
    assert.strictEqual('SmartContract' in browser, false);
    assert.strictEqual('DataReader' in node, false);
  });

  it('should share the log and the apply path: one engine over fsi in both halves', () => {
    assert.strictEqual(browser.OpLog, node.OpLog);
    assert.strictEqual(browser.applyOp, node.applyOp);
    assert.strictEqual(browser.outbound, node.outbound);
  });
});
