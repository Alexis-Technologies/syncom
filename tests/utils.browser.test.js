'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { runEmitterTests } = require('./suites/emitter.js');
// The browser half reads `crypto` when called, never when loaded: the global the hook below installs is the one
// generateUUID meets.
const utils = require('../src/utils.browser.js');

describe('utils.browser module', () => {
  let prevCrypto = null;
  before(() => {
    prevCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', {
      value: webcrypto,
      configurable: true,
      writable: true,
      enumerable: true,
    });
  });
  after(() => {
    if (prevCrypto) Object.defineProperty(globalThis, 'crypto', prevCrypto);
    else delete globalThis.crypto;
  });

  describe('Emitter (the same contract as the node half)', () => runEmitterTests(assert, utils.Emitter));

  it('should delegate generateUUID to the Web Crypto API', () => {
    const id = utils.generateUUID();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notStrictEqual(id, utils.generateUUID());
  });

  it('should export no filesystem predicates', () => {
    assert.strictEqual(utils.fileExists, undefined);
    assert.strictEqual(utils.directoryExists, undefined);
  });
});
