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

  await t.test('generateSigningKeys: an Ed25519 pair whose id is the raw public key', async () => {
    const keys = await Promise.resolve(cryptoMod.generateSigningKeys());
    assert.ok(keys.publicKey.includes('-----BEGIN PUBLIC KEY-----'));
    assert.ok(keys.privateKey.includes('-----BEGIN PRIVATE KEY-----'));
    assert.match(keys.id, /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/, '32 bytes, base64url, a canonical last character');
    const again = await Promise.resolve(cryptoMod.generateSigningKeys());
    assert.notStrictEqual(again.id, keys.id);
  });

  await t.test('sign and verify: a signature checks against the id, and nothing else passes', async () => {
    const keys = await Promise.resolve(cryptoMod.generateSigningKeys());
    const other = await Promise.resolve(cryptoMod.generateSigningKeys());
    const message = JSON.stringify([1, 'A', 7, 'write', 'r', 'ünïcödé — 日本']);
    const signature = await Promise.resolve(cryptoMod.sign(message, keys.privateKey));
    assert.match(signature, /^[A-Za-z0-9_-]{86}$/, '64 bytes, base64url');
    assert.strictEqual(await Promise.resolve(cryptoMod.sign(message, keys.privateKey)), signature, 'deterministic');
    assert.strictEqual(await Promise.resolve(cryptoMod.verify(message, signature, keys.id)), true);
    assert.strictEqual(await Promise.resolve(cryptoMod.verify(`${message} `, signature, keys.id)), false);
    assert.strictEqual(await Promise.resolve(cryptoMod.verify(message, signature, other.id)), false);
    const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    assert.strictEqual(await Promise.resolve(cryptoMod.verify(message, flipped, keys.id)), false);
    // Malformed input is false, never a throw: it is a peer's claim.
    const junk = [
      [signature, 'n1'],
      [signature, 'A'.repeat(43)],
      [signature, 42],
      [signature, ''],
      ['short', keys.id],
      [null, keys.id],
      [`${signature}AA`, keys.id],
    ];
    for (const [sig, id] of junk) {
      assert.strictEqual(await Promise.resolve(cryptoMod.verify(message, sig, id)), false, `${sig}/${id}`);
    }
  });

  await t.test("verifyAsync, the engine's verify: the same answers, as a promise, many at once", async () => {
    const keys = await Promise.resolve(cryptoMod.generateSigningKeys());
    const other = await Promise.resolve(cryptoMod.generateSigningKeys());
    const message = JSON.stringify([1, 'A', 7, 'write', 'r', 'ünïcödé']);
    const signature = await Promise.resolve(cryptoMod.sign(message, keys.privateKey));
    const pending = cryptoMod.verifyAsync(message, signature, keys.id);
    assert.ok(pending instanceof Promise, 'a promise on both halves');
    assert.strictEqual(await pending, true);
    const cases = [
      [`${message} `, signature, keys.id],
      [message, signature, other.id],
      [message, signature, 'n1'],
      [message, signature, 'A'.repeat(43)],
      [message, signature, 42],
      [message, 'short', keys.id],
      [message, null, keys.id],
      [42, signature, keys.id],
    ];
    for (const [text, sig, id] of cases) {
      assert.strictEqual(await cryptoMod.verifyAsync(text, sig, id), false, `${String(sig).slice(0, 8)}/${id}`);
      assert.strictEqual(await Promise.resolve(cryptoMod.verify(text, sig, id)), false, 'and verify agrees');
    }
    // A page's worth at once, half of them forged: every verdict is its own.
    const checks = [];
    for (let i = 0; i < 64; i++) {
      checks.push(cryptoMod.verifyAsync(i % 2 ? `${message}${i}` : message, signature, keys.id));
    }
    const verdicts = await Promise.all(checks);
    assert.deepStrictEqual(
      verdicts,
      verdicts.map((_, i) => i % 2 === 0),
    );
  });

  await t.test('loadSigningKeys: sign-public.pem and sign-private.pem, a pair of its own', async (t2) => {
    const base = await getKeysBase(t2);
    const keys1 = await Promise.resolve(cryptoMod.loadSigningKeys(base));
    assert.match(keys1.id, /^[A-Za-z0-9_-]{43}$/);
    assert.strictEqual(await fsi.exists(base, 'sign-public.pem'), true);
    assert.strictEqual(await fsi.exists(base, 'sign-private.pem'), true);
    const keys2 = await Promise.resolve(cryptoMod.loadSigningKeys(base));
    assert.deepStrictEqual(keys2, keys1, 'stable across loads');
    const rsa = await Promise.resolve(cryptoMod.loadKeys(base));
    assert.notStrictEqual(rsa.publicKey, keys1.publicKey, 'the RSA pair is another pair');
    // Each pair is refused as half a pair on its own; the other is untouched.
    await fsi.remove(base, 'sign-private.pem');
    await assert.rejects(() => Promise.resolve(cryptoMod.loadSigningKeys(base)), {
      code: 'KEYS_INCOMPLETE',
      message: /sign-private\.pem is missing/,
    });
    assert.deepStrictEqual(await Promise.resolve(cryptoMod.loadKeys(base)), rsa);
    await fsi.remove(base, 'sign-public.pem');
    await fsi.write(base, 'sign-private.pem', keys1.privateKey);
    await assert.rejects(() => Promise.resolve(cryptoMod.loadSigningKeys(base)), /sign-public\.pem is missing/);
    await fsi.remove(base, 'private.pem');
    await assert.rejects(() => Promise.resolve(cryptoMod.loadKeys(base)), { code: 'KEYS_INCOMPLETE' });
  });

  await t.test('loadKeys refuses half a pair instead of minting a new one', async (t2) => {
    const base = await getKeysBase(t2);
    const keys1 = await Promise.resolve(cryptoMod.loadKeys(base));
    await fsi.remove(base, 'private.pem');
    // Without private.pem every sealed record is already unreadable; a fresh
    // pair would hide that behind ciphertext that decrypts to nothing.
    await assert.rejects(() => Promise.resolve(cryptoMod.loadKeys(base)), {
      code: 'KEYS_INCOMPLETE',
      message: /private\.pem is missing/,
    });
    assert.strictEqual(await fsi.exists(base, 'private.pem'), false, 'nothing was written');
    assert.strictEqual(await fsi.read(base, 'public.pem'), keys1.publicKey, 'the orphan is left for the operator');
    await fsi.remove(base, 'public.pem');
    await fsi.write(base, 'private.pem', keys1.privateKey);
    await assert.rejects(() => Promise.resolve(cryptoMod.loadKeys(base)), { code: 'KEYS_INCOMPLETE' });
  });
};

module.exports = { runCryptoKeysTests };
