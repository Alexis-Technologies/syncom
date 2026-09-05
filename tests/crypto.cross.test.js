'use strict';

// Ciphertext and keys are portable between the two halves: a record sealed
// by the browser half (Web Crypto) opens with node:crypto and vice versa,
// with either half's PEM key pair.

const test = require('node:test');
const assert = require('node:assert');
const { installBrowserGlobals } = require('./utils/browser-env.js');
const node = require('../src/crypto.js');

test('crypto halves interoperate', async (t) => {
  const env = installBrowserGlobals();
  t.after(() => env.uninstall());
  const browser = require('../src/crypto.browser.js');
  const payload = { secret: 'both ways', n: 42, nested: { list: [1, 2, 3] }, long: 'y'.repeat(5000) };

  for (const [label, keys] of [
    ['node keys', await node.generateKeys()],
    ['browser keys', await browser.generateKeys()],
  ]) {
    await t.test(`${label}: browser encrypts, node decrypts, and back`, async () => {
      const fromBrowser = await browser.encrypt(payload, keys.publicKey);
      assert.deepStrictEqual(node.decrypt(fromBrowser, keys.privateKey), payload);
      const fromNode = node.encrypt(payload, keys.publicKey);
      assert.deepStrictEqual(await browser.decrypt(fromNode, keys.privateKey), payload);
      assert.strictEqual(await browser.calculateHash(payload), node.calculateHash(payload));
    });
  }

  await t.test('url-safe PEMs from the earlier browser half still import', async () => {
    const keys = await browser.generateKeys();
    const urlSafe = (pem) => pem.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const sealed = await browser.encrypt(payload, urlSafe(keys.publicKey));
    assert.deepStrictEqual(await browser.decrypt(sealed, urlSafe(keys.privateKey)), payload);
  });
});
