'use strict';

// Sealed (encrypted) records in queries: read whole at the key holder and
// matched like the rest — no index knows them, so they join the candidates
// and nothing is covered or decided by an index while a collection holds one.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { waitUntil } = require('./utils/mesh.js');

const ns = (rows) => rows.map((row) => row.n).sort((a, b) => a - b);

test('Sealed records in queries', async (t) => {
  const open = async (t2, name) => {
    const db = await syncom.createDatabase({
      engine: syncom.memoryEngine(),
      path: `${t2.name}/${name}`,
      logger: false,
      defer: 0,
      schema: { entities: { Note: { index: ['tag'] } } },
    });
    t2.after(() => db.close().catch(() => {}));
    return db;
  };

  await t.test(
    'a query reads the collection’s sealed records whole at the key holder and matches them like the rest: every filter, order, window and count',
    async (t2) => {
      const db = await open(t2, 'A');
      const p1 = await db.insert({ $type: 'Note', tag: 'a', n: 1 });
      await db.insert({ $type: 'Note', tag: 'b', n: 2 });
      const s3 = await db.insert({ $type: 'Note', tag: 'a', n: 3 }, { encrypted: true });
      const s4 = await db.insert({ $type: 'Note', tag: 'c', n: 4 }, { encrypted: true });
      assert.strictEqual((await db.get(s3)).n, 3, 'the key holder reads a sealed record');
      // Everything, an indexed equality, an unindexed range: the sealed rows are in each.
      assert.deepStrictEqual(ns(await db.Note.select({}).fetch()), [1, 2, 3, 4]);
      assert.deepStrictEqual(ns(await db.Note.select({ tag: 'a' }).fetch()), [1, 3]);
      assert.deepStrictEqual(ns(await db.Note.select({ n: { $gt: 2 } }).fetch()), [3, 4]);
      assert.deepStrictEqual(ns(await db.Note.select({ tag: { $in: ['a', 'c'] } }).fetch()), [1, 3, 4]);
      // Ordered and windowed over the index: the sealed rows take their place.
      assert.deepStrictEqual(
        (await db.Note.select({}).order('n').fetch()).map((r) => r.n),
        [1, 2, 3, 4],
      );
      assert.deepStrictEqual(
        (await db.Note.select({}).desc('n').limit(2).fetch()).map((r) => r.n),
        [4, 3],
      );
      assert.deepStrictEqual(
        (await db.Note.select({ tag: 'a' }).order('tag').order('n').fetch()).map((r) => r.n),
        [1, 3],
      );
      assert.deepStrictEqual(ns(await db.Note.select({}).limit(3).fetch()).length, 3);
      // A count is a read of the rows, not an index's estimate, while a sealed record is there.
      assert.strictEqual(await db.Note.count({ tag: 'a' }), 2);
      assert.strictEqual(await db.Note.count({}), 4);
      assert.strictEqual(await db.Note.count({ tag: 'c' }), 1);
      // A page by the edge of the one before: every row once.
      const first = await db.Note.select({}).order('n').limit(2).page();
      const rest = await db.Note.select({}).order('n').limit(2).after(first.next).fetch();
      assert.deepStrictEqual(
        [...first.rows, ...rest].map((r) => r.n),
        [1, 2, 3, 4],
      );
      // The plan still names the index for the plain rows; the sealed ones ride beside it.
      const explained = db.Note.select({ tag: 'a' }).explain();
      assert.ok(explained !== null && typeof explained === 'object');
      // A sealed record set to another tag, and one deleted: the queries follow (the sealed listing is kept per change).
      await db.update(s3, { tag: 'b' });
      assert.deepStrictEqual(ns(await db.Note.select({ tag: 'b' }).fetch()), [2, 3]);
      assert.deepStrictEqual(ns(await db.Note.select({ tag: 'a' }).fetch()), [1]);
      await db.delete(s4);
      assert.deepStrictEqual(ns(await db.Note.select({}).fetch()), [1, 2, 3]);
      assert.strictEqual(await db.Note.count({}), 3);
      // A plain, replicated record is not sealed later (the core refuses: its ops are out); a sealed one stays sealed.
      await assert.rejects(() => db.set(p1, { $type: 'Note', tag: 'a', n: 1 }, { encrypted: true }), {
        code: 'ENCRYPTED',
      });
      assert.deepStrictEqual(ns(await db.Note.select({ tag: 'a' }).fetch()), [1]);
    },
  );

  await t.test('a live query hears a sealed record come and go', async (t2) => {
    const db = await open(t2, 'L');
    await db.insert({ $type: 'Note', tag: 'x', n: 1 });
    const seen = [];
    const stop = db.Note.select({ tag: 'x' }).watch((rows) => seen.push(ns(rows)));
    t2.after(() => stop());
    await waitUntil(() => seen.length >= 1);
    const sealed = await db.insert({ $type: 'Note', tag: 'x', n: 2 }, { encrypted: true });
    await waitUntil(() => seen.at(-1).length === 2, { timeout: 5000 });
    assert.deepStrictEqual(seen.at(-1), [1, 2]);
    await db.delete(sealed);
    await waitUntil(() => seen.at(-1).length === 1, { timeout: 5000 });
    assert.deepStrictEqual(seen.at(-1), [1]);
  });
});
