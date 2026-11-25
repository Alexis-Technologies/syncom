'use strict';

const { describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { installMockOpfs } = require('./utils/mock-opfs.js');
const { runCryptoKeysTests } = require('./suites/crypto-keys.js');
// The browser halves read `crypto`, `navigator` and `btoa` when called, never when loaded: the globals the
// hooks below install are the ones they meet.
const cryptoBrowser = {
  ...require('../src/encryption/rsa.browser.js'),
  ...require('../src/signing/ed25519.browser.js'),
};
const fsi = require('../src/fsi.browser.js');

describe('crypto.browser module', () => {
  let opfs = null;
  let prevCrypto = null;
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
  });
  after(() => opfs.uninstall());
  after(() => {
    if (prevCrypto) Object.defineProperty(globalThis, 'crypto', prevCrypto);
    else delete globalThis.crypto;
  });

  runCryptoKeysTests(assert, cryptoBrowser, {
    fsi,
    getKeysBase: async () => `keys-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
  });
});
