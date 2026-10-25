'use strict';

// Ciphertext and keys are portable between the two halves: a record sealed
// by the browser half (Web Crypto) opens with node:crypto and vice versa,
// with either half's PEM key pair.

const test = require('node:test');
const assert = require('node:assert');
const { installBrowserGlobals } = require('./utils/browser-env.js');
const { createMemoryFsi } = require('../src/backend.js');
const node = { ...require('../src/encryption/rsa.js'), ...require('../src/signing/ed25519.js') };

test('crypto halves interoperate', async (t) => {
  const env = installBrowserGlobals();
  t.after(() => env.uninstall());
  const browser = { ...require('../src/encryption/rsa.browser.js'), ...require('../src/signing/ed25519.browser.js') };
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

  await t.test('a signature made on one half verifies on the other, with either half’s keys', async () => {
    const message = JSON.stringify([1, 'origin', 3, 'add', 'r', null, 'digest']);
    for (const [label, keys] of [
      ['node keys', await node.generateSigningKeys()],
      ['browser keys', await browser.generateSigningKeys()],
    ]) {
      const fromNode = node.sign(message, keys.privateKey);
      const fromBrowser = await browser.sign(message, keys.privateKey);
      assert.strictEqual(fromNode, fromBrowser, `${label}: Ed25519 is deterministic`);
      assert.strictEqual(await browser.verify(message, fromNode, keys.id), true);
      assert.strictEqual(node.verify(message, fromBrowser, keys.id), true);
      assert.strictEqual(node.verify(`${message}x`, fromBrowser, keys.id), false);
      assert.strictEqual(await browser.verify(`${message}x`, fromNode, keys.id), false);
    }
  });

  await t.test('both halves derive one id from one signing pair on disk', async () => {
    const fsi = createMemoryFsi();
    const fromNode = await node.loadSigningKeys('keys', { fsi });
    const fromBrowser = await browser.loadSigningKeys('keys', { fsi });
    assert.deepStrictEqual(fromBrowser, fromNode);
  });

  await t.test('url-safe PEMs from the earlier browser half still import', async () => {
    const keys = await browser.generateKeys();
    const urlSafe = (pem) => pem.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const sealed = await browser.encrypt(payload, urlSafe(keys.publicKey));
    assert.deepStrictEqual(await browser.decrypt(sealed, urlSafe(keys.privateKey)), payload);
  });
});
