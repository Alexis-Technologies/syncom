'use strict';

// The catalog in isolation: rows, posting lists, unique keys, what it says
// a query can only match, and the file it persists to.

const test = require('node:test');
const assert = require('node:assert');
const { Catalog, valueOf } = require('../src/catalog.js');
const { createMemoryFsi } = require('../src/backend.js');
const { normalizeSchema } = require('../src/schema.js');

const entitiesOf = (schema) => normalizeSchema(schema).entities;
const catalogOf = (schema, fsi = createMemoryFsi()) =>
  new Catalog({ fsi, path: 'store', entities: entitiesOf(schema) });

test('Catalog', async (t) => {
  const schema = {
    entities: {
      Post: { index: ['orgId', 'meta.kind'], unique: ['slug', ['orgId', 'name']] },
      Tag: {},
    },
  };

  await t.test('rows by id and by type; a put replaces, null removes', () => {
    const catalog = catalogOf(schema);
    catalog.put('p1', { type: 'Post', v: 1, data: { orgId: 'o1', slug: 'a', name: 'A', meta: { kind: 'k' } } });
    catalog.put('p2', { type: 'Post', v: 2, data: { orgId: 'o1', slug: 'b', name: 'B' } });
    catalog.put('t1', { type: 'Tag', v: null, data: { name: 't' } });
    catalog.put('x1', { v: null, data: { loose: true } });
    catalog.put('e1', { type: 'Post', encrypted: true });
    assert.strictEqual(catalog.size, 5);
    assert.deepStrictEqual(catalog.ids(), ['e1', 'p1', 'p2', 't1', 'x1']);
    assert.deepStrictEqual(catalog.ids('Post'), ['e1', 'p1', 'p2']);
    assert.deepStrictEqual(catalog.ids('Nope'), []);
    assert.deepStrictEqual(catalog.row('p1'), {
      type: 'Post',
      v: 1,
      encrypted: false,
      fields: { orgId: 'o1', 'meta.kind': 'k', slug: 'a', name: 'A' },
    });
    assert.deepStrictEqual(catalog.row('e1'), { type: 'Post', v: null, encrypted: true, fields: {} });
    assert.deepStrictEqual(catalog.row('x1').type, null);
    assert.strictEqual(catalog.row('nope'), null);
    assert.strictEqual(catalog.dirty, 5);
    catalog.put('p1', { type: 'Post', v: 2, data: { orgId: 'o2', slug: 'a' } });
    assert.deepStrictEqual(catalog.row('p1').fields, { orgId: 'o2', slug: 'a' });
    catalog.put('p2', null);
    catalog.put('never', null);
    assert.strictEqual(catalog.has('p2'), false);
    assert.deepStrictEqual(catalog.ids('Post'), ['e1', 'p1']);
    assert.deepStrictEqual(catalog.candidates('Post', { orgId: 'o1' }), new Set());
  });

  await t.test('an indexed array is posted under each element: a scalar narrows to the arrays holding it', () => {
    const tagged = catalogOf({ entities: { Issue: { index: ['tags'] } } });
    tagged.put('i1', { type: 'Issue', data: { tags: ['bug', 'ui'] } });
    tagged.put('i2', { type: 'Issue', data: { tags: ['ui'] } });
    tagged.put('i3', { type: 'Issue', data: { tags: 'bug' } });
    tagged.put('i4', { type: 'Issue', data: { tags: [['bug']] } });
    assert.deepStrictEqual(tagged.candidates('Issue', { tags: 'bug' }), new Set(['i1', 'i3']));
    assert.deepStrictEqual(tagged.candidates('Issue', { tags: 'ui' }), new Set(['i1', 'i2']));
    assert.deepStrictEqual(
      tagged.candidates('Issue', { tags: ['ui'] }),
      new Set(['i2']),
      'an array value: the whole array',
    );
    // A superset: the nested array's element shares the key with the value;
    // the predicate, not the catalog, decides.
    assert.deepStrictEqual(tagged.candidates('Issue', { tags: ['bug'] }), new Set(['i4']));
    assert.deepStrictEqual(tagged.candidates('Issue', { tags: { $in: ['bug', 'nope'] } }), new Set(['i1', 'i3']));
    tagged.put('i1', { type: 'Issue', data: { tags: ['ui'] } });
    assert.deepStrictEqual(
      tagged.candidates('Issue', { tags: 'bug' }),
      new Set(['i3']),
      'the old element posting is gone',
    );
    tagged.put('i3', null);
    assert.deepStrictEqual(tagged.candidates('Issue', { tags: 'bug' }), new Set());
    assert.deepStrictEqual(tagged.candidates('Issue', { tags: 'ui' }), new Set(['i1', 'i2']));
  });

  await t.test('candidates: the intersection of the indexed equalities a query names', () => {
    const catalog = catalogOf(schema);
    catalog.put('a', { type: 'Post', data: { orgId: 'o1', slug: 'a', meta: { kind: 'x' }, tags: ['t'] } });
    catalog.put('b', { type: 'Post', data: { orgId: 'o1', slug: 'b', meta: { kind: 'y' } } });
    catalog.put('c', { type: 'Post', data: { orgId: 'o2', slug: 'c', meta: { kind: 'x' } } });
    assert.deepStrictEqual(catalog.candidates('Post', { orgId: 'o1' }), new Set(['a', 'b']));
    assert.deepStrictEqual(catalog.candidates('Post', { orgId: { $eq: 'o2' } }), new Set(['c']));
    assert.deepStrictEqual(
      catalog.candidates('Post', { orgId: { $in: ['o1', 'o2', 'o9'] } }),
      new Set(['a', 'b', 'c']),
    );
    assert.deepStrictEqual(catalog.candidates('Post', { orgId: 'o1', 'meta.kind': 'x' }), new Set(['a']));
    assert.deepStrictEqual(catalog.candidates('Post', { slug: 'c' }), new Set(['c']), 'a unique field is indexed too');
    assert.deepStrictEqual(catalog.candidates('Post', { orgId: 'o1', slug: 'zzz' }), new Set());
    assert.strictEqual(catalog.candidates('Post', { title: 'x' }), null, 'no indexed field named');
    assert.strictEqual(catalog.candidates('Post', { orgId: { $gt: 'o' } }), null, 'not an equality');
    assert.strictEqual(catalog.candidates('Post', {}), null);
    // Down the branches: every $and term narrows, an $or narrows when each
    // of its branches does, a $not never does.
    assert.deepStrictEqual(
      catalog.candidates('Post', { $and: [{ orgId: 'o1' }, { 'meta.kind': 'x' }] }),
      new Set(['a']),
      '$and intersects its branches',
    );
    assert.deepStrictEqual(
      catalog.candidates('Post', { $and: [{ orgId: 'o1' }, { title: 'x' }] }),
      new Set(['a', 'b']),
      'a branch that cannot narrow is left to the predicate',
    );
    assert.deepStrictEqual(
      catalog.candidates('Post', { $or: [{ orgId: 'o2' }, { slug: 'a' }] }),
      new Set(['c', 'a']),
      '$or unions its branches',
    );
    assert.strictEqual(catalog.candidates('Post', { $or: [{ orgId: 'o2' }, { title: 'x' }] }), null, 'one open branch');
    assert.deepStrictEqual(
      catalog.candidates('Post', { 'meta.kind': 'x', $or: [{ orgId: 'o1' }, { orgId: 'o3' }] }),
      new Set(['a']),
      'top-level equalities and an $or meet',
    );
    assert.strictEqual(catalog.candidates('Post', { $not: { orgId: 'o1' } }), null);
    assert.strictEqual(
      catalog.candidates('Post', { $and: 'nope', $or: [] }),
      null,
      'malformed branches narrow nothing',
    );
    assert.deepStrictEqual(
      catalog.candidates('Post', { $and: [{ $or: [{ slug: 'b' }, { slug: 'c' }] }, { orgId: 'o1' }] }),
      new Set(['b']),
    );
    // ids() is cached until the collection changes.
    const before = catalog.ids('Post');
    assert.strictEqual(catalog.ids('Post'), before, 'the same array while nothing changed');
    assert.strictEqual(catalog.ids(), catalog.ids(), 'the whole list too');
    catalog.put('d', { type: 'Post', data: { orgId: 'o3', slug: 'd' } });
    assert.notStrictEqual(catalog.ids('Post'), before);
    assert.deepStrictEqual(catalog.ids('Post'), ['a', 'b', 'c', 'd']);
    assert.ok(catalog.indexed('Post').has('orgId'));
    assert.strictEqual(catalog.indexed('Post'), catalog.indexed('Post'), 'one set per collection');
    assert.strictEqual(catalog.indexed('Nope').size, 0);
    assert.strictEqual(catalog.candidates('Tag', { name: 't' }), null, 'no indexes on the collection');
    assert.strictEqual(catalog.candidates('Nope', { name: 't' }), null);
    assert.strictEqual(catalog.candidates('Post', 'orgId'), null);
    assert.deepStrictEqual(catalog.candidates('Post', { orgId: { $eq: 'o1', $in: ['o2'] } }), new Set(['a', 'b']));
    // Arrays and objects match as whole values.
    assert.deepStrictEqual(catalog.candidates('Post', { orgId: ['o1'] }), new Set());
    assert.deepStrictEqual(valueOf({ a: { b: 1 } }, 'a.b'), 1);
    assert.strictEqual(valueOf({ a: null }, 'a.b'), undefined);
    assert.strictEqual(valueOf({ a: 'x' }, 'a.b'), undefined);
  });

  await t.test('uniqueConflicts: the keys another id already holds', () => {
    const catalog = catalogOf(schema);
    catalog.put('a', { type: 'Post', data: { orgId: 'o1', slug: 'a', name: 'A' } });
    catalog.put('b', { type: 'Post', data: { orgId: 'o1', slug: 'b', name: 'B' } });
    catalog.put('t', { type: 'Tag', data: { slug: 'a' } });
    assert.deepStrictEqual(catalog.uniqueConflicts('Post', 'new', { slug: 'a' }), [{ fields: ['slug'], other: 'a' }]);
    assert.deepStrictEqual(catalog.uniqueConflicts('Post', 'a', { slug: 'a' }), [], 'its own key');
    assert.deepStrictEqual(catalog.uniqueConflicts('Post', 'new', { orgId: 'o1', name: 'B' }), [
      { fields: ['orgId', 'name'], other: 'b' },
    ]);
    assert.deepStrictEqual(catalog.uniqueConflicts('Post', 'new', { orgId: 'o1' }), [], 'a partial composite key');
    assert.deepStrictEqual(catalog.uniqueConflicts('Post', 'new', { slug: 'a', orgId: 'o1', name: 'B' }).length, 2);
    assert.deepStrictEqual(catalog.uniqueConflicts('Tag', 'new', { slug: 'a' }), []);
    assert.deepStrictEqual(catalog.uniqueConflicts('Nope', 'new', { slug: 'a' }), []);
    // Two records already on one key (a peer's doing): both are reported.
    catalog.put('c', { type: 'Post', data: { slug: 'a' } });
    assert.deepStrictEqual(
      catalog.uniqueConflicts('Post', 'new', { slug: 'a' }).map((c) => c.other),
      ['a', 'c'],
    );
    catalog.put('a', null);
    assert.deepStrictEqual(catalog.uniqueConflicts('Post', 'new', { slug: 'a' }), [{ fields: ['slug'], other: 'c' }]);
  });

  await t.test('save and load: the stamp, the rows, and what makes a file unusable', async () => {
    const fsi = createMemoryFsi();
    const catalog = catalogOf(schema, fsi);
    catalog.put('a', { type: 'Post', v: 1, data: { orgId: 'o1', slug: 'a' } });
    catalog.put('e', { type: 'Tag', encrypted: true });
    catalog.put('x', { data: { loose: 1 } });
    await catalog.save('epoch.7');
    assert.strictEqual(catalog.dirty, 0);
    const file = JSON.parse(await fsi.read('store/index', 'catalog.json'));
    assert.strictEqual(file.format, 2);
    assert.strictEqual(file.stamp, 'epoch.7');
    assert.deepStrictEqual(file.rows, [
      ['a', 'Post', 1, false, { orgId: 'o1', slug: 'a' }],
      ['e', 'Tag', null, true, {}],
      ['x', null, null, false, {}],
    ]);
    const loaded = catalogOf(schema, fsi);
    assert.deepStrictEqual(await loaded.load(), { stamp: 'epoch.7' });
    assert.deepStrictEqual(loaded.ids(), ['a', 'e', 'x']);
    assert.deepStrictEqual(loaded.candidates('Post', { orgId: 'o1' }), new Set(['a']));
    assert.deepStrictEqual(loaded.uniqueConflicts('Post', 'n', { slug: 'a' }), [{ fields: ['slug'], other: 'a' }]);
    assert.strictEqual(loaded.dirty, 0);
    // Other indexes: not reusable.
    const other = catalogOf({ entities: { Post: { index: ['title'] } } }, fsi);
    assert.strictEqual(await other.load(), null);
    assert.strictEqual(other.size, 0);
    // Absent, unreadable, or of another shape.
    assert.strictEqual(await catalogOf(schema, createMemoryFsi()).load(), null);
    for (const text of ['not json', '{"format":1}', '{"format":2,"indexes":"x"}', '[]', 'null']) {
      await fsi.write('store/index', 'catalog.json', text);
      assert.strictEqual(await catalogOf(schema, fsi).load(), null, text);
    }
    await fsi.write(
      'store/index',
      'catalog.json',
      JSON.stringify({ ...file, rows: [['ok', 'Post', 1, false, {}], 'junk', [7]] }),
    );
    const tolerant = catalogOf(schema, fsi);
    assert.deepStrictEqual(await tolerant.load(), { stamp: 'epoch.7' });
    assert.deepStrictEqual(tolerant.ids(), ['ok']);
  });
});

test('a save takes its rows at the start; puts that land during the write stay dirty', async () => {
  const base = createMemoryFsi();
  let release = null;
  const fsi = {
    ...base,
    write: async (dir, name, content) => {
      await new Promise((resolve) => {
        release = resolve;
      });
      return base.write(dir, name, content);
    },
  };
  const { entities } = normalizeSchema({ entities: { Post: { index: ['slug'] } } });
  const catalog = new Catalog({ fsi, path: 'store', entities });
  catalog.put('a', { type: 'Post', v: null, data: { slug: 'a' } });
  const saving = catalog.save('e.1');
  catalog.put('b', { type: 'Post', v: null, data: { slug: 'b' } });
  assert.strictEqual(catalog.dirty, 2);
  release();
  await saving;
  assert.strictEqual(catalog.dirty, 1, 'the put during the write is still dirty');
  const file = JSON.parse(await base.read('store/index', 'catalog.json'));
  assert.deepStrictEqual(
    file.rows.map((row) => row[0]),
    ['a'],
    'the rows are as of the start',
  );
});

test('a tombstone is a row that is there but not listed; all() pages over every entry', async () => {
  const fsi = createMemoryFsi();
  const { entities } = normalizeSchema({ entities: { Post: { index: ['slug'], unique: ['slug'] } } });
  const catalog = new Catalog({ fsi, path: 'store', entities });
  const woken = [];
  catalog.subscribe('Post', () => woken.push('Post'));
  catalog.put('b', { type: 'Post', v: 1, data: { slug: 'b' } });
  catalog.put('a', { type: 'Post', v: 1, data: { slug: 'a' } });
  catalog.put('e', { type: 'Post', encrypted: true });
  assert.deepStrictEqual(catalog.all(), ['a', 'b', 'e']);
  assert.strictEqual(catalog.all(), catalog.all(), 'cached until the next put');
  catalog.put('b', { type: 'Post', v: 1, gone: true });
  assert.strictEqual(catalog.has('b'), false);
  assert.deepStrictEqual(catalog.ids(), ['a', 'e']);
  assert.deepStrictEqual(catalog.ids('Post'), ['a', 'e']);
  assert.deepStrictEqual(catalog.all(), ['a', 'b', 'e'], 'the tombstone is still an entry');
  assert.strictEqual(catalog.size, 3);
  assert.deepStrictEqual(catalog.row('b'), { type: 'Post', v: 1, encrypted: false, gone: true, fields: {} });
  assert.deepStrictEqual(catalog.candidates('Post', { slug: 'b' }), new Set(), 'not matched');
  assert.deepStrictEqual(catalog.uniqueConflicts('Post', 'n', { slug: 'b' }), [], 'a tombstone holds no key');
  assert.deepStrictEqual(woken, ['Post', 'Post', 'Post', 'Post'], 'watchers hear a record go');
  await catalog.save('e.3');
  const loaded = new Catalog({ fsi, path: 'store', entities });
  await loaded.load();
  assert.deepStrictEqual(loaded.all(), ['a', 'b', 'e']);
  assert.deepStrictEqual(loaded.ids(), ['a', 'e']);
  assert.strictEqual(loaded.has('b'), false);
  // A revival turns the tombstone back into a row of its type.
  loaded.put('b', { type: 'Post', v: 2, data: { slug: 'b2' } });
  assert.deepStrictEqual(loaded.ids('Post'), ['a', 'b', 'e']);
  loaded.put('e', null);
  assert.deepStrictEqual(loaded.all(), ['a', 'b'], 'no file, no entry');
});
