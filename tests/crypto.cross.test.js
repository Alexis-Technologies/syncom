'use strict';

// Ciphertext and keys are portable between the two halves: a record sealed
// by the browser half (Web Crypto) opens with node:crypto and vice versa,
// with either half's PEM key pair.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { installBrowserGlobals } = require('./utils/browser-env.js');
const { memory } = require('../src/memory/memory.js');
const node = { ...require('../src/encryption/rsa.js'), ...require('../src/signing/ed25519.js') };

describe('crypto halves interoperate', () => {
  let env = null;
  let browser = null;
  const payload = { secret: 'both ways', n: 42, nested: { list: [1, 2, 3] }, long: 'y'.repeat(5000) };
  // One RSA pair minted by each half, before the tests that use them.
  const pairs = new Map();
  before(async () => {
    env = installBrowserGlobals();
    browser = { ...require('../src/encryption/rsa.browser.js'), ...require('../src/signing/ed25519.browser.js') };
    pairs.set('node keys', await node.generateKeys());
    pairs.set('browser keys', await browser.generateKeys());
  });
  after(() => env.uninstall());

  for (const label of ['node keys', 'browser keys']) {
    it(`should let the browser encrypt and node decrypt, and back, with ${label}`, async () => {
      const keys = pairs.get(label);
      const fromBrowser = await browser.encrypt(payload, keys.publicKey);
      assert.deepStrictEqual(node.decrypt(fromBrowser, keys.privateKey), payload);
      const fromNode = node.encrypt(payload, keys.publicKey);
      assert.deepStrictEqual(await browser.decrypt(fromNode, keys.privateKey), payload);
      assert.strictEqual(await browser.calculateHash(payload), node.calculateHash(payload));
    });
  }

  it('should verify on one half a signature made on the other, with either half’s keys', async () => {
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

  it('should derive one id on both halves from one signing pair on disk', async () => {
    const fsi = memory();
    const fromNode = await node.loadSigningKeys('keys', { fsi });
    const fromBrowser = await browser.loadSigningKeys('keys', { fsi });
    assert.deepStrictEqual(fromBrowser, fromNode);
  });

  it('should still import url-safe PEMs from the earlier browser half', async () => {
    const keys = await browser.generateKeys();
    const urlSafe = (pem) => pem.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const sealed = await browser.encrypt(payload, urlSafe(keys.publicKey));
    assert.deepStrictEqual(await browser.decrypt(sealed, urlSafe(keys.privateKey)), payload);
  });
});
