'use strict';

// Encryption as blocks: the sealing of records needs `@alexify/syncom/encryption`
// registered (PLUGIN_MISSING otherwise), and `atRest()` wraps a backend so
// that every file a storage writes through it is ciphertext under one key.

const test = require('node:test');
const assert = require('node:assert');
const core = require('../index.js');
const { encryption, atRest } = require('../src/encryption/encryption.js');
const { runFsiTests } = require('./suites/fsi.js');
const { memory } = require('../src/memory/memory.js');

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 1);
const OTHER = new Uint8Array(32).fill(9);

test('encryption as blocks', async (t) => {
  await t.test('an encrypted write without the plugin is PLUGIN_MISSING, at open() and per call', async (t2) => {
    const fsi = memory();
    await assert.rejects(() => core.open({ path: 'asked', fsi, logger: false, encrypted: true }), {
      name: 'TypeError',
      code: 'PLUGIN_MISSING',
      message:
        "open({ encrypted: true }) needs the encryption plugin: open({ plugins: [encryption] }) from '@alexify/syncom/encryption'",
    });
    const plain = await core.open({ path: 'plain', fsi, logger: false });
    t2.after(() => plain.close().catch(() => {}));
    await assert.rejects(() => plain.insert({ a: 1 }, { encrypted: true }), {
      name: 'TypeError',
      code: 'PLUGIN_MISSING',
    });
    assert.deepStrictEqual(await plain.list(), []);
    assert.strictEqual(await fsi.exists('plain/keys', 'public.pem'), false, 'no RSA pair without the plugin');
    // With it: sealed for this node's pair, outside the log, as before.
    const sealed = await core.open({ path: 'sealed', fsi, logger: false, plugins: [encryption], encrypted: true });
    t2.after(() => sealed.close().catch(() => {}));
    const ops = [];
    sealed.on('change', (op) => ops.push(op));
    const id = await sealed.insert({ secret: 'x' });
    const file = JSON.parse(await fsi.read('sealed/data', `${id}.json`));
    assert.strictEqual(file.encrypted, true);
    assert.ok(!JSON.stringify(file).includes('secret'));
    assert.deepStrictEqual(await sealed.get(id), { secret: 'x' });
    assert.deepStrictEqual(ops, []);
    assert.strictEqual(await fsi.exists('sealed/keys', 'public.pem'), true);
  });

  await t.test(
    'atRest: every file through the wrapper is enc1: ciphertext, nothing plain in the backend, and the key reads it back',
    async () => {
      const raw = memory();
      const storage = await core.open({ path: 's', fsi: atRest(raw, { key: KEY }), logger: false });
      const id = await storage.insert({ title: 'Secret' });
      await storage.close();
      const files = raw.dump();
      assert.ok(Object.keys(files).length >= 3, 'node.json, the log, the record');
      for (const [name, content] of Object.entries(files)) {
        assert.ok(content.startsWith('enc1:'), name);
        assert.ok(!content.includes('Secret') && !content.includes(storage.nodeId), name);
      }
      const again = await core.open({ path: 's', fsi: atRest(raw, { key: KEY }), logger: false });
      assert.deepStrictEqual(await again.get(id), { title: 'Secret' });
      assert.strictEqual(again.nodeId, storage.nodeId);
      await again.close();
      // The wrong key does not open the directory: its first file is refused.
      const error = await core.open({ path: 's', fsi: atRest(raw, { key: OTHER }), logger: false }).catch((e) => e);
      assert.ok(error.code === 'DECRYPT_FAILED' || error.cause?.code === 'DECRYPT_FAILED', error.message);
      // Derived from a password: the same salt gives the same key.
      const pw = { password: 'correct horse', salt: 'a salt the app keeps', iterations: 1000 };
      const derived = await core.open({ path: 'p', fsi: atRest(raw, pw), logger: false });
      const other = await derived.insert({ n: 1 });
      await derived.close();
      const reopened = await core.open({ path: 'p', fsi: atRest(raw, pw), logger: false });
      assert.deepStrictEqual(await reopened.get(other), { n: 1 });
      await reopened.close();
    },
  );

  await t.test('the wrong key, a plain file and a torn one are DECRYPT_FAILED, each with its reason', async () => {
    const raw = memory();
    const mine = atRest(raw, { key: KEY });
    const theirs = atRest(raw, { key: OTHER });
    await mine.write('d', 'f.json', '{"a":1}');
    await mine.write('d', 'g.json', '{"a":1}');
    assert.strictEqual(await mine.read('d', 'f.json'), '{"a":1}');
    assert.notStrictEqual(await raw.read('d', 'f.json'), await raw.read('d', 'g.json'), 'a fresh iv every write');
    await assert.rejects(() => theirs.read('d', 'f.json'), {
      name: 'SyncomError',
      code: 'DECRYPT_FAILED',
      reason: 'key',
      path: 'd/f.json',
      message: 'd/f.json: cannot be decrypted (the wrong key, or a torn file)',
    });
    await raw.write('d', 'plain.json', '{}');
    await assert.rejects(() => mine.read('d', 'plain.json'), {
      code: 'DECRYPT_FAILED',
      reason: 'plain',
      message: 'd/plain.json: not encrypted',
    });
    await raw.write('d', 'torn.json', 'enc1:###');
    await assert.rejects(() => mine.read('d', 'torn.json'), { code: 'DECRYPT_FAILED', reason: 'torn' });
    await raw.write('d', 'short.json', `enc1:${btoa('abc')}`);
    await assert.rejects(() => mine.read('d', 'short.json'), { code: 'DECRYPT_FAILED', reason: 'key' });
    // exists, remove and list pass through; create seals like write.
    assert.strictEqual(await mine.exists('d', 'plain.json'), true);
    await mine.remove('d', 'plain.json');
    assert.strictEqual(await raw.exists('d', 'plain.json'), false);
    assert.deepStrictEqual((await mine.list('d')).sort(), ['f.json', 'g.json', 'short.json', 'torn.json']);
    await mine.create('d', 'made.json', '1');
    assert.ok((await raw.read('d', 'made.json')).startsWith('enc1:'));
    assert.strictEqual(await mine.read('d', 'made.json'), '1');
    await assert.rejects(() => mine.create('d', 'made.json', '2'), { code: 'EEXIST' });
  });

  await t.test('the options are checked when the wrapper is made', () => {
    const raw = memory();
    assert.throws(() => atRest({}, { key: KEY }), { message: 'atRest(): adapter has no read()' });
    assert.throws(() => atRest(raw), {
      name: 'TypeError',
      message: 'atRest(): give a key (32 bytes) or a password with a salt',
    });
    assert.throws(() => atRest(raw, null), { name: 'TypeError', message: 'atRest() takes an options object' });
    assert.throws(() => atRest(raw, { key: new Uint8Array(16) }), { message: /32 bytes/ });
    assert.throws(() => atRest(raw, { key: 'secret' }), { message: /32 bytes/ });
    assert.throws(() => atRest(raw, { password: '' }), { message: /a key \(32 bytes\) or a password/ });
    assert.throws(() => atRest(raw, { password: 'pw' }), { message: /salt of 8 characters or more/ });
    assert.throws(() => atRest(raw, { password: 'pw', salt: 'short' }), { message: /salt of 8 characters or more/ });
    assert.throws(() => atRest(raw, { password: 'pw', salt: 'long enough', iterations: 10 }), {
      message: /1000 or more/,
    });
    assert.doesNotThrow(() => atRest(raw, { key: KEY }));
  });

  // The backend contract holds through the wrapper.
  let n = 0;
  await runFsiTests(t, atRest(memory(), { key: KEY }), {
    getRoot: async () => `enc-${n++}`,
    joinPath: (root, ...parts) => [root, ...parts].join('/'),
  });
});
