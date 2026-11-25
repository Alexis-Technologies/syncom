'use strict';

// Collections through the database, against whichever half the caller
// builds: definitions added and removed after the open, bulk writes, upserts,
// `modify()`, the update operators, writes by query, a delete that carries
// data, declared references, ORM methods and the collection events.
// `createStorage(t, name, options)` gives the SAME directory for the same
// name within one subtest (reopen cases).

const { it } = require('node:test');
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

const runCollectionTests = (assert, createStorage) => {
  it('should keep a bulk insert into an entity with a unique key linear in the batch', async (t2) => {
    const schema = { entities: { Post: { unique: ['slug'] }, Note: {} } };
    const db = await createStorage(t2, 'A', { fsi: memory(), schema });
    const rows = (prefix, n) => {
      const out = [];
      for (let i = 0; i < n; i++) out.push({ slug: `${prefix}${i}` });
      return out;
    };
    const timed = async (run) => {
      const t0 = performance.now();
      await run();
      return performance.now() - t0;
    };
    // The same batch twice, once into a collection with a unique key: a scan
    // of every row of the transaction per row made the second one quadratic
    // (4 000 rows in 1.8 s against 0.16 s without the key).
    const N = 3000;
    await db.Note.bulkInsert(rows('w', 50));
    await db.Post.bulkInsert(rows('w', 50));
    const plain = await timed(() => db.Note.bulkInsert(rows('n', N)));
    const unique = await timed(() => db.Post.bulkInsert(rows('p', N)));
    t2.diagnostic(`with a unique key ${unique.toFixed(0)} ms, without ${plain.toFixed(0)} ms`);
    assert.ok(unique < plain * 2 + 150, `with a unique key ${unique.toFixed(0)} ms, without ${plain.toFixed(0)} ms`);
    // Two batches in flight together: the second is checked against the first's
    // rows while they land — by their keys, not a scan of every one per row.
    const twin = await timed(() => Promise.all([db.Post.bulkInsert(rows('q', N)), db.Post.bulkInsert(rows('r', N))]));
    t2.diagnostic(`two batches in flight together ${twin.toFixed(0)} ms`);
    assert.ok(
      twin < plain * 4 + 300,
      `two batches in flight together ${twin.toFixed(0)} ms, one without a key ${plain.toFixed(0)} ms`,
    );
    // And the key is still checked inside the batch and against the catalog.
    const dup = await db.Post.bulkInsert([{ slug: 'd1' }, { slug: 'd1' }, { slug: 'p7' }]);
    assert.strictEqual(dup.success.length, 1);
    assert.deepStrictEqual(
      dup.error.map(({ index, error }) => [index, error.code, error.issues[0].conflict === null]),
      [
        [1, 'ALX_ERR_VALIDATION_FAILED', false],
        [2, 'ALX_ERR_VALIDATION_FAILED', false],
      ],
    );
    // Inside one transaction a key follows the record's newest op: taken by
    // the first row, refused to the second, free again once the first moved on.
    await db.transact(async (tx) => {
      await tx.insert({ $type: 'Post', id: 'b1', slug: 'fresh' });
      const refused = await tx.insert({ $type: 'Post', id: 'b2', slug: 'fresh' }).then(
        () => null,
        (error) => error,
      );
      assert.strictEqual(refused.code, 'ALX_ERR_VALIDATION_FAILED');
      assert.strictEqual(refused.issues[0].conflict, 'b1');
      await tx.update('b1', { slug: 'moved' });
      await tx.insert({ $type: 'Post', id: 'b3', slug: 'fresh' });
    });
    assert.strictEqual((await db.Post.get('b1')).slug, 'moved');
    assert.strictEqual((await db.Post.get('b3')).slug, 'fresh');
    assert.strictEqual(await db.Post.get('b2'), null);
  });
  it('should run bulkInsert(), bulkUpsert() and bulkRemove() as one transaction with a verdict per row: a refused row stays out, the rest land, a failed batch lands nothing', async (t2) => {
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
        [1, null, 'ALX_ERR_VALIDATION_FAILED'],
        [2, 'p1', 'ALX_ERR_EXISTS'],
        [3, null, 'ALX_ERR_INVALID_ARGUMENT'],
        [4, null, 'ALX_ERR_VALIDATION_FAILED'],
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
    assert.strictEqual(upserted.error[0].error.code, 'ALX_ERR_INVALID_ID');
    assert.deepStrictEqual(await db.Post.get('p2'), { slug: 'dd', n: 1, $type: 'Post' });
    const other = await db.insert({ $type: 'Other' });
    const removed = await db.Post.bulkRemove(['p2', 'nope', other, 'p1']);
    assert.deepStrictEqual(removed.success, ['p2', 'p1']);
    assert.deepStrictEqual(
      removed.error.map(({ index, error }) => [index, error.code]),
      [
        [1, 'ALX_ERR_NOT_FOUND'],
        [2, 'ALX_ERR_NOT_FOUND'],
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
  });

  it('should name a record by its data: insert() takes the id field as the id, EXISTS for a live one, upsert() and insertIfAbsent() write by it', async (t2) => {
    const db = await createStorage(t2, 'A', {
      fsi: memory(),
      schema: { entities: { Post: {}, Note: { idField: 'noteId' } } },
    });
    const post = await db.Post.insert({ id: 'p1', title: 'a' });
    assert.strictEqual(post.id, 'p1');
    assert.deepStrictEqual(await db.get('p1'), { title: 'a', $type: 'Post' }, 'the id field leaves the data');
    assert.strictEqual(await code(db.Post.insert({ id: 'p1', title: 'b' })), 'ALX_ERR_EXISTS');
    assert.strictEqual(await code(db.insert({ $type: 'Post', id: 'p1' })), 'ALX_ERR_EXISTS');
    assert.strictEqual(await code(db.transact((tx) => tx.insert({ $type: 'Post', id: 'p1' }))), 'ALX_ERR_EXISTS');
    assert.strictEqual(await code(db.Post.insert({ id: 'bad id' })), 'ALX_ERR_INVALID_ID');
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
    assert.strictEqual(await code(db.Post.upsert({ title: 'no id' })), 'ALX_ERR_INVALID_ID');
    const kept = await db.Post.insertIfAbsent({ id: 'p1', title: 'z' });
    assert.strictEqual(kept.title, 'b');
    const made = await db.Post.insertIfAbsent({ id: 'p10', title: 'z' });
    assert.strictEqual(made.title, 'z');
    // A deleted record is not there: insert() and insertIfAbsent() write it again.
    await db.Post.delete('p9');
    await db.Post.insert({ id: 'p9', title: 'again' });
    assert.deepStrictEqual(await db.Post.get('p9'), { title: 'again', $type: 'Post' });
    assert.strictEqual(await code(db.Note.insertIfAbsent({ noteId: 'n1' })), null);
  });

  it('should derive a composite id from the declared fields once, and refuse a value outside the id class as INVALID_ID', async (t2) => {
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
    assert.strictEqual(await code(db.Line.insert({ orgId: 'o1', n: 3 })), 'ALX_ERR_EXISTS');
    assert.strictEqual(await code(db.Line.insert({ orgId: 'o1' })), 'ALX_ERR_INVALID_ID', 'a field missing');
    assert.strictEqual(await code(db.Line.insert({ orgId: 'o 1', n: 1 })), 'ALX_ERR_INVALID_ID', 'outside the class');
    assert.strictEqual(await code(db.insert({ $type: 'Line', orgId: 'o/1', n: 1 })), 'ALX_ERR_INVALID_ID');
    // upsert, insertIfAbsent and the bulk writes derive it the same way.
    await db.Line.upsert({ orgId: 'o1', n: 3, text: 'y' });
    assert.strictEqual((await db.Line.get('o1-3')).text, 'y');
    assert.strictEqual((await db.Line.insertIfAbsent({ orgId: 'o1', n: 3, text: 'z' })).text, 'y');
    const bulk = await db.Line.bulkInsert([{ orgId: 'o2', n: 1 }, { orgId: 'o2' }, { orgId: 'o1', n: 3 }]);
    assert.deepStrictEqual(bulk.success, ['o2-1']);
    assert.deepStrictEqual(
      bulk.error.map(({ error }) => error.code),
      ['ALX_ERR_INVALID_ID', 'ALX_ERR_EXISTS'],
    );
    // The definition is checked: a separator outside the class, no fields.
    await assert.rejects(db.addCollections({ Bad: { id: { fields: ['a'], separator: '|' } } }), TypeError);
    await assert.rejects(db.addCollections({ Bad: { id: { fields: [] } } }), TypeError);
  });

  it('should run fn over the record inside the queue in modify(fn) and write the difference: two in parallel compose, a counter field is FIELD_KIND, null deletes', async (t2) => {
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
    assert.strictEqual(await code(db.modify(id, (doc) => void (doc.hits = 9))), 'ALX_ERR_FIELD_KIND');
    assert.strictEqual((await db.get(id)).hits, 1);
    // What a function may return; a write through the database from inside it; a foreign record.
    assert.strictEqual(await code(db.modify(id, () => 5)), 'ALX_ERR_INVALID_ARGUMENT');
    // The browser half has no async context: a write from inside the function would wait for the queue it holds.
    if (createStorage.browser !== true) {
      assert.strictEqual(await code(db.modify(id, () => db.update(id, { x: 1 }))), 'ALX_ERR_IN_TRANSACTION');
    }
    assert.strictEqual(await code(db.modify(id, 'nope')), 'ALX_ERR_INVALID_ARGUMENT');
    const other = await db.insert({ $type: 'Other' });
    assert.strictEqual(await code(db.Post.modify(other, () => {})), 'ALX_ERR_NOT_FOUND');
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
    assert.strictEqual(await code(db.modify(id, () => {})), 'ALX_ERR_NOT_FOUND');
  });

  it('should apply an update operator by the kind of its field and refuse the rest, as one transaction; ifMatch writes only where the record matches', async (t2) => {
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
      $min: { n: 0 },
      $max: { m: 0 },
      $rename: { title: 'name' },
      $unset: ['gone'],
      $set: { z: 1 },
    });
    assert.deepStrictEqual(await db.get(id), {
      n: 0,
      m: 0,
      tags: [],
      arr: [1, 2, 3],
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
    // Two operators naming one field are a conflict, refused whole; one at a time, each goes.
    assert.strictEqual(
      await code(db.update(id, { $addToSet: { arr: 9 }, $pop: { arr: 1 } })),
      'ALX_ERR_INVALID_ARGUMENT',
    );
    assert.deepStrictEqual((await db.get(id)).arr, [1, 2, 3]);
    await db.Post.update(id, { $pop: { arr: -1 } });
    assert.deepStrictEqual((await db.get(id)).arr, [2, 3]);
    assert.strictEqual(
      await code(db.update(id, { $rename: { hits: 'count' } })),
      'ALX_ERR_INVALID_ARGUMENT',
      'a counter is not renamed',
    );
    // A kind refuses what is not its own: the whole update, nothing of it written.
    assert.strictEqual(await code(db.update(id, { $inc: { name: 1 }, $set: { k: 1 } })), 'ALX_ERR_FIELD_KIND');
    assert.strictEqual(await code(db.update(id, { $addToSet: { hits: 1 } })), 'ALX_ERR_FIELD_KIND');
    assert.strictEqual(await code(db.update(id, { $push: { hits: 1 } })), 'ALX_ERR_FIELD_KIND');
    assert.strictEqual((await db.get(id)).k, undefined);
    assert.strictEqual(
      await code(db.update(id, { $set: { a: 1 }, b: 2 })),
      'ALX_ERR_INVALID_ARGUMENT',
      'operators or fields',
    );
    assert.strictEqual(await code(db.Post.update(id, { $set: { $type: 'X' } })), 'ALX_ERR_INVALID_ARGUMENT');
    assert.strictEqual(await code(db.update('nope', { $set: { a: 1 } })), 'ALX_ERR_NOT_FOUND');
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
    assert.strictEqual(await code(db.update(id, { m: 3 }, { ifMatch: { $nope: 1 } })), 'ALX_ERR_INVALID_ARGUMENT');
    assert.strictEqual(await db.transact((tx) => tx.update(id, { m: 3 }, { ifMatch: { m: 1 } })), true);
  });

  it("should run a cursor's update(), modify() and delete() as one transaction over the matches, each matched again inside the queue", async (t2) => {
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
  });

  it('should refuse a composite id value that holds the separator or is of another kind, and keep its fields immutable', async (t2) => {
    const schema = { entities: { Cell: { id: { fields: ['x', 'y'] } } } };
    const db = await createStorage(t2, 'A', { fsi: memory(), schema });
    const codeOf = (promise) =>
      promise.then(
        () => null,
        (error) => error.code,
      );
    // `a.b` + `c` and `a` + `b.c` would be one id: a value that holds the separator is refused.
    assert.strictEqual(await codeOf(db.Cell.insert({ x: 'a.b', y: 'c' })), 'ALX_ERR_INVALID_ID');
    assert.strictEqual(await codeOf(db.Cell.insert({ x: 'a', y: 'b.c' })), 'ALX_ERR_INVALID_ID');
    assert.strictEqual(await codeOf(db.Cell.upsert({ x: 'a.b', y: 'c' })), 'ALX_ERR_INVALID_ID');
    assert.strictEqual(await codeOf(db.insert({ $type: 'Cell', x: 'a', y: 'b.c' })), 'ALX_ERR_INVALID_ID');
    assert.strictEqual(await codeOf(db.Cell.insert({ x: { nested: 1 }, y: 'c' })), 'ALX_ERR_INVALID_ID', 'an object');
    assert.strictEqual(await codeOf(db.Cell.insert({ x: true, y: 'c' })), null, 'a boolean reads as text');
    const cell = await db.Cell.insert({ x: 'a', y: 1, v: 0 });
    assert.strictEqual(cell.id, 'a.1');
    // The fields the id is derived from never change: not by a set, an operator, a function or an unset.
    assert.strictEqual(await codeOf(db.Cell.update(cell.id, { x: 'b' })), 'ALX_ERR_ID_IMMUTABLE');
    assert.strictEqual(await codeOf(db.Cell.update(cell.id, { $set: { y: 2 } })), 'ALX_ERR_ID_IMMUTABLE');
    assert.strictEqual(await codeOf(db.Cell.update(cell.id, { $rename: { x: 'z' } })), 'ALX_ERR_ID_IMMUTABLE');
    assert.strictEqual(await codeOf(db.Cell.modify(cell.id, (doc) => void (doc.y = 3))), 'ALX_ERR_ID_IMMUTABLE');
    assert.strictEqual(await codeOf(db.unset(cell.id, ['x'])), 'ALX_ERR_ID_IMMUTABLE');
    assert.strictEqual(await codeOf(db.transact((tx) => tx.update(cell.id, { x: 'q' }))), 'ALX_ERR_ID_IMMUTABLE');
    // The same values, as text, pass; the other fields change freely.
    await db.Cell.update(cell.id, { x: 'a', y: '1', v: 1 });
    await db.Cell.update(cell.id, { $set: { v: 2 } });
    assert.deepStrictEqual(await db.get(cell.id), { x: 'a', y: '1', v: 2, $type: 'Cell' });
    // A live record under the named id is ALX_ERR_EXISTS whichever way it is written — an encrypted write too.
    assert.strictEqual(await codeOf(db.Cell.insert({ x: 'a', y: 1 })), 'ALX_ERR_EXISTS');
    assert.strictEqual(await codeOf(db.Cell.insert({ x: 'a', y: 1 }, { encrypted: true })), 'ALX_ERR_EXISTS');
    assert.deepStrictEqual(await db.get(cell.id), { x: 'a', y: '1', v: 2, $type: 'Cell' }, 'untouched');
  });

  it('should keep $type immutable through unset, $unset, $rename and modify', async (t2) => {
    const db = await createStorage(t2, 'A', { fsi: memory(), schema: { entities: { Post: {}, Other: {} } } });
    const codeOf = (promise) =>
      promise.then(
        () => null,
        (error) => error.code,
      );
    const id = (await db.Post.insert({ title: 'x' })).id;
    assert.strictEqual(await codeOf(db.unset(id, ['$type'])), 'ALX_ERR_TYPE_IMMUTABLE');
    assert.strictEqual(await codeOf(db.update(id, { $unset: ['$type'] })), 'ALX_ERR_TYPE_IMMUTABLE');
    assert.strictEqual(await codeOf(db.update(id, { $rename: { $type: 'kind' } })), 'ALX_ERR_TYPE_IMMUTABLE');
    assert.strictEqual(await codeOf(db.update(id, { $set: { $type: 'Other' } })), 'ALX_ERR_TYPE_IMMUTABLE');
    assert.strictEqual(await codeOf(db.modify(id, () => ({ title: 'y', $type: 'Other' }))), 'ALX_ERR_TYPE_IMMUTABLE');
    // A function that leaves $type out keeps it: the collection is not the function's to change.
    assert.deepStrictEqual(await db.modify(id, () => ({ title: 'z' })), { title: 'z', $type: 'Post' });
    assert.deepStrictEqual(await db.get(id), { title: 'z', $type: 'Post' });
    assert.strictEqual(await db.Post.count(), 1);
    assert.strictEqual(await db.Other.count(), 0);
  });

  it('should never name another record by a data field named id: writes by query and ifMatch go by the record’s id', async (t2) => {
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
  });

  it('should resolve a reference within the declared collection alone, and hold in a Document a copy of a reference field’s value', async (t2) => {
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
  });

  it('should leave the record dead everywhere and the data on the tombstone after delete(id, { data })', async (t2) => {
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
    // Delete wins: a field op on the deleted record is ALX_ERR_NOT_FOUND here, as update() is; a whole-record write
    // revives it as it writes it — the tombstone's data below it goes, as under any reset.
    await assert.rejects(b.add(id, 'tags', ['t']), { code: 'ALX_ERR_NOT_FOUND' });
    await assert.rejects(b.inc(id, 'n', 1), { code: 'ALX_ERR_NOT_FOUND' });
    await assert.rejects(b.remove(id, 'tags', ['t']), { code: 'ALX_ERR_NOT_FOUND' });
    await assert.rejects(b.unset(id, 'by'), { code: 'ALX_ERR_NOT_FOUND' });
    await assert.rejects(b.update(id, { n: 2 }), { code: 'ALX_ERR_NOT_FOUND' });
    await b.set(id, { title: 'back' });
    await settle([a, b]);
    assert.deepStrictEqual(await a.get(id), { title: 'back' });
    assert.deepStrictEqual(await b.get(id), await a.get(id));
    await assert.rejects(a.delete(id, { data: 5 }), TypeError);
    // Without data: as before.
    await a.delete(id);
    await settle([a, b]);
    assert.strictEqual(await b.get(id), null);
    assert.deepStrictEqual(changes.at(-1), { action: 'delete' });
  });

  it('should read a Reference only where a reference is declared, resolve a target gone to null, and hand the records from populate()', async (t2) => {
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
  });

  it('should bind methods to every Document of the collection and statics to the collection, and refuse a clash', async (t2) => {
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
  });

  it('should let a collection hear each change of a record of its own once per landing, with the action the catalog decided', async (t2) => {
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
    // A peer's field op stamped above the tombstone leaves the record dead (delete wins): no event.
    const late = { origin: 'peer', seq: 1, ts: Date.now() + 1000, type: 'set', id, data: { late: true } };
    await db.applyRemote([late]);
    assert.strictEqual(seen.length, 14);
    assert.strictEqual(await db.Post.get(id), null);
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
  });

  it('should fire collection events outside the write, after the row is in the catalog, and let the subscription go on once() and off()', async (t2) => {
    const db = await createStorage(t2, 'A', { fsi: memory(), schema: { entities: { Post: {} } } });
    const seen = [];
    db.Post.once('insert', (event) => seen.push(['once', event.id, db.hasRecord(event.id)]));
    const a = (await db.Post.insert({ n: 1 })).id;
    assert.deepStrictEqual(seen, [['once', a, true]], 'the row is in the catalog when the listener hears');
    await db.Post.insert({ n: 2 });
    assert.strictEqual(seen.length, 1, 'a once() fired is gone');
    const heard = (event) => seen.push(['on', event.id]);
    db.Post.on('update', heard);
    await db.Post.update(a, { n: 3 });
    assert.deepStrictEqual(seen.at(-1), ['on', a]);
    db.Post.off('update', heard);
    await db.Post.update(a, { n: 4 });
    assert.strictEqual(seen.length, 2, 'off(event, listener) and nothing is heard');
    // A listener that is slow holds nothing: the write resolves, the listener runs after the landing, in order.
    const order = [];
    db.Post.on('update', () => {
      const until = Date.now() + 20;
      while (Date.now() < until);
      order.push('listener');
    });
    await db.Post.update(a, { n: 5 });
    order.push('resolved');
    assert.deepStrictEqual(order, ['listener', 'resolved']);
  });

  it('should keep the verdicts of a bulk write whose afterWrite hook fails after the rows landed, the failure being the error event', async (t2) => {
    const logged = [];
    const logger = { warn: (entry) => logged.push(entry.event), info() {}, debug() {}, error() {} };
    const db = await createStorage(t2, 'A', {
      fsi: memory(),
      logger,
      schema: { entities: { Post: {} } },
      hooks: {
        afterWrite: (ctx) => {
          if (ctx.id === 'b2') throw new Error('after');
        },
      },
    });
    const errors = [];
    db.on('error', (error) => errors.push([error.code, error.hook, error.cause.message]));
    const out = await db.Post.bulkInsert([{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }]);
    assert.deepStrictEqual(out, { success: ['b1', 'b2', 'b3'], error: [] });
    assert.strictEqual(await db.Post.count(), 3, 'every row landed');
    assert.deepStrictEqual(errors, [['ALX_ERR_HOOK_FAILED', 'afterWrite', 'after']]);
    assert.ok(logged.includes('hook.failed'));
  });

  it('should replicate collection.remove() as tombstones, or as purges scrubbed from every log', async (t2) => {
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

  it('should scrub with a purge of a page every log file holding it once, and take { purge, actor } and nothing else in remove()', async (t2) => {
    const fsi = memory();
    const logWrites = [];
    const counted = {
      read: (dir, name) => fsi.read(dir, name),
      write: (dir, name, content, options) => {
        if (dir.includes('log')) logWrites.push(name);
        return fsi.write(dir, name, content, options);
      },
      append: (dir, name, content) => {
        if (dir.includes('log')) logWrites.push(name);
        return fsi.append(dir, name, content);
      },
      exists: (dir, name) => fsi.exists(dir, name),
      remove: (dir, name) => fsi.remove(dir, name),
      list: (dir) => fsi.list(dir),
    };
    const db = await createStorage(t2, 'A', { fsi: counted, schema: { entities: { Post: {} } } });
    const rows = [];
    for (let i = 0; i < 600; i++) rows.push({ i });
    const inserted = await db.Post.bulkInsert(rows);
    await db.log.flush();
    await assert.rejects(db.Post.remove({ status: 'old' }), /takes \{ purge, actor \} and nothing else/);
    await assert.rejects(db.Post.remove(5), TypeError);
    assert.strictEqual(await db.Post.count(), 600, 'nothing removed by a refused call');
    logWrites.length = 0;
    assert.deepStrictEqual(await db.Post.remove({ purge: true }), { removed: 600 });
    // Two pages: each a purge transaction appended and the files holding its ids rewritten once — not once per id.
    assert.ok(logWrites.length < 40, `${logWrites.length} log writes for 600 purged records`);
    assert.strictEqual(await db.Post.count(), 0);
    for (let i = 0; i < inserted.success.length; i += 97) {
      assert.ok(
        db.log.entriesOf(inserted.success[i]).every((entry) => entry.scrubbed),
        'every op of a purged record scrubbed',
      );
    }
  });

  it('should throw a TypeError for a bulk write or a write by query of more than 10 000 rows before anything lands', async (t2) => {
    const db = await createStorage(t2, 'A', { fsi: memory(), schema: { entities: { Post: { index: ['i'] } } } });
    const rows = (n) => {
      const out = [];
      for (let i = 0; i < n; i++) out.push({ i });
      return out;
    };
    await assert.rejects(db.Post.bulkInsert(rows(10_001)), /at most 10000 rows in one transaction/);
    await assert.rejects(db.Post.bulkUpsert(rows(10_001)), TypeError);
    await assert.rejects(db.Post.bulkRemove(new Array(10_001).fill('x')), TypeError);
    assert.strictEqual(await db.Post.count(), 0, 'nothing landed');
    // Two batches within the bound: 10 002 records; a write by query over them all is refused, a limited one is not.
    await db.Post.bulkInsert(rows(5001));
    await db.Post.bulkInsert(rows(5001));
    assert.strictEqual(await db.Post.count(), 10_002);
    await assert.rejects(db.Post.select().update({ seen: true }), /10002 matches, at most 10000/);
    await assert.rejects(db.Post.select().delete(), TypeError);
    assert.strictEqual(await db.Post.select({ seen: true }).count(), 0, 'nothing landed');
    assert.deepStrictEqual(await db.Post.select({ i: 7 }).update({ seen: true }), { matched: 2, written: 2 });
    assert.deepStrictEqual(await db.Post.select().limit(10_000).delete(), { matched: 10_000, written: 10_000 });
    assert.strictEqual(await db.Post.count(), 2);
  });

  it('should take every store away with drop() and dropDatabase(), and refuse an open database as LOCKED, not emptied', async (t2) => {
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
    await assert.rejects(dropDatabase(path, { fsi }), { code: 'ALX_ERR_LOCKED' });
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
  });

  it('should read many records in one call with findByIds(): live ones of the collection, by id', async (t2) => {
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

  // The browser half has no async context (utils.browser.js `taskScope`): a write through the database from inside
  // `transact()` is not told apart there and would wait for the transaction that waits for it — documented, not run.
  const noContext = createStorage.browser === true && 'the browser half tells no write inside transact() apart';
  it(
    'should refuse a write through the database from inside transact() as IN_TRANSACTION, not a deadlock',
    { skip: noContext },
    async (t2) => {
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
      assert.deepStrictEqual(seen, ['ALX_ERR_IN_TRANSACTION', 'ALX_ERR_IN_TRANSACTION', 'ALX_ERR_IN_TRANSACTION']);
      assert.deepStrictEqual(await db.Post.get(id), { n: 2, $type: 'Post' });
      // After the transaction the queue is free again.
      await db.update(id, { n: 3 });
      assert.strictEqual((await db.Post.get(id)).n, 3);
      // A write scheduled inside the function and made after it is not inside it: the context follows the timer, the
      // frame it carries does not stay active.
      let later = null;
      await db.transact(async (tx) => {
        await tx.update(id, { n: 4 });
        later = new Promise((resolve) => {
          setTimeout(() => resolve(code(db.update(id, { n: 5 }))), 15);
        });
      });
      assert.strictEqual(await later, null, 'queued, not refused');
      assert.strictEqual((await db.Post.get(id)).n, 5);
    },
  );

  it('should define a collection after the open with addCollections() and index the records of its type', async (t2) => {
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
    assert.strictEqual(await code(db.Tag.insert({ name: 'a', n: 9 })), 'ALX_ERR_VALIDATION_FAILED');
    assert.deepStrictEqual(await db.Tag.get(a), { $type: 'Tag', name: 'a', n: 1 });
    assert.deepStrictEqual(await db.Tag.get(b), { $type: 'Tag', name: 'b', n: 2 });
    // The definition is the plugin's: every key is checked, nothing of a bad batch is taken.
    assert.strictEqual(
      await code(db.addCollections({ Note: { index: 'title' }, Memo: {} })),
      'ALX_ERR_INVALID_ARGUMENT',
    );
    assert.deepStrictEqual(Object.keys(db.collections), ['Post', 'Tag']);
    // A definition that needs a text index the database has not: refused before anything of the batch is taken.
    assert.strictEqual(
      await code(db.addCollections({ Memo: {}, Note: { search: ['title'] } })),
      'ALX_ERR_INVALID_ARGUMENT',
    );
    assert.deepStrictEqual(Object.keys(db.collections), ['Post', 'Tag']);
    assert.strictEqual(await code(db.Memo?.count() ?? Promise.reject(new TypeError('no Memo'))), 'TypeError');
    assert.strictEqual(await code(db.addCollections({ Tag: {} })), 'ALX_ERR_INVALID_ARGUMENT', 'defined already');
    assert.strictEqual(
      await code(db.addCollections({ close: {} })),
      'ALX_ERR_INVALID_ARGUMENT',
      'a name of the database',
    );
    assert.strictEqual(await code(db.addCollections([])), 'ALX_ERR_INVALID_ARGUMENT');
  });

  it('should plan a cursor made before addCollections() again under the new indexes, its cached result going with the old ones', async (t2) => {
    const db = await createStorage(t2, 'A', { fsi: memory(), schema: { entities: { Post: { index: ['kind'] } } } });
    for (let i = 0; i < 6; i++) await db.Post.insert({ kind: i % 2 ? 'a' : 'b', n: i });
    const cursor = db.Post.select({ kind: 'a' }).order('n');
    assert.deepStrictEqual(cursor.explain().index, ['kind']);
    assert.strictEqual(cursor.explain().sortedByIndex, false);
    const before = await cursor.fetch();
    assert.strictEqual(before.length, 3);
    // Defined anew, with another key: the retained cursor plans again, and reads the rows — never an empty
    // result cached under the old definitions, nor one the old plan would scan a dropped index for.
    db.removeCollection('Post');
    assert.strictEqual(cursor.explain().scan, 'collection', 'no definition: every record');
    assert.deepStrictEqual(await cursor.fetch(), before);
    await db.addCollections({ Post: { index: [['kind', 'n']] } });
    assert.deepStrictEqual(cursor.explain().index, ['kind', 'n'], 'planned again under the new index');
    assert.strictEqual(cursor.explain().sortedByIndex, true);
    assert.deepStrictEqual(await cursor.fetch(), before);
  });

  it('should index a large collection in pages inside the queue with addCollections(), with writes landing between them', async (t2) => {
    const db = await createStorage(t2, 'A', { fsi: memory(), schema: { entities: { Post: {} } } });
    for (let i = 0; i < 1100; i++) await db.insert({ $type: 'Tag', n: i % 10 });
    // A write made while the collection is being defined lands between two pages, indexed like the rest.
    const adding = db.addCollections({ Tag: { index: ['n'] } });
    const written = db.insert({ $type: 'Tag', n: 3 });
    await Promise.all([adding, written]);
    assert.strictEqual(db.Tag.select({ n: 3 }).explain().scan, 'index');
    assert.strictEqual(await db.Tag.count({ n: 3 }), 111);
    assert.strictEqual(await db.Tag.count(), 1101);
  });

  it('should forget the definition and keep the records on removeCollection()', async (t2) => {
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

  it('should rebuild the catalog on a reopen under fewer definitions, and read what was written in the collection added again', async (t2) => {
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
  });
};

module.exports = { runCollectionTests };
