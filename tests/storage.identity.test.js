'use strict';

// The node id is the signing key: minted with the pair, derived from it on
// every open, named in node.json for the operator — rekeyed once from a UUID
// of a directory older than signing, refused when the file names another key.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const syncom = require('../src/all/all.js');
const { loadSigningKeys, generateSigningKeys } = require('../src/signing/ed25519.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');

const KEY_ID = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const quiet = { warn() {}, info() {}, debug() {}, error() {} };

test('Storage identity', async (t) => {
  await t.test(
    'a fresh directory: the id is the Ed25519 public key, named in node.json, kept on reopen',
    async (t2) => {
      const dir = await createTemp();
      t2.after(() => cleanupTemp(dir));
      const storage = await syncom.open({ path: dir, logger: false });
      const { nodeId } = storage;
      assert.match(nodeId, KEY_ID);
      assert.strictEqual(nodeId, (await loadSigningKeys(path.join(dir, 'keys'))).id);
      assert.deepStrictEqual(JSON.parse(await fs.readFile(path.join(dir, 'node.json'), 'utf8')), {
        id: nodeId,
        plugins: ['text', 'tree'],
      });
      for (const file of ['public.pem', 'private.pem', 'sign-public.pem', 'sign-private.pem']) {
        await fs.stat(path.join(dir, 'keys', file));
      }
      const id = await storage.insert({ a: 1 });
      await storage.close();
      const reopened = await syncom.open({ path: dir, logger: false });
      assert.strictEqual(reopened.nodeId, nodeId);
      assert.deepStrictEqual(reopened.vector, { [nodeId]: 1 });
      assert.deepStrictEqual(await reopened.get(id), { a: 1 });
      await reopened.close();
    },
  );

  await t.test('two directories are two ids', async (t2) => {
    const a = await createTemp();
    const b = await createTemp();
    t2.after(() => Promise.all([cleanupTemp(a), cleanupTemp(b)]));
    const first = await syncom.open({ path: a, logger: false });
    const second = await syncom.open({ path: b, logger: false });
    assert.notStrictEqual(first.nodeId, second.nodeId);
    await first.close();
    await second.close();
  });

  await t.test('a directory from before signing: the UUID in node.json is rekeyed once, with a warning', async (t2) => {
    const dir = await createTemp();
    t2.after(() => cleanupTemp(dir));
    await fs.writeFile(path.join(dir, 'node.json'), JSON.stringify({ id: 'legacy-uuid-1234' }));
    const warnings = [];
    const logger = { ...quiet, warn: (entry) => warnings.push(entry) };
    const storage = await syncom.open({ path: dir, logger });
    assert.match(storage.nodeId, KEY_ID);
    assert.deepStrictEqual(
      warnings.map((entry) => [entry.event, entry.from, entry.to]),
      [['identity.rekeyed', 'legacy-uuid-1234', storage.nodeId]],
    );
    assert.deepStrictEqual(JSON.parse(await fs.readFile(path.join(dir, 'node.json'), 'utf8')), {
      id: storage.nodeId,
      plugins: ['text', 'tree'],
    });
    await storage.close();
    // Once: a reopen is quiet.
    const again = await syncom.open({ path: dir, logger });
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(again.nodeId, storage.nodeId);
    await again.close();
  });

  await t.test('node.json naming another signing key is refused: IDENTITY_MISMATCH', async (t2) => {
    const dir = await createTemp();
    t2.after(() => cleanupTemp(dir));
    const first = await syncom.open({ path: dir, logger: false });
    const { nodeId } = first;
    await first.close();
    const other = await generateSigningKeys();
    await fs.writeFile(path.join(dir, 'node.json'), JSON.stringify({ id: other.id }));
    await assert.rejects(() => syncom.open({ path: dir, logger: false }), {
      name: 'SyncomError',
      code: 'IDENTITY_MISMATCH',
      id: other.id,
      key: nodeId,
      message: /node\.json names node .* but keys\/sign-public\.pem is/,
    });
    // The failed open released the lock; the file put right, the node is back.
    await fs.writeFile(path.join(dir, 'node.json'), JSON.stringify({ id: nodeId }));
    const back = await syncom.open({ path: dir, logger: false });
    assert.strictEqual(back.nodeId, nodeId);
    await back.close();
  });
});
