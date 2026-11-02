'use strict';

// Collections through the database, against whichever half the caller
// builds: definitions added and removed after the open, bulk writes, upserts,
// `modify()`, the update operators, writes by query, a delete that carries
// data, declared references, ORM methods and the collection events.
// `createStorage(t, name, options)` gives the SAME directory for the same
// name within one subtest (reopen cases).

const { memory } = require('../../src/memory/memory.js');

const code = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error.code ?? error.name;
  }
  return null;
};

const runCollectionTests = async (t, assert, createStorage) => {
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
