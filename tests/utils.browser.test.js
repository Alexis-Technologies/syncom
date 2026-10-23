'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { webcrypto } = require('node:crypto');
const { runEmitterTests } = require('./suites/emitter.js');

test('utils.browser module', async (t) => {
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

  const utils = require('../src/utils.browser.js');

  await t.test('Emitter matches the node half', async (t2) => {
    await runEmitterTests(t2, assert, utils.Emitter);
  });

  await t.test('generateUUID delegates to the Web Crypto API', () => {
    const id = utils.generateUUID();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notStrictEqual(id, utils.generateUUID());
  });

  await t.test('no filesystem predicates are exported', () => {
    assert.strictEqual(utils.fileExists, undefined);
    assert.strictEqual(utils.directoryExists, undefined);
  });
});
