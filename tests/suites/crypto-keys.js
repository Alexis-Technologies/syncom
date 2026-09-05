'use strict';

const runCryptoKeysTests = async (t, assert, cryptoMod, { getKeysBase, fsi } = {}) => {
  if (typeof getKeysBase !== 'function') {
    throw new TypeError('runCryptoKeysTests requires getKeysBase');
  }
  if (!fsi) throw new TypeError('runCryptoKeysTests requires the fsi half the crypto module writes through');

  await t.test('generateKeys function', async () => {
    const keys = await Promise.resolve(cryptoMod.generateKeys());
    assert.strictEqual(typeof keys.publicKey, 'string');
    assert.strictEqual(typeof keys.privateKey, 'string');
    assert.ok(keys.publicKey.includes('-----BEGIN PUBLIC KEY-----'));
    assert.ok(keys.privateKey.includes('-----BEGIN PRIVATE KEY-----'));
  });

  await t.test('encrypt and decrypt functions', async () => {
    const keys = await Promise.resolve(cryptoMod.generateKeys());
    const testData = { message: 'Hello, World!', number: 42 };

    const encrypted = await Promise.resolve(cryptoMod.encrypt(testData, keys.publicKey));
    assert.strictEqual(typeof encrypted, 'string');
    assert.notStrictEqual(encrypted, JSON.stringify(testData));

    const decrypted = await Promise.resolve(cryptoMod.decrypt(encrypted, keys.privateKey));
    assert.deepStrictEqual(decrypted, testData);
  });

  await t.test('encrypt handles payloads far beyond the RSA ceiling, with a fresh key each time', async () => {
    const keys = await Promise.resolve(cryptoMod.generateKeys());
    const big = { blob: 'x'.repeat(200_000), items: Array.from({ length: 1000 }, (_, i) => ({ i })) };
    const a = await Promise.resolve(cryptoMod.encrypt(big, keys.publicKey));
    const b = await Promise.resolve(cryptoMod.encrypt(big, keys.publicKey));
    assert.notStrictEqual(a, b, 'a random data key and iv per call');
    assert.deepStrictEqual(await Promise.resolve(cryptoMod.decrypt(a, keys.privateKey)), big);
    const envelope = JSON.parse(a);
    assert.strictEqual(envelope.alg, 'RSA-OAEP-256+A256GCM');
    // Tampering with the body fails the GCM tag rather than yielding garbage.
    envelope.data = envelope.data.slice(0, -4) + 'AAAA';
    // `async` so a synchronous throw (the node half) becomes a rejection too.
    await assert.rejects(async () => cryptoMod.decrypt(JSON.stringify(envelope), keys.privateKey));
    await assert.rejects(async () => cryptoMod.decrypt(JSON.stringify({ v: 9 }), keys.privateKey), /envelope/);
  });

  await t.test('loadKeys function', async (t2) => {
    const base = await getKeysBase(t2);
    const keys1 = await Promise.resolve(cryptoMod.loadKeys(base));
    assert.strictEqual(typeof keys1.publicKey, 'string');
    assert.strictEqual(typeof keys1.privateKey, 'string');

    const keys2 = await Promise.resolve(cryptoMod.loadKeys(base));
    assert.strictEqual(keys2.publicKey, keys1.publicKey);
    assert.strictEqual(keys2.privateKey, keys1.privateKey);
  });

  await t.test('loadKeys regenerates a pair missing its private half', async (t2) => {
    const base = await getKeysBase(t2);
    const keys1 = await Promise.resolve(cryptoMod.loadKeys(base));
    await fsi.remove(base, 'private.pem');

    const keys2 = await Promise.resolve(cryptoMod.loadKeys(base));
    assert.strictEqual(typeof keys2.privateKey, 'string');
    // A fresh pair, not the orphaned public key with no private key behind it.
    assert.notStrictEqual(keys2.publicKey, keys1.publicKey);
    assert.strictEqual(await fsi.exists(base, 'private.pem'), true);
  });
};

module.exports = { runCryptoKeysTests };
