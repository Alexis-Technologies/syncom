'use strict';

// Sealed (encrypted) records in queries: read whole at the key holder and
// matched like the rest — no index knows them, so they join the candidates
// and nothing is covered or decided by an index while a collection holds one.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { SOURCE, CURSOR } = require('../src/symbols.js');
const { waitUntil } = require('./utils/mesh.js');

const ns = (rows) => rows.map((row) => row.n).sort((a, b) => a - b);

test('Sealed records in queries', async (t) => {
  const open = async (t2, name) => {
    const db = await syncom.createDatabase({
      engine: syncom.memoryEngine(),
      path: `${t2.name}/${name}`,
      logger: false,
      defer: 0,
      schema: { entities: { Note: { index: ['tag', 'n', ['tag', 'n']] } } },
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

  // The seam with every record read counted: a cursor made over it tells what a run cost.
  const counting = (db) => {
    const seam = db[SOURCE];
    const reads = { plain: 0, sealed: 0, ids: [] };
    const tally = (id) => {
      reads.ids.push(id);
      if (seam.row(id)?.encrypted === true) reads.sealed++;
      else reads.plain++;
    };
    const source = {
      ...seam,
      load: (id) => {
        tally(id);
        return seam.load(id);
      },
      loadMany: (ids) => {
        for (let i = 0; i < ids.length; i++) tally(ids[i]);
        return seam.loadMany(ids);
      },
    };
    return { source, reads };
  };

  await t.test(
    'an ordered, limited cursor over an index with sealed records reads the window and the sealed records alone, in the index’s order: a page after an edge, desc, and explain() saying sortedByIndex and how many sealed were read',
    async (t2) => {
      const db = await open(t2, 'W');
      for (let i = 1; i <= 40; i++) await db.insert({ $type: 'Note', tag: i % 2 ? 'odd' : 'even', n: i });
      await db.insert({ $type: 'Note', tag: 'odd', n: 5.5 }, { encrypted: true });
      await db.insert({ $type: 'Note', tag: 'even', n: 20.5 }, { encrypted: true });
      await db.insert({ $type: 'Note', tag: 'odd', n: 100 }, { encrypted: true });
      const { source, reads } = counting(db);
      const select = (query = {}) => db[CURSOR]('Note', query, { source, sealed: true });
      const ns = (rows) => rows.map((row) => row.n);
      // The first page: the plain rows come from the index in its order, the sealed records are read once and laid
      // where they sort; ten plain records read, not forty-three.
      const first = await select().order('n').limit(10).page();
      assert.deepStrictEqual(ns(first.rows), [1, 2, 3, 4, 5, 5.5, 6, 7, 8, 9]);
      assert.deepStrictEqual(reads, { ...reads, plain: 10, sealed: 3 }, 'the window and the sealed records alone');
      // The next page after the edge: sought in the index, the sealed records judged by the edge.
      reads.plain = 0;
      reads.sealed = 0;
      const second = await select().order('n').limit(10).after(first.next).fetch();
      assert.deepStrictEqual(ns(second), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
      assert.strictEqual(reads.plain, 10);
      reads.plain = 0;
      const third = await select()
        .order('n')
        .limit(10)
        .after({ keys: [19], id: second[9].id })
        .fetch();
      assert.deepStrictEqual(ns(third), [20, 20.5, 21, 22, 23, 24, 25, 26, 27, 28]);
      assert.strictEqual(reads.plain, 10);
      // Descending: the sealed record past the index's top comes first.
      reads.plain = 0;
      assert.deepStrictEqual(ns(await select().desc('n').limit(5).fetch()), [100, 40, 39, 38, 37]);
      assert.strictEqual(reads.plain, 5);
      // A prefix on the index and a filter the index does not decide: the plain rows read are the window's.
      reads.plain = 0;
      assert.deepStrictEqual(ns(await select({ tag: 'odd' }).order('n').limit(4).fetch()), [1, 3, 5, 5.5]);
      assert.strictEqual(reads.plain, 4);
      // Covered — a projection the index holds: no plain record is read, the sealed ones alone.
      reads.plain = 0;
      reads.sealed = 0;
      const covered = await select().order('n').limit(10).projection(['n']).fetch();
      assert.deepStrictEqual(ns(covered), [1, 2, 3, 4, 5, 5.5, 6, 7, 8, 9]);
      assert.deepStrictEqual([reads.plain, reads.sealed], [0, 3]);
      // Every row, streamed by keyset: each once, in order.
      const all = [];
      for await (const row of select().order('n').stream({ batch: 7 })) all.push(row.n);
      assert.strictEqual(all.length, 43);
      assert.deepStrictEqual(
        all,
        [...all].sort((a, b) => a - b),
      );
      // The plan says so: sorted by the index, and how many sealed records ride beside it.
      const explained = db.Note.select({}).order('n').limit(10).explain();
      assert.strictEqual(explained.sortedByIndex, true);
      assert.strictEqual(explained.sealed, 3);
    },
  );

  await t.test(
    'count() over a sorted index with sealed records is the index’s estimate and the sealed matches, no plain row read',
    async (t2) => {
      const db = await open(t2, 'C');
      for (let i = 1; i <= 30; i++) await db.insert({ $type: 'Note', tag: 't', n: i });
      await db.insert({ $type: 'Note', tag: 't', n: 10.5 }, { encrypted: true });
      await db.insert({ $type: 'Note', tag: 't', n: 100 }, { encrypted: true });
      const { source, reads } = counting(db);
      assert.strictEqual(await db[CURSOR]('Note', { n: { $gte: 10 } }, { source, sealed: true }).count(), 21 + 2);
      assert.deepStrictEqual([reads.plain, reads.sealed], [0, 2]);
      assert.strictEqual(await db[CURSOR]('Note', { tag: 't' }, { source, sealed: true }).count(), 32);
      assert.strictEqual(reads.plain, 0);
    },
  );

  await t.test(
    'a cursor made through the seam leaves sealed records out unless asked: the facade’s collections ask; a host’s query and count, and a live run through the seam, do not',
    async (t2) => {
      const db = await open(t2, 'S');
      const p1 = await db.insert({ $type: 'Note', tag: 'a', n: 1 });
      const s2 = await db.insert({ $type: 'Note', tag: 'a', n: 2, ref: p1 }, { encrypted: true });
      await db.insert({ $type: 'Note', tag: 'a', n: 3, ref: s2 });
      const ns = (rows) => rows.map((row) => row.n).sort((a, b) => a - b);
      // The seam's default: no sealed record — not in a run, an ordered page, a count, a covered projection.
      assert.deepStrictEqual(ns(await db[CURSOR]('Note', {}).fetch()), [1, 3]);
      assert.deepStrictEqual(ns(await db[CURSOR]('Note', { tag: 'a' }).order('n').limit(5).fetch()), [1, 3]);
      assert.deepStrictEqual(ns(await db[CURSOR]('Note', {}).projection(['n']).fetch()), [1, 3]);
      assert.strictEqual(await db[CURSOR]('Note', {}).count(), 2);
      assert.strictEqual(await db[CURSOR]('Note', { n: { $gte: 2 } }).count(), 1);
      assert.strictEqual(await db[CURSOR]('Note', { tag: 'a' }).count(), 2);
      assert.strictEqual(db[CURSOR]('Note', {}).explain().sealed, 0);
      // Asked for: the key holder reads them.
      assert.deepStrictEqual(ns(await db[CURSOR]('Note', {}, { sealed: true }).fetch()), [1, 2, 3]);
      assert.strictEqual(await db[CURSOR]('Note', {}, { sealed: true }).count(), 3);
      assert.strictEqual(db[CURSOR]('Note', {}, { sealed: true }).explain().sealed, 1);
      // The facade's collections ask by default, and may not.
      assert.deepStrictEqual(ns(await db.Note.select({}).fetch()), [1, 2, 3]);
      assert.strictEqual(await db.Note.count({}), 3);
      assert.deepStrictEqual(ns(await db.Note.select({}, { sealed: false }).fetch()), [1, 3]);
      assert.strictEqual(await db.Note.count({}, { sealed: false }), 2);
      assert.throws(() => db.Note.select({}, 7), { name: 'TypeError' });
      // A live run through the seam: a sealed record coming or going is not heard as a row.
      const seen = [];
      const stop = db[CURSOR]('Note', { tag: 'a' }).watch((rows) => seen.push(ns(rows)));
      t2.after(() => stop());
      await waitUntil(() => seen.length >= 1);
      assert.deepStrictEqual(seen.at(-1), [1, 3]);
      await db.insert({ $type: 'Note', tag: 'a', n: 4 }, { encrypted: true });
      await db.insert({ $type: 'Note', tag: 'a', n: 5 });
      await waitUntil(() => seen.at(-1).length === 3, { timeout: 5000 });
      assert.deepStrictEqual(seen.at(-1), [1, 3, 5]);
      // A reference to a sealed record populated through the seam reads as nothing there; the facade reads it.
      const dbRefs = await syncom.createDatabase({
        engine: syncom.memoryEngine(),
        path: `${t2.name}/refs`,
        logger: false,
        defer: 0,
        schema: { entities: { Note: { refs: { ref: 'Note' } } } },
      });
      t2.after(() => dbRefs.close().catch(() => {}));
      const sealedRef = await dbRefs.insert({ $type: 'Note', n: 1 }, { encrypted: true });
      const plainRef = await dbRefs.insert({ $type: 'Note', n: 2 });
      const holder = await dbRefs.insert({ $type: 'Note', n: 3, ref: sealedRef, other: plainRef });
      const [viaSeam] = await dbRefs[CURSOR]('Note', { n: 3 }).populate(['ref']).fetch();
      assert.strictEqual(viaSeam.ref, null);
      const [viaFacade] = await dbRefs.Note.select({ n: 3 }).populate(['ref']).fetch();
      assert.strictEqual(viaFacade.ref.n, 1);
      assert.strictEqual(viaFacade.id, holder);
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
