'use strict';

// Collections through the database, against whichever half the caller
// builds: definitions added and removed after the open, bulk writes, upserts,
// `modify()`, the update operators, writes by query, a delete that carries
// data, declared references, ORM methods and the collection events.
// `createStorage(t, name, options)` gives the SAME directory for the same
// name within one subtest (reopen cases).

const { memory } = require('../../src/memory/memory.js');
const { createMesh, settle } = require('../utils/mesh.js');

const code = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error.code ?? error.name;
  }
  return null;
};

// An fsi whose next writes fail on demand (`failing.fail = true`): what a batch that cannot reach the disk meets.
const failing = (fsi) => {
  const wrapped = {
    read: (dir, name) => fsi.read(dir, name),
    write: (dir, name, content, options) =>
      wrapped.fail ? Promise.reject(new Error('disk full')) : fsi.write(dir, name, content, options),
    append: (dir, name, content) =>
      wrapped.fail ? Promise.reject(new Error('disk full')) : fsi.append(dir, name, content),
    exists: (dir, name) => fsi.exists(dir, name),
    remove: (dir, name) => fsi.remove(dir, name),
    list: (dir) => fsi.list(dir),
    fail: false,
  };
  return wrapped;
};

const runCollectionTests = async (t, assert, createStorage) => {
  await t.test(
    'bulkInsert(), bulkUpsert() and bulkRemove() are one transaction with a verdict per row: a refused row stays out, the rest land, a failed batch lands nothing',
    async (t2) => {
      const fsi = failing(memory());
      const schema = { entities: { Post: { unique: ['slug'], schema: (data) => typeof data.slug === 'string' } } };
      const db = await createStorage(t2, 'A', { fsi, schema });
      const turns = [];
      db.on('transaction', (event) => turns.push(event));
      await db.Post.insert({ id: 'p1', slug: 'a' });
      const rows = [{ slug: 'c' }, { slug: 'a' }, { id: 'p1', slug: 'z' }, 5, { slug: 7 }, { id: 'p2', slug: 'd' }];
      const inserted = await db.Post.bulkInsert(rows);
      assert.strictEqual(inserted.success.length, 2);
      assert.strictEqual(inserted.success[1], 'p2');
      assert.deepStrictEqual(
        inserted.error.map(({ index, id, error }) => [index, id, error.code ?? error.name]),
        [
          [1, null, 'VALIDATION_FAILED'],
          [2, 'p1', 'EXISTS'],
          [3, null, 'TypeError'],
          [4, null, 'VALIDATION_FAILED'],
        ],
      );
      assert.strictEqual(inserted.error[1].data, rows[2], 'the row as given');
      // One turn for the batch, an op per row that landed; nothing of a refused row.
      assert.strictEqual(turns.length, 2);
      assert.strictEqual(turns[1].ops.length, 2);
      assert.deepStrictEqual(await db.Post.get('p1'), { slug: 'a', $type: 'Post' });
      assert.strictEqual(await db.Post.count(), 3);
      const upserted = await db.Post.bulkUpsert([{ id: 'p2', slug: 'dd', n: 1 }, { slug: 'nope' }]);
      assert.deepStrictEqual(upserted.success, ['p2']);
      assert.strictEqual(upserted.error[0].error.code, 'INVALID_ID');
      assert.deepStrictEqual(await db.Post.get('p2'), { slug: 'dd', n: 1, $type: 'Post' });
      const other = await db.insert({ $type: 'Other' });
      const removed = await db.Post.bulkRemove(['p2', 'nope', other, 'p1']);
      assert.deepStrictEqual(removed.success, ['p2', 'p1']);
      assert.deepStrictEqual(
        removed.error.map(({ index, error }) => [index, error.code]),
        [
          [1, 'NOT_FOUND'],
          [2, 'NOT_FOUND'],
        ],
      );
      assert.strictEqual(await db.Post.count(), 1);
      // The disk fails the batch: nothing of it lands, the rows that were right included.
      await db.log.flush();
      fsi.fail = true;
      const failed = await db.Post.bulkInsert([{ slug: 'x' }, { slug: 'y' }]).then(
        () => null,
        (error) => error,
      );
      fsi.fail = false;
      assert.ok(failed !== null, 'the batch failed');
      assert.strictEqual(await db.Post.count(), 1);
      assert.strictEqual(await db.Post.count({ slug: 'x' }), 0);
      // Not an array, not plain objects: the caller's mistake.
      await assert.rejects(db.Post.bulkInsert({}), TypeError);
      await assert.rejects(db.Post.bulkRemove('p1'), TypeError);
    },
  );

  await t.test(
    'a record named by its data: insert() takes the id field as the id, EXISTS for a live one, upsert() and insertIfAbsent() write by it',
    async (t2) => {
      const db = await createStorage(t2, 'A', {
        fsi: memory(),
        schema: { entities: { Post: {}, Note: { idField: 'noteId' } } },
      });
      const post = await db.Post.insert({ id: 'p1', title: 'a' });
      assert.strictEqual(post.id, 'p1');
      assert.deepStrictEqual(await db.get('p1'), { title: 'a', $type: 'Post' }, 'the id field leaves the data');
      assert.strictEqual(await code(db.Post.insert({ id: 'p1', title: 'b' })), 'EXISTS');
      assert.strictEqual(await code(db.insert({ $type: 'Post', id: 'p1' })), 'EXISTS');
      assert.strictEqual(await code(db.transact((tx) => tx.insert({ $type: 'Post', id: 'p1' }))), 'EXISTS');
      assert.strictEqual(await code(db.Post.insert({ id: 'bad id' })), 'INVALID_ID');
      // Under the entity's own id field; a bare `id` is a field then.
      const note = await db.Note.insert({ noteId: 'n1', id: 'kept' });
      assert.strictEqual(note.id, 'n1');
      assert.deepStrictEqual(await db.Note.get('n1'), { id: 'kept', $type: 'Note' });
      // Without one: minted, as before.
      const minted = await db.Post.insert({ title: 'c' });
      assert.notStrictEqual(minted.id, 'p1');
      // upsert() writes whole by the named id, new or not; insertIfAbsent() leaves a live one as it is.
      const up = await db.Post.upsert({ id: 'p1', title: 'b', n: 1 });
      assert.strictEqual(up.title, 'b');
      assert.deepStrictEqual(await db.Post.get('p1'), { title: 'b', n: 1, $type: 'Post' });
      await db.Post.upsert({ id: 'p9', title: 'new' });
      assert.deepStrictEqual(await db.Post.get('p9'), { title: 'new', $type: 'Post' });
      assert.strictEqual(await code(db.Post.upsert({ title: 'no id' })), 'INVALID_ID');
      const kept = await db.Post.insertIfAbsent({ id: 'p1', title: 'z' });
      assert.strictEqual(kept.title, 'b');
      const made = await db.Post.insertIfAbsent({ id: 'p10', title: 'z' });
      assert.strictEqual(made.title, 'z');
      // A deleted record is not there: insert() and insertIfAbsent() write it again.
      await db.Post.delete('p9');
      await db.Post.insert({ id: 'p9', title: 'again' });
      assert.deepStrictEqual(await db.Post.get('p9'), { title: 'again', $type: 'Post' });
      assert.strictEqual(await code(db.Note.insertIfAbsent({ noteId: 'n1' })), null);
    },
  );

  await t.test(
    'a composite id is derived from the declared fields once, and a value outside the id class is INVALID_ID',
    async (t2) => {
      const schema = {
        entities: { Line: { id: { fields: ['orgId', 'n'], separator: '-' } }, Cell: { id: { fields: ['x', 'y'] } } },
      };
      const db = await createStorage(t2, 'A', { fsi: memory(), schema });
      const line = await db.Line.insert({ orgId: 'o1', n: 3, text: 'x' });
      assert.strictEqual(line.id, 'o1-3');
      assert.deepStrictEqual(
        await db.Line.get('o1-3'),
        { orgId: 'o1', n: 3, text: 'x', $type: 'Line' },
        'the fields stay',
      );
      assert.strictEqual((await db.Cell.insert({ x: 1, y: 2 })).id, '1.2', "'.' unless given");
      assert.strictEqual(await code(db.Line.insert({ orgId: 'o1', n: 3 })), 'EXISTS');
      assert.strictEqual(await code(db.Line.insert({ orgId: 'o1' })), 'INVALID_ID', 'a field missing');
      assert.strictEqual(await code(db.Line.insert({ orgId: 'o 1', n: 1 })), 'INVALID_ID', 'outside the class');
      assert.strictEqual(await code(db.insert({ $type: 'Line', orgId: 'o/1', n: 1 })), 'INVALID_ID');
      // upsert, insertIfAbsent and the bulk writes derive it the same way.
      await db.Line.upsert({ orgId: 'o1', n: 3, text: 'y' });
      assert.strictEqual((await db.Line.get('o1-3')).text, 'y');
      assert.strictEqual((await db.Line.insertIfAbsent({ orgId: 'o1', n: 3, text: 'z' })).text, 'y');
      const bulk = await db.Line.bulkInsert([{ orgId: 'o2', n: 1 }, { orgId: 'o2' }, { orgId: 'o1', n: 3 }]);
      assert.deepStrictEqual(bulk.success, ['o2-1']);
      assert.deepStrictEqual(
        bulk.error.map(({ error }) => error.code),
        ['INVALID_ID', 'EXISTS'],
      );
      // The definition is checked: a separator outside the class, no fields.
      await assert.rejects(db.addCollections({ Bad: { id: { fields: ['a'], separator: '|' } } }), TypeError);
      await assert.rejects(db.addCollections({ Bad: { id: { fields: [] } } }), TypeError);
    },
  );

  await t.test(
    'modify(fn) runs fn over the record inside the queue and writes the difference: two in parallel compose, a counter field is FIELD_KIND, null deletes',
    async (t2) => {
      const db = await createStorage(t2, 'A', { fsi: memory(), schema: { entities: { Post: {} } } });
      const id = (await db.Post.insert({ n: 1, tags: ['a'], old: true, nested: { a: 1 } })).id;
      await db.inc(id, 'hits', 1);
      const changes = [];
      db.on('change', (op) => changes.push(op.type));
      // Two at once, each reading what the one before it left: no lost update, nothing to retry.
      const [, second] = await Promise.all([
        db.modify(id, (doc) => void (doc.n += 1)),
        db.Post.modify(id, async (doc) => {
          doc.n += 1;
          delete doc.old;
          doc.nested = { a: 1 };
          return doc;
        }),
      ]);
      assert.deepStrictEqual(second, { n: 3, tags: ['a'], nested: { a: 1 }, $type: 'Post', hits: 1 });
      assert.deepStrictEqual(await db.get(id), second);
      // The difference alone: a set of what changed, an unset of what went; a field left as it was is no op.
      assert.deepStrictEqual(changes, ['set', 'unset', 'set']);
      assert.deepStrictEqual(await db.modify(id, () => undefined), second, 'nothing changed: nothing written');
      assert.strictEqual(changes.length, 3);
      // A field of another kind is written through its own method, never by a function.
      assert.strictEqual(await code(db.modify(id, (doc) => void (doc.hits = 9))), 'FIELD_KIND');
      assert.strictEqual((await db.get(id)).hits, 1);
      // What a function may return; a write through the database from inside it; a foreign record.
      assert.strictEqual(await code(db.modify(id, () => 5)), 'TypeError');
      assert.strictEqual(await code(db.modify(id, () => db.update(id, { x: 1 }))), 'IN_TRANSACTION');
      assert.strictEqual(await code(db.modify(id, 'nope')), 'TypeError');
      const other = await db.insert({ $type: 'Other' });
      assert.strictEqual(await code(db.Post.modify(other, () => {})), 'NOT_FOUND');
      // Inside a transaction, over what the transaction left.
      const z = await db.transact(async (tx) => {
        await tx.update(id, { z: 1 });
        await tx.modify(id, (doc) => void (doc.z += 1));
        return (await tx.get(id)).z;
      });
      assert.strictEqual(z, 2);
      assert.strictEqual((await db.get(id)).z, 2);
      assert.strictEqual(await db.modify(id, () => null), null);
      assert.strictEqual(await db.get(id), null);
      assert.strictEqual(await code(db.modify(id, () => {})), 'NOT_FOUND');
    },
  );

  await t.test(
    'an update operator goes by the kind of its field and refuses the rest, as one transaction; ifMatch writes only where the record matches',
    async (t2) => {
      const db = await createStorage(t2, 'A', { fsi: memory(), schema: { entities: { Post: {} } } });
      const id = (await db.Post.insert({ n: 1, tags: ['a'], arr: [1, 2], title: 't' })).id;
      await db.add(id, 'set', ['x']);
      await db.push(id, 'list', [1, 2, 3]);
      await db.push(id, 'body', 'ab');
      await db.inc(id, 'hits', 1);
      const turns = [];
      db.on('transaction', (event) => turns.push(event.ops.map((op) => op.type)));
      await db.Post.update(id, {
        $inc: { hits: 2, fresh: 1 },
        $addToSet: { set: 'y', arr: { $each: [2, 3] } },
        $pull: { tags: 'a' },
        $push: { list: 9, body: 'c', made: 5 },
        $pop: { arr: -1 },
        $min: { n: 0 },
        $max: { n: 0 },
        $rename: { title: 'name' },
        $unset: ['gone'],
        $set: { z: 1 },
      });
      assert.deepStrictEqual(await db.get(id), {
        n: 0,
        tags: [],
        arr: [2],
        $type: 'Post',
        set: ['x', 'y'],
        list: [1, 2, 3, 9],
        body: 'abc',
        hits: 3,
        fresh: 1,
        made: [5],
        name: 't',
        z: 1,
      });
      // One turn: inc, inc, add, push, push, the rename's unset, then one set of what was rewritten
      // (`tags` is a register's array: `$pull` rewrote it) and set.
      assert.deepStrictEqual(turns, [['inc', 'inc', 'add', 'splice', 'splice', 'unset', 'set']]);
      // A kind refuses what is not its own: the whole update, nothing of it written.
      assert.strictEqual(await code(db.update(id, { $inc: { name: 1 }, $set: { k: 1 } })), 'FIELD_KIND');
      assert.strictEqual(await code(db.update(id, { $addToSet: { hits: 1 } })), 'FIELD_KIND');
      assert.strictEqual(await code(db.update(id, { $push: { hits: 1 } })), 'FIELD_KIND');
      assert.strictEqual((await db.get(id)).k, undefined);
      assert.strictEqual(await code(db.update(id, { $set: { a: 1 }, b: 2 })), 'TypeError', 'operators or fields');
      assert.strictEqual(await code(db.Post.update(id, { $set: { $type: 'X' } })), 'TypeError');
      assert.strictEqual(await code(db.update('nope', { $set: { a: 1 } })), 'NOT_FOUND');
      // Inside a transaction, over what it left; and from a Document's collection.
      await db.transact(async (tx) => {
        await tx.update(id, { k: 1 });
        await tx.update(id, { $inc: { k2: 1 }, $max: { k: 5 } });
      });
      assert.deepStrictEqual([(await db.get(id)).k, (await db.get(id)).k2], [5, 1]);
      // ifMatch: decided inside the queue, over the record as it reads; resolves to whether it wrote.
      assert.strictEqual(await db.update(id, { m: 1 }, { ifMatch: { n: 0 } }), true);
      assert.strictEqual(await db.update(id, { m: 2 }, { ifMatch: { n: 5 } }), false);
      assert.strictEqual((await db.get(id)).m, 1);
      assert.strictEqual(await db.Post.update(id, { $inc: { hits: 1 } }, { ifMatch: { hits: { $gte: 3 } } }), true);
      assert.strictEqual((await db.get(id)).hits, 4);
      assert.strictEqual(await code(db.update(id, { m: 3 }, { ifMatch: { $nope: 1 } })), 'TypeError');
      assert.strictEqual(await db.transact((tx) => tx.update(id, { m: 3 }, { ifMatch: { m: 1 } })), true);
    },
  );

  await t.test(
    "a cursor's update(), modify() and delete() are one transaction over the matches, each matched again inside the queue",
    async (t2) => {
      const db = await createStorage(t2, 'A', { fsi: memory(), schema: { entities: { Post: { index: ['org'] } } } });
      const ids = [];
      for (let i = 0; i < 10; i++) ids.push((await db.Post.insert({ org: i % 2 ? 'a' : 'b', n: i })).id);
      const turns = [];
      db.on('transaction', (event) => turns.push(event.ops.length));
      const updated = await db.Post.select({ org: 'a' }).update({ $inc: { hits: 1 }, $set: { seen: true } });
      assert.deepStrictEqual(updated, { matched: 5, written: 5 });
      assert.strictEqual(await db.Post.count({ seen: true }), 5);
      // The window applies: the two lowest of org b, by n.
      const modified = await db.Post.select({ org: 'b' })
        .order('n')
        .limit(2)
        .modify((doc) => void (doc.top = true));
      assert.deepStrictEqual(modified, { matched: 2, written: 2 });
      assert.deepStrictEqual(
        (await db.Post.select({ top: true }).order('n').fetch()).map((row) => row.n),
        [0, 2],
      );
      const changes = [];
      db.on('change', (op, via, { changes: own }) => changes.push(...own));
      const deleted = await db.Post.select({ org: 'b', n: { $gte: 6 } }).delete({ data: { why: 'old' } });
      assert.deepStrictEqual(deleted, { matched: 2, written: 2 });
      // A tombstone that carries data keeps the record's collection.
      assert.deepStrictEqual(changes, [
        { action: 'delete', data: { why: 'old', $type: 'Post' } },
        { action: 'delete', data: { why: 'old', $type: 'Post' } },
      ]);
      assert.strictEqual(await db.Post.count(), 8);
      // One turn each, an op per record written.
      assert.deepStrictEqual(turns, [10, 2, 2]);
      // A record gone between the match and the write is skipped, and counted out of `written`.
      const cursor = db.Post.select({ org: 'a' });
      const [first] = await cursor.projection([]).fetch();
      let skipped = null;
      const hook = db.on('transaction', () => {});
      void hook;
      await db.transact(async (tx) => {
        await tx.delete(first.id);
      });
      skipped = await cursor.update({ late: true });
      assert.deepStrictEqual(skipped, { matched: 4, written: 4 });
      // A record that stopped matching between the match and the write — a transaction ahead in the queue
      // moved it — is skipped too: the predicate runs again inside the queue, over the record as it reads there.
      const [second] = await db.Post.select({ org: 'a' }).order('n').limit(1).fetch();
      const held = db.transact(async (tx) => {
        await tx.update(second.id, { org: 'moved' });
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      const rechecked = await db.Post.select({ org: 'a' }).update({ late: 2 });
      await held;
      assert.deepStrictEqual(rechecked, { matched: 4, written: 3 }, 'the moved one left out');
      assert.deepStrictEqual(await db.Post.select({ org: 'a' }).delete(), { matched: 3, written: 3 });
      assert.deepStrictEqual(await db.Post.select({ org: 'a' }).update({ x: 1 }), { matched: 0, written: 0 });
      await assert.rejects(db.Post.select().modify('nope'), TypeError);
      // A view at a tag reads alone (the versions plugin's; the lean suite runs without it).
      if (db.plugins.includes('versions')) {
        await db.tag('t');
        await assert.rejects(db.at('t').collection('Post').select().update({ a: 1 }), TypeError);
      }
    },
  );

  await t.test(
    'a composite id refuses a value that holds the separator or is of another kind, and its fields are immutable',
    async (t2) => {
      const schema = { entities: { Cell: { id: { fields: ['x', 'y'] } } } };
      const db = await createStorage(t2, 'A', { fsi: memory(), schema });
      const code = (promise) =>
        promise.then(
          () => null,
          (error) => error.code,
        );
      // `a.b` + `c` and `a` + `b.c` would be one id: a value that holds the separator is refused.
      assert.strictEqual(await code(db.Cell.insert({ x: 'a.b', y: 'c' })), 'INVALID_ID');
      assert.strictEqual(await code(db.Cell.insert({ x: 'a', y: 'b.c' })), 'INVALID_ID');
      assert.strictEqual(await code(db.Cell.upsert({ x: 'a.b', y: 'c' })), 'INVALID_ID');
      assert.strictEqual(await code(db.insert({ $type: 'Cell', x: 'a', y: 'b.c' })), 'INVALID_ID');
      assert.strictEqual(await code(db.Cell.insert({ x: { nested: 1 }, y: 'c' })), 'INVALID_ID', 'an object');
      assert.strictEqual(await code(db.Cell.insert({ x: true, y: 'c' })), null, 'a boolean reads as text');
      const cell = await db.Cell.insert({ x: 'a', y: 1, v: 0 });
      assert.strictEqual(cell.id, 'a.1');
      // The fields the id is derived from never change: not by a set, an operator, a function or an unset.
      assert.strictEqual(await code(db.Cell.update(cell.id, { x: 'b' })), 'ID_IMMUTABLE');
      assert.strictEqual(await code(db.Cell.update(cell.id, { $set: { y: 2 } })), 'ID_IMMUTABLE');
      assert.strictEqual(await code(db.Cell.update(cell.id, { $rename: { x: 'z' } })), 'ID_IMMUTABLE');
      assert.strictEqual(await code(db.Cell.modify(cell.id, (doc) => void (doc.y = 3))), 'ID_IMMUTABLE');
      assert.strictEqual(await code(db.unset(cell.id, ['x'])), 'ID_IMMUTABLE');
      assert.strictEqual(await code(db.transact((tx) => tx.update(cell.id, { x: 'q' }))), 'ID_IMMUTABLE');
      // The same values, as text, pass; the other fields change freely.
      await db.Cell.update(cell.id, { x: 'a', y: '1', v: 1 });
      await db.Cell.update(cell.id, { $set: { v: 2 } });
      assert.deepStrictEqual(await db.get(cell.id), { x: 'a', y: '1', v: 2, $type: 'Cell' });
      // A live record under the named id is EXISTS whichever way it is written — an encrypted write too.
      assert.strictEqual(await code(db.Cell.insert({ x: 'a', y: 1 })), 'EXISTS');
      assert.strictEqual(await code(db.Cell.insert({ x: 'a', y: 1 }, { encrypted: true })), 'EXISTS');
      assert.deepStrictEqual(await db.get(cell.id), { x: 'a', y: '1', v: 2, $type: 'Cell' }, 'untouched');
    },
  );

  await t.test('$type is immutable through unset, $unset, $rename and modify', async (t2) => {
    const db = await createStorage(t2, 'A', { fsi: memory(), schema: { entities: { Post: {}, Other: {} } } });
    const code = (promise) =>
      promise.then(
        () => null,
        (error) => error.code,
      );
    const id = (await db.Post.insert({ title: 'x' })).id;
    assert.strictEqual(await code(db.unset(id, ['$type'])), 'TYPE_IMMUTABLE');
    assert.strictEqual(await code(db.update(id, { $unset: ['$type'] })), 'TYPE_IMMUTABLE');
    assert.strictEqual(await code(db.update(id, { $rename: { $type: 'kind' } })), 'TYPE_IMMUTABLE');
    assert.strictEqual(await code(db.update(id, { $set: { $type: 'Other' } })), 'TYPE_IMMUTABLE');
    assert.strictEqual(await code(db.modify(id, () => ({ title: 'y', $type: 'Other' }))), 'TYPE_IMMUTABLE');
    // A function that leaves $type out keeps it: the collection is not the function's to change.
    assert.deepStrictEqual(await db.modify(id, () => ({ title: 'z' })), { title: 'z', $type: 'Post' });
    assert.deepStrictEqual(await db.get(id), { title: 'z', $type: 'Post' });
    assert.strictEqual(await db.Post.count(), 1);
    assert.strictEqual(await db.Other.count(), 0);
  });

  await t.test(
    'a data field named id never names another record: writes by query and ifMatch go by the record’s id',
    async (t2) => {
      const db = await createStorage(t2, 'A', { fsi: memory(), schema: { entities: { Post: {} } } });
      const p1 = (await db.Post.insert({ t: 'one' })).id;
      const p2 = (await db.Post.insert({ t: 'two' })).id;
      // A data field named `id` — a peer could set one on any record.
      await db.update(p1, { id: p2 });
      assert.deepStrictEqual(await db.get(p1), { t: 'one', id: p2, $type: 'Post' });
      // In a row the record's id wins; the data field is under it.
      assert.deepStrictEqual(await db.Post.select({ t: 'one' }).fetch(), [{ t: 'one', id: p1, $type: 'Post' }]);
      assert.deepStrictEqual(await db.Post.select({ id: p2 }).fetch(), [{ t: 'two', id: p2, $type: 'Post' }]);
      // A write by query goes to the record matched, never to the one its data names.
      assert.deepStrictEqual(await db.Post.select({ t: 'one' }).update({ seen: true }), { matched: 1, written: 1 });
      assert.deepStrictEqual(await db.get(p2), { t: 'two', $type: 'Post' }, 'p2 untouched');
      assert.strictEqual((await db.get(p1)).seen, true);
      assert.deepStrictEqual(await db.Post.select({ t: 'one' }).delete(), { matched: 1, written: 1 });
      assert.strictEqual(await db.get(p1), null);
      assert.deepStrictEqual(await db.get(p2), { t: 'two', $type: 'Post' });
      // `ifMatch` reads the record's id too.
      await db.update(p2, { id: 'other' });
      assert.strictEqual(await db.update(p2, { t: 'three' }, { ifMatch: { id: p2 } }), true);
      assert.strictEqual(await db.update(p2, { t: 'four' }, { ifMatch: { id: 'other' } }), false);
      assert.strictEqual((await db.get(p2)).t, 'three');
    },
  );

  await t.test(
    'a reference resolves within the declared collection alone, and a Document holds a copy of a reference field’s value',
    async (t2) => {
      const schema = { entities: { Author: {}, Tag: {}, Post: { refs: { author: 'Author', tags: ['Tag'] } } } };
      const db = await createStorage(t2, 'A', { fsi: memory(), schema });
      const tag = await db.Tag.insert({ n: 't' });
      // A Tag's id where an Author is declared: not an Author — null, from a Document and from a cursor.
      const post = await db.Post.insert({ title: 'q', author: tag.id, tags: [tag.id] });
      assert.strictEqual(await post.populate('author'), null);
      assert.strictEqual(await post.author.document(), null);
      assert.strictEqual((await post.populate('tags'))[0].n, 't');
      const [row] = await db.Post.select({ title: 'q' }).populate(['author', 'tags']).fetch();
      assert.strictEqual(row.author, null);
      assert.deepStrictEqual(row.tags, [{ n: 't', $type: 'Tag', id: tag.id }]);
      // A reference field holding an object (no id yet): the Document holds a copy, never the record's own.
      const odd = await db.Post.insert({ title: 'r', author: { pending: true } });
      odd.author.pending = false;
      assert.deepStrictEqual((await db.get(odd.id)).author, { pending: true }, 'the record is as written');
      assert.deepStrictEqual((await db.Post.select({ title: 'r' }).fetch())[0].author, { pending: true });
    },
  );

  await t.test('delete(id, { data }) leaves the record dead everywhere and the data on the tombstone', async (t2) => {
    const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage, {
      nodes: { A: { fsi: memory() }, B: { fsi: memory() } },
    });
    const a = mesh.get('A');
    const b = mesh.get('B');
    const changes = [];
    b.on('change', (op, via, { changes: own }) => changes.push(...own));
    const id = await a.insert({ title: 'x', n: 1 });
    await settle([a, b]);
    assert.deepStrictEqual(await b.get(id), { title: 'x', n: 1 });
    await a.delete(id, { data: { by: 'admin', why: 'spam' } });
    await settle([a, b]);
    assert.strictEqual(await a.get(id), null);
    assert.strictEqual(await b.get(id), null);
    assert.strictEqual(a.hasRecord(id), false);
    assert.strictEqual(await b.has(id), false);
    assert.deepStrictEqual(changes.at(-1), { action: 'delete', data: { by: 'admin', why: 'spam' } });
    // The tombstone carries it, on both — and a snapshot page hands it on.
    const page = await b.snapshot({ limit: 10 });
    const row = page.records.find((record) => record.id === id);
    assert.deepStrictEqual(row.data, { by: 'admin', why: 'spam' });
    assert.ok(row.meta.deleted !== null);
    // A field written above the tombstone revives the record, which then reads what the tombstone
    // carried too (a whole write would reset it, as any reset does).
    await b.add(id, 'tags', ['t']);
    await settle([a, b]);
    assert.deepStrictEqual(await a.get(id), { by: 'admin', why: 'spam', tags: ['t'] });
    assert.deepStrictEqual(await b.get(id), await a.get(id));
    await assert.rejects(a.delete(id, { data: 5 }), TypeError);
    // Without data: as before.
    await a.delete(id);
    await settle([a, b]);
    assert.strictEqual(await b.get(id), null);
    assert.deepStrictEqual(changes.at(-1), { action: 'delete' });
  });

  await t.test(
    'a Reference reads only where a reference is declared, a target gone resolves to null, and populate() hands the records',
    async (t2) => {
      const schema = {
        entities: {
          Author: {},
          Tag: {},
          Post: { refs: { author: 'Author', tags: ['Tag'] } },
          // Read off the schema's relations, as metaschema lays them out.
          Memo: { schema: { fields: { author: 'Author', tags: { many: 'Tag' }, title: 'string' } }, validate: false },
        },
      };
      const db = await createStorage(t2, 'A', { fsi: memory(), schema });
      const author = await db.Author.insert({ name: 'ada' });
      const t1 = await db.Tag.insert({ n: 't1' });
      const t2tag = await db.Tag.insert({ n: 't2' });
      const post = await db.Post.insert({
        title: 'p',
        author: author.id,
        tags: [t1.id, t2tag.id, 'nope'],
        plain: author.id,
      });
      // Declared: a Reference, whatever it names; not declared: the string, a known id or not.
      assert.strictEqual(post.author.id, author.id);
      assert.strictEqual(typeof post.author.document, 'function');
      assert.strictEqual(post.tags.length, 3);
      assert.strictEqual(post.tags[2].id, 'nope');
      assert.strictEqual(typeof post.plain, 'string');
      assert.deepStrictEqual(
        JSON.parse(JSON.stringify(await post.data())).author,
        author.id,
        'a Reference is its id as JSON',
      );
      assert.strictEqual((await post.populate('author')).name, 'ada');
      assert.deepStrictEqual(
        (await post.populate('tags')).map((doc) => doc && doc.n),
        ['t1', 't2', null],
      );
      await assert.rejects(post.populate('plain'), TypeError);
      assert.strictEqual(await post.tags[2].document(), null, 'never there');
      // A write through the Document keeps the field a Reference.
      const t3 = await db.Tag.insert({ n: 't3' });
      await db.Post.update(post.id, { tags: [t3.id] });
      assert.strictEqual(post.tags[0].id, t3.id);
      post.author = 'someone';
      assert.strictEqual(post.author, 'someone', 'staged as given');
      await post.save();
      assert.strictEqual(post.author.id, 'someone');
      // The target gone: null, from the Reference and from populate().
      await db.Author.delete(author.id);
      const again = await db.Post.insert({ title: 'q', author: author.id, tags: [] });
      assert.strictEqual(await again.author.document(), null);
      assert.strictEqual(await again.populate('author'), null);
      // A cursor populates a page in one read per field: the record under its id, null where gone.
      const rows = await db.Post.select({ title: 'p' }).populate(['tags', 'author']).fetch();
      assert.deepStrictEqual(rows[0].tags, [{ id: t3.id, n: 't3', $type: 'Tag' }]);
      assert.strictEqual(rows[0].author, null);
      assert.strictEqual(rows[0].plain, author.id);
      assert.throws(() => db.Post.select().populate(['plain']), TypeError);
      assert.throws(() => db.Post.select().populate([]), TypeError);
      // Derived from the schema's relations.
      const memo = await db.Memo.insert({ author: t1.id, tags: [t1.id], title: 'm' });
      assert.strictEqual(memo.author.id, t1.id);
      assert.strictEqual(memo.tags[0].id, t1.id);
      assert.strictEqual(typeof memo.title, 'string');
      assert.deepStrictEqual((await db.Memo.select().populate(['tags']).one()).tags, [
        { id: t1.id, n: 't1', $type: 'Tag' },
      ]);
      // Defined after the open, the relation names a collection that is there.
      await db.addCollections({ Note: { schema: { fields: { post: 'Post' } }, validate: false } });
      const note = await db.Note.insert({ post: post.id });
      assert.strictEqual((await note.populate('post')).title, 'p');
    },
  );

  await t.test(
    'methods are bound to every Document of the collection and statics to the collection; a clash is refused',
    async (t2) => {
      const schema = {
        entities: {
          Post: {
            methods: {
              shout() {
                return this.title.toUpperCase();
              },
              async bump() {
                await this.inc('hits', 1);
                return this.hits;
              },
            },
            statics: {
              latest() {
                return this.select().desc('n').one();
              },
            },
          },
        },
      };
      const db = await createStorage(t2, 'A', { fsi: memory(), schema });
      const post = await db.Post.insert({ title: 'hi', n: 1 });
      assert.strictEqual(post.shout(), 'HI');
      assert.strictEqual(await post.bump(), 1);
      assert.deepStrictEqual(Object.keys(post), ['title', 'n', '$type', 'hits'], 'a method is no field');
      assert.deepStrictEqual(await post.data(), { title: 'hi', n: 1, $type: 'Post', hits: 1 });
      const { shout } = post;
      assert.strictEqual(shout(), 'HI', 'bound');
      await db.Post.insert({ title: 'yo', n: 2 });
      assert.strictEqual((await db.Post.latest()).title, 'yo');
      assert.strictEqual(Object.keys(db.Post).length, 0, 'a static is no field');
      // The same Document after a refresh keeps its methods; one of another collection has none.
      await db.Post.update(post.id, { title: 'again' });
      assert.strictEqual(post.shout(), 'AGAIN');
      const other = await db.document(await db.insert({ title: 'x' }));
      assert.strictEqual(other.shout, undefined);
      // A name a Document or a Collection answers to already is refused where the definition is taken.
      await assert.rejects(db.addCollections({ Bad: { methods: { save() {} } } }), TypeError);
      await assert.rejects(db.addCollections({ Bad: { methods: { id() {} } } }), TypeError);
      await assert.rejects(db.addCollections({ Bad: { statics: { on() {} } } }), TypeError);
      await assert.rejects(db.addCollections({ Bad: { methods: { x: 1 } } }), TypeError);
      await assert.rejects(
        createStorage(t2, 'B', { fsi: memory(), schema: { entities: { P: { statics: { select() {} } } } } }),
        TypeError,
      );
    },
  );

  await t.test(
    'a collection hears each change of a record of its own once per landing, with the action the catalog decided',
    async (t2) => {
      const db = await createStorage(t2, 'A', { fsi: memory(), schema: { entities: { Post: {}, Tag: {} } } });
      const seen = [];
      db.Post.on('change', (event) => seen.push(['change', event.id, event.action]));
      db.Post.on('insert', (event) => seen.push(['insert', event.id]));
      db.Post.on('update', (event) => seen.push(['update', event.id]));
      db.Post.on('remove', (event) => seen.push(['remove', event.id]));
      const tags = [];
      db.Tag.on('change', (event) => tags.push(event.action));
      const id = (await db.Post.insert({ n: 1 })).id;
      await db.Post.update(id, { n: 2 });
      await db.inc(id, 'hits', 1);
      // Several ops on one record in one turn: one landing, one change.
      await db.transact(async (tx) => {
        await tx.update(id, { a: 1 });
        await tx.update(id, { b: 2 });
      });
      await db.Post.delete(id);
      const again = await db.insert({ $type: 'Post', x: 1 });
      await db.purge(again);
      const tag = (await db.Tag.insert({})).id;
      assert.deepStrictEqual(seen, [
        ['change', id, 'insert'],
        ['insert', id],
        ['change', id, 'update'],
        ['update', id],
        ['change', id, 'update'],
        ['update', id],
        ['change', id, 'update'],
        ['update', id],
        ['change', id, 'remove'],
        ['remove', id],
        ['change', again, 'insert'],
        ['insert', again],
        ['change', again, 'remove'],
        ['remove', again],
      ]);
      assert.deepStrictEqual(tags, ['insert']);
      // A revival is an insert again; a record of no collection is nobody's.
      await db.set(id, { back: true, $type: 'Post' });
      assert.deepStrictEqual(seen.at(-1), ['insert', id]);
      await db.insert({ loose: true });
      assert.strictEqual(seen.length, 16);
      // The catalog's listener goes with the last listener.
      db.Post.clear();
      await db.Post.update(id, { n: 3 });
      assert.strictEqual(seen.length, 16);
      db.Tag.off('change');
      await db.Tag.delete(tag);
      assert.deepStrictEqual(tags, ['insert']);
      // A throwing listener is contained.
      db.Post.on('update', () => {
        throw new Error('boom');
      });
      await db.Post.update(id, { n: 4 });
      assert.strictEqual((await db.Post.get(id)).n, 4);
    },
  );

  await t.test('collection.remove() replicates as tombstones, or as purges scrubbed from every log', async (t2) => {
    const schema = { entities: { Post: {}, Tag: {} } };
    const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage, {
      nodes: { A: { fsi: memory(), schema }, B: { fsi: memory(), schema } },
    });
    const a = mesh.get('A');
    const b = mesh.get('B');
    const posts = [];
    for (let i = 0; i < 1203; i++) posts.push((await a.Post.insert({ i })).id);
    const sealed = await a.insert({ $type: 'Post', secret: true }, { encrypted: true });
    const tags = [(await a.Tag.insert({})).id, (await a.Tag.insert({})).id];
    await settle([a, b]);
    assert.strictEqual(await b.Post.count(), 1203);
    const turns = [];
    a.on('transaction', (event) => turns.push(event.ops.length));
    assert.deepStrictEqual(await a.Post.remove(), { removed: 1204 });
    // Pages of 500, each one turn; the encrypted record on its own (it has no op).
    assert.deepStrictEqual(turns, [500, 500, 203]);
    assert.strictEqual(await a.Post.count(), 0);
    assert.strictEqual(a.hasRecord(sealed), false);
    assert.strictEqual(await a.Tag.count(), 2, 'the other collection stays');
    assert.ok(a.Post, 'the definition stays');
    await settle([a, b]);
    assert.strictEqual(await b.Post.count(), 0);
    assert.strictEqual(await b.get(posts[0]), null);
    assert.ok(b.log.entriesOf(posts[0]).length > 0, 'tombstones, replicated');
    // Purged: the ops scrubbed here and on the peer.
    assert.deepStrictEqual(await a.Tag.remove({ purge: true }), { removed: 2 });
    await settle([a, b]);
    assert.strictEqual(await b.Tag.count(), 0);
    for (const id of tags) {
      assert.ok(
        a.log.entriesOf(id).every((entry) => entry.scrubbed),
        'scrubbed here',
      );
      assert.ok(
        b.log.entriesOf(id).every((entry) => entry.scrubbed),
        'scrubbed there',
      );
      assert.strictEqual(await b.get(id), null);
    }
    // A record written after the purge of its id stays purged everywhere.
    await b.set(tags[0], { back: true, $type: 'Tag' });
    await settle([a, b]);
    assert.strictEqual(await a.get(tags[0]), null);
    assert.deepStrictEqual(await a.Post.remove(), { removed: 0 });
  });

  await t.test(
    'drop() and dropDatabase() take every store away; an open database is LOCKED, not emptied',
    async (t2) => {
      const fsi = memory();
      const schema = { entities: { Post: {} } };
      let db = await createStorage(t2, 'A', { fsi, schema });
      const { path, nodeId } = db;
      await db.Post.insert({ a: 1 });
      if (db.plugins.includes('versions')) await db.tag('v1');
      await db.Post.insert({ a: 2 });
      const { dropDatabase } = db.plugins.includes('signing')
        ? require('../../src/all/all.js')
        : require('../../index.js');
      await assert.rejects(dropDatabase(path, { fsi }), { code: 'LOCKED' });
      assert.strictEqual(await db.Post.count(), 2, 'nothing emptied under the lock');
      await db.drop();
      assert.strictEqual(Object.keys(fsi.dump()).filter((key) => key.startsWith(`${path}/`)).length, 0, 'nothing left');
      // A new node at the path: nothing of the old one, another identity.
      db = await createStorage(t2, 'A', { fsi, schema });
      assert.notStrictEqual(db.nodeId, nodeId);
      assert.strictEqual(await db.Post.count(), 0);
      await db.Post.insert({ b: 1 });
      await db.close();
      await dropDatabase(path, { fsi });
      assert.strictEqual(Object.keys(fsi.dump()).filter((key) => key.startsWith(`${path}/`)).length, 0);
      await dropDatabase(path, { fsi });
      // A directory that holds no database — a stray file, or records with no identity — is not ours to empty.
      await fsi.write('/stray', 'thesis.docx', 'x');
      await assert.rejects(dropDatabase('/stray', { fsi }), /no database at/);
      assert.strictEqual(await fsi.exists('/stray', 'thesis.docx'), true, 'left as it was');
      await fsi.write('/loose/data', 'x.json', '{}');
      await assert.rejects(dropDatabase('/loose', { fsi }), /no database at/);
      await assert.rejects(dropDatabase('', { fsi }), TypeError);
      await assert.rejects(dropDatabase(path, { fsi, engine: db.engine }), TypeError);
    },
  );

  await t.test('findByIds() reads many records in one call: live ones of the collection, by id', async (t2) => {
    const fsi = memory();
    let reads = 0;
    const counting = {
      read: (dir, name) => {
        if (dir.endsWith('/data')) reads++;
        return fsi.read(dir, name);
      },
      write: (dir, name, content, options) => fsi.write(dir, name, content, options),
      exists: (dir, name) => fsi.exists(dir, name),
      remove: (dir, name) => fsi.remove(dir, name),
      list: (dir) => fsi.list(dir),
    };
    const db = await createStorage(t2, 'A', {
      fsi: counting,
      schema: { entities: { Post: {}, Tag: {} } },
      cache: { max: 2 },
    });
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await db.insert({ $type: 'Post', i }));
    const tag = (await db.Tag.insert({})).id;
    await db.Post.delete(ids[1]);
    reads = 0;
    const found = await db.Post.findByIds([ids[0], ids[1], 'nope', tag, ids[2], ids[0], ids[3]]);
    assert.deepStrictEqual([...found.keys()], [ids[0], ids[2], ids[3]]);
    assert.deepStrictEqual(found.get(ids[2]), { i: 2, $type: 'Post' });
    assert.ok(reads <= 4, `one read of the engine for the ones not cached (${reads})`);
    assert.deepStrictEqual(await db.Post.findByIds([]), new Map());
    await assert.rejects(db.Post.findByIds('x'), TypeError);
    // A copy: editing it changes nothing.
    found.get(ids[0]).i = 99;
    assert.deepStrictEqual(await db.Post.get(ids[0]), { i: 0, $type: 'Post' });
  });

  await t.test('a write through the database from inside transact() is IN_TRANSACTION, not a deadlock', async (t2) => {
    const db = await createStorage(t2, 'A', { fsi: memory(), schema: { entities: { Post: {} } } });
    const id = (await db.Post.insert({ n: 1 })).id;
    const seen = await db.transact(async (tx) => {
      await tx.update(id, { n: 2 });
      return [
        await code(db.update(id, { n: 3 })),
        await code(db.Post.insert({ n: 9 })),
        await code(db.transact(() => {})),
      ];
    });
    assert.deepStrictEqual(seen, ['IN_TRANSACTION', 'IN_TRANSACTION', 'IN_TRANSACTION']);
    assert.deepStrictEqual(await db.Post.get(id), { n: 2, $type: 'Post' });
    // After the transaction the queue is free again.
    await db.update(id, { n: 3 });
    assert.strictEqual((await db.Post.get(id)).n, 3);
  });

  await t.test(
    'addCollections() defines a collection after the open and indexes the records of its type',
    async (t2) => {
      const fsi = memory();
      const db = await createStorage(t2, 'A', { fsi, schema: { entities: { Post: {} } } });
      assert.deepStrictEqual(Object.keys(db.collections), ['Post']);
      // Records of a type no definition names yet: untyped, but of the type.
      const a = await db.insert({ $type: 'Tag', name: 'a', n: 1 });
      const b = await db.insert({ $type: 'Tag', name: 'b', n: 2 });
      await db.insert({ $type: 'Tag', name: 'c', n: 2 });
      await db.addCollections({ Tag: { index: ['n'], unique: ['name'] } });
      assert.deepStrictEqual(Object.keys(db.collections), ['Post', 'Tag']);
      assert.strictEqual(db.collections.Tag, db.Tag);
      // Indexed: an equality on `n` narrows to the posting list — and finds the two.
      const rows = await db.Tag.select({ n: 2 }).order('name').projection(['name']).fetch();
      assert.deepStrictEqual(
        rows.map((row) => row.name),
        ['b', 'c'],
      );
      assert.strictEqual(await db.Tag.count(), 3);
      // The unique key is in force at once, over the records that were there.
      assert.strictEqual(await code(db.Tag.insert({ name: 'a', n: 9 })), 'VALIDATION_FAILED');
      assert.deepStrictEqual(await db.Tag.get(a), { $type: 'Tag', name: 'a', n: 1 });
      assert.deepStrictEqual(await db.Tag.get(b), { $type: 'Tag', name: 'b', n: 2 });
      // The definition is the plugin's: every key is checked, nothing of a bad batch is taken.
      assert.strictEqual(await code(db.addCollections({ Note: { index: 'title' }, Memo: {} })), 'TypeError');
      assert.deepStrictEqual(Object.keys(db.collections), ['Post', 'Tag']);
      assert.strictEqual(await code(db.addCollections({ Tag: {} })), 'TypeError', 'defined already');
      assert.strictEqual(await code(db.addCollections({ close: {} })), 'TypeError', 'a name of the database');
      assert.strictEqual(await code(db.addCollections([])), 'TypeError');
    },
  );

  await t.test('removeCollection() forgets the definition and keeps the records', async (t2) => {
    const fsi = memory();
    const db = await createStorage(t2, 'A', { fsi, schema: { entities: { Post: { index: ['kind'] } } } });
    const id = (await db.Post.insert({ kind: 'k', title: 'x' })).id;
    const before = db.collections;
    db.removeCollection('Post');
    assert.strictEqual(db.Post, undefined);
    assert.deepStrictEqual(Object.keys(db.collections), []);
    assert.ok(Object.isFrozen(db.collections));
    assert.deepStrictEqual(Object.keys(before), ['Post'], 'the object handed out before is as it was');
    assert.deepStrictEqual(await db.get(id), { kind: 'k', title: 'x', $type: 'Post' });
    assert.throws(() => db.removeCollection('Post'), TypeError);
    // Defined again: indexed again, from the records.
    await db.addCollections({ Post: { index: ['kind'] } });
    assert.strictEqual(await db.Post.count({ kind: 'k' }), 1);
  });

  await t.test(
    'a reopen under fewer definitions rebuilds the catalog, and the collection added again reads what was written',
    async (t2) => {
      const fsi = memory();
      let db = await createStorage(t2, 'A', { fsi, schema: { entities: { Post: {} } } });
      await db.addCollections({ Tag: { index: ['n'] } });
      const ids = [];
      for (let i = 0; i < 20; i++) ids.push((await db.Tag.insert({ n: i % 3 })).id);
      await db.close();
      db = await createStorage(t2, 'A', { fsi, schema: { entities: { Post: {} } } });
      assert.strictEqual(db.Tag, undefined);
      assert.strictEqual((await db.list()).length, 20);
      await db.addCollections({ Tag: { index: ['n'] } });
      assert.strictEqual(await db.Tag.count({ n: 1 }), 7);
      assert.strictEqual(await db.Tag.count(), 20);
      const row = await db.Tag.select({ n: 2 }).order('id').one();
      assert.ok(ids.includes(row.id));
    },
  );
};

module.exports = { runCollectionTests };
