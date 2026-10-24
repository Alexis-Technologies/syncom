'use strict';

// Record ids are file names on every platform and keys in every peer's
// catalog: what is refused, at which entrance, and that a refusal leaves no
// trace — against whichever storage half the caller builds.

const remoteOp = (origin, seq, type, id, extra = {}) => ({ origin, seq, ts: Date.now() + seq, type, id, ...extra });

const BAD_IDS = ['', '.', '..', '../evil', 'a/b', 'a\\b', '.hidden', 'a b', 'tab\tx', 'x'.repeat(129), 42, null];
const GOOD_IDS = [
  'a',
  'A-b_c.d@e',
  '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  '550e8400-e29b-41d4-a716-446655440000',
  'x'.repeat(128),
  '_u',
  '@h',
  '-d',
];

const runIdTests = async (t, assert, createStorage) => {
  await t.test('a local write with an invalid id is refused before anything is durable', async (t2) => {
    const storage = await createStorage(t2, 'A');
    for (const id of BAD_IDS) {
      const label = JSON.stringify(id);
      await assert.rejects(() => storage.set(id, { a: 1 }), { name: 'TypeError', code: 'INVALID_ID' }, label);
      await assert.rejects(() => storage.inc(id, 'n'), { code: 'INVALID_ID' }, label);
      await assert.rejects(() => storage.delete(id), { code: 'INVALID_ID' }, label);
      await assert.rejects(() => storage.purge(id), { code: 'INVALID_ID' }, label);
      await assert.rejects(() => storage.update(id, { a: 1 }), { name: 'TypeError', code: 'INVALID_ID' }, label);
      assert.strictEqual(await storage.get(id), null, label);
      assert.strictEqual(await storage.has(id), false, label);
    }
    assert.strictEqual(storage.log.length, 0, 'nothing was logged');
    assert.deepStrictEqual(await storage.list(), []);
    for (const id of GOOD_IDS) await storage.set(id, { a: 1 });
    assert.deepStrictEqual((await storage.list()).sort(), [...GOOD_IDS].sort());
  });

  await t.test('getId must mint a valid id', async (t2) => {
    const storage = await createStorage(t2, 'B', { getId: () => '../minted' });
    await assert.rejects(() => storage.insert({ a: 1 }), { name: 'TypeError', code: 'INVALID_ID', message: /getId/ });
    assert.strictEqual(storage.log.length, 0);
    assert.strictEqual(await storage.fsi.exists(storage.path, 'minted.json'), false);
  });

  await t.test("a peer's op or snapshot record with an invalid id is refused, and the stream goes on", async (t2) => {
    const storage = await createStorage(t2, 'C');
    const ops = [remoteOp('peer', 1, 'write', 'ok', { data: { a: 1 } })];
    let seq = 2;
    for (const id of BAD_IDS) ops.push(remoteOp('peer', seq++, 'write', id, { data: { a: 1 } }));
    const result = await storage.applyRemote(ops);
    assert.strictEqual(result.applied, 1);
    assert.strictEqual(result.malformed, BAD_IDS.length);
    assert.deepStrictEqual(storage.vector, { peer: 1 }, 'a refused op moves nothing');
    assert.deepStrictEqual(await storage.list(), ['ok']);
    assert.strictEqual(await storage.fsi.exists(storage.path, 'evil.json'), false, 'nothing escaped data/');
    const meta = { clock: { a: [1, 'peer'] }, base: null, deleted: null, counters: {} };
    await storage.mergeSnapshot(BAD_IDS.map((id) => ({ id, data: { a: 1 }, meta })));
    assert.deepStrictEqual(await storage.list(), ['ok']);
    // A reopen is unaffected: nothing of the refused ids reached the log.
    await storage.close();
    const again = await createStorage(t2, 'C');
    assert.deepStrictEqual(await again.list(), ['ok']);
    assert.deepStrictEqual(again.vector, { peer: 1 });
  });
};

module.exports = { runIdTests, BAD_IDS, GOOD_IDS };
