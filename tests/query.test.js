'use strict';

// The query compiler and the row order in isolation: every operator, the
// array rule, dotted paths, what is refused at compile time.

const test = require('node:test');
const assert = require('node:assert');
const { compileQuery, compareRows, fieldsOf, Cursor } = require('../src/query/cursor.js');

const rows = [
  { id: 'a', n: 1, s: 'apple', b: true, tags: ['x', 'y'], meta: { kind: 'k1', rank: 2 } },
  { id: 'b', n: 2, s: 'banana', b: false, tags: ['y'], meta: { kind: 'k2', rank: 1 } },
  { id: 'c', n: 3, s: 'cherry', b: true, tags: [], meta: null, extra: null },
  { id: 'd', n: 'ten', s: null, meta: { kind: 'k1' } },
];
const ids = (query) => rows.filter(compileQuery(query)).map((row) => row.id);

test('compileQuery', async (t) => {
  await t.test('equality: bare values, dotted paths, arrays as sets of elements or as values', () => {
    assert.deepStrictEqual(ids({ n: 2 }), ['b']);
    assert.deepStrictEqual(ids({ s: 'apple', b: true }), ['a']);
    assert.deepStrictEqual(ids({ 'meta.kind': 'k1' }), ['a', 'd']);
    assert.deepStrictEqual(ids({ tags: 'y' }), ['a', 'b'], 'an array field holds the value');
    assert.deepStrictEqual(ids({ tags: ['y'] }), ['b'], 'an array value is matched whole');
    assert.deepStrictEqual(ids({ tags: [] }), ['c']);
    assert.deepStrictEqual(ids({ meta: { kind: 'k2', rank: 1 } }), ['b'], 'an object value is matched whole');
    assert.deepStrictEqual(ids({ meta: null }), ['c']);
    assert.deepStrictEqual(ids({ nope: undefined }), ['a', 'b', 'c', 'd'], 'undefined equals absent');
    assert.deepStrictEqual(ids({ id: 'c' }), ['c']);
    assert.deepStrictEqual(ids({}), ['a', 'b', 'c', 'd']);
    assert.deepStrictEqual(ids(undefined), ['a', 'b', 'c', 'd']);
  });

  await t.test('operators', () => {
    assert.deepStrictEqual(ids({ n: { $eq: 1 } }), ['a']);
    assert.deepStrictEqual(ids({ n: { $ne: 1 } }), ['b', 'c', 'd']);
    assert.deepStrictEqual(ids({ n: { $in: [1, 3, 9] } }), ['a', 'c']);
    assert.deepStrictEqual(ids({ tags: { $in: ['x'] } }), ['a']);
    assert.deepStrictEqual(ids({ n: { $nin: [1, 3] } }), ['b', 'd']);
    assert.deepStrictEqual(ids({ n: { $gt: 1 } }), ['b', 'c'], 'a string is not greater than a number');
    assert.deepStrictEqual(ids({ n: { $gte: 2, $lt: 3 } }), ['b']);
    assert.deepStrictEqual(ids({ s: { $lte: 'banana' } }), ['a', 'b']);
    assert.deepStrictEqual(ids({ b: { $gt: false } }), ['a', 'c']);
    assert.deepStrictEqual(ids({ 'meta.rank': { $gt: 1 } }), ['a']);
    assert.deepStrictEqual(ids({ tags: { $gte: 'y' } }), ['a', 'b'], 'any element');
    assert.deepStrictEqual(ids({ extra: { $exists: true } }), ['c'], 'null exists');
    assert.deepStrictEqual(ids({ 'meta.rank': { $exists: false } }), ['c', 'd']);
    assert.deepStrictEqual(ids({ s: { $regex: '^b' } }), ['b']);
    assert.deepStrictEqual(ids({ s: { $regex: 'APPLE', $options: 'i' } }), ['a']);
    assert.deepStrictEqual(ids({ s: { $regex: /an/g } }), ['b'], 'the g flag is dropped: no lastIndex surprises');
    assert.deepStrictEqual(ids({ s: { $regex: /AN/, $options: 'i' } }), ['b'], '$options replaces the flags');
    assert.deepStrictEqual(ids({ tags: { $regex: '^x' } }), ['a']);
    assert.deepStrictEqual(ids({ n: { $regex: '1' } }), [], 'only strings match a regex');
  });

  await t.test('$and, $or, $not nest', () => {
    assert.deepStrictEqual(ids({ $or: [{ n: 1 }, { n: 3 }] }), ['a', 'c']);
    assert.deepStrictEqual(ids({ $and: [{ b: true }, { 'meta.kind': 'k1' }] }), ['a']);
    assert.deepStrictEqual(ids({ $not: { b: true } }), ['b', 'd']);
    assert.deepStrictEqual(
      ids({ $or: [{ $and: [{ n: 1 }, { b: true }] }, { $not: { $or: [{ n: 1 }, { n: 2 }, { n: 3 }] } }] }),
      ['a', 'd'],
    );
    assert.deepStrictEqual(
      [...fieldsOf({ $or: [{ a: 1 }, { $and: [{ 'b.c': 2 }, { $not: { d: 3 } }] }], e: 4 })],
      ['a', 'b.c', 'd', 'e'],
    );
  });

  await t.test('$text: a string at the top level, no predicate of its own, no field', () => {
    assert.deepStrictEqual(ids({ $text: 'apple' }), ['a', 'b', 'c', 'd'], 'the catalog answers it, not the predicate');
    assert.deepStrictEqual(ids({ $text: 'apple', n: 1 }), ['a']);
    assert.throws(() => compileQuery({ $text: 1 }), /\$text takes a string/);
    assert.throws(() => compileQuery({ $text: 'a'.repeat(1001) }), /\$text is longer than 1000 characters/);
    assert.throws(() => compileQuery({ $and: [{ $text: 'x' }] }), /only allowed at the top level/);
    assert.throws(() => compileQuery({ $or: [{ n: 1 }, { $text: 'x' }] }), /only allowed at the top level/);
    assert.throws(() => compileQuery({ $not: { $text: 'x' } }), /only allowed at the top level/);
    assert.deepStrictEqual([...fieldsOf({ $text: 'x', a: 1, $and: [{ b: 2 }] })], ['a', 'b']);
  });

  await t.test('a malformed query is a TypeError at compile time', () => {
    const bad = (query, pattern) => assert.throws(() => compileQuery(query), { name: 'TypeError', message: pattern });
    bad('n', /takes a query object/);
    bad([], /takes a query object/);
    bad({ $nope: 1 }, /unknown operator \$nope/);
    bad({ n: { $nope: 1 } }, /unknown operator \$nope/);
    bad({ n: { $in: 1 } }, /\$in takes an array/);
    bad({ n: { $nin: 'x' } }, /\$nin takes an array/);
    bad({ n: { $gt: null } }, /\$gt takes a number, a string or a boolean/);
    bad({ n: { $lte: [1] } }, /\$lte takes/);
    bad({ n: { $exists: 'yes' } }, /\$exists takes a boolean/);
    bad({ s: { $regex: 1 } }, /\$regex takes a RegExp or a string/);
    bad({ s: { $regex: '(' } }, /\$regex is invalid/);
    bad({ $and: { n: 1 } }, /\$and takes an array/);
    bad({ $or: 'n' }, /\$or takes an array/);
    bad({ $not: 'n' }, /takes a query object/);
  });
});

test('compareRows', async (t) => {
  await t.test('orders by kind, then value; several keys; desc per key; stable', () => {
    const sorted = (keys) => [...rows].sort(compareRows(keys)).map((row) => row.id);
    assert.deepStrictEqual(sorted([{ field: 'n', desc: false }]), ['a', 'b', 'c', 'd'], 'numbers before strings');
    assert.deepStrictEqual(sorted([{ field: 'n', desc: true }]), ['d', 'c', 'b', 'a']);
    assert.deepStrictEqual(sorted([{ field: 's', desc: false }]), ['d', 'a', 'b', 'c'], 'null first');
    assert.deepStrictEqual(
      sorted([{ field: 'b', desc: false }]),
      ['d', 'b', 'a', 'c'],
      'absent, false, true; stable among equals',
    );
    assert.deepStrictEqual(
      sorted([
        { field: 'meta.kind', desc: false },
        { field: 'n', desc: true },
      ]),
      ['c', 'd', 'a', 'b'],
    );
    assert.deepStrictEqual(sorted([{ field: 'tags', desc: false }]), ['d', 'a', 'b', 'c'], 'arrays are left in place');
  });
});

test('Cursor over a fake source', async (t) => {
  const source = (records, indexed = []) => {
    const calls = { load: 0 };
    const rowsOf = () =>
      Object.fromEntries(
        Object.entries(records).map(([id, data]) => [
          id,
          { fields: Object.fromEntries(indexed.map((f) => [f, data[f]])) },
        ]),
      );
    return {
      calls,
      logger: { debug() {} },
      candidates: () => null,
      ids: () => Object.keys(records),
      row: (id) => rowsOf()[id] ?? null,
      indexed: () => new Set(indexed),
      searches: () => false,
      subscribe: () => () => {},
      load: async (id) => {
        calls.load++;
        return records[id] ?? null;
      },
    };
  };

  await t.test('builders are checked; a covered cursor never loads; one() limits to one', async () => {
    const src = source({ a: { n: 1 }, b: { n: 2 } }, ['n']);
    const cursor = new Cursor(src, 'T', { n: { $gte: 1 } });
    assert.throws(() => cursor.order(1), /order\(\) takes a field name/);
    assert.throws(() => cursor.limit(-1), /limit\(\) takes a non-negative integer/);
    assert.throws(() => cursor.offset(1.5), /offset\(\) takes a non-negative integer/);
    assert.throws(() => cursor.filter('fn'), /filter\(\) takes a function/);
    assert.throws(() => cursor.projection('n'), /projection\(\) takes an array of field names/);
    assert.throws(() => cursor.watch('listener'), /watch\(\) takes a listener/);
    assert.deepStrictEqual(await cursor.desc('n').projection(['n']).fetch(), [
      { id: 'b', n: 2 },
      { id: 'a', n: 1 },
    ]);
    assert.strictEqual(await cursor.count(), 2);
    assert.strictEqual(src.calls.load, 0, 'covered: catalog rows only');
    assert.deepStrictEqual(await new Cursor(src, 'T', { n: 2 }).one(), { id: 'b', n: 2 });
    assert.strictEqual(await new Cursor(src, 'T', { n: 9 }).one(), null);
    assert.strictEqual(src.calls.load, 4, 'no projection: the records are loaded, up to the first match');
    assert.deepStrictEqual(await new Cursor(src, 'T', { n: 1 }).one(), { id: 'a', n: 1 });
    assert.strictEqual(src.calls.load, 5, 'one() stops at the first match');
    const seen = [];
    for await (const row of new Cursor(src, 'T').order('n')) seen.push(row.id);
    assert.deepStrictEqual(seen, ['a', 'b']);
  });

  await t.test(
    '$text: refused where nothing searches; rank order kept unless ordered; limit reads little',
    async () => {
      const plain = source({ a: { n: 1 } });
      assert.throws(() => new Cursor(plain, 'T', { $text: 'x' }), /\$text needs search fields on T/);
      const src = source({ a: { n: 1, s: 'x' }, b: { n: 2, s: 'y' }, c: { n: 3, s: 'z' } }, ['n']);
      src.searches = () => true;
      src.candidates = (entity, query) => (query.$text === undefined ? null : new Set(['c', 'a']));
      const ranked = new Cursor(src, 'T', { $text: 'words' });
      assert.deepStrictEqual(
        (await ranked.fetch()).map((row) => row.id),
        ['c', 'a'],
        'the index order, as it came',
      );
      assert.strictEqual(await ranked.count(), 2);
      assert.deepStrictEqual(
        (await new Cursor(src, 'T', { $text: 'w' }).order('n').fetch()).map((r) => r.id),
        ['a', 'c'],
      );
      src.calls.load = 0;
      assert.deepStrictEqual(
        (await new Cursor(src, 'T', { $text: 'w' }).limit(1).fetch()).map((r) => r.id),
        ['c'],
      );
      assert.strictEqual(src.calls.load, 1, 'an unordered limit reads one record');
      src.calls.load = 0;
      const covered = await new Cursor(src, 'T', { $text: 'w' }).projection(['n']).fetch();
      assert.deepStrictEqual(covered, [
        { id: 'c', n: 3 },
        { id: 'a', n: 1 },
      ]);
      assert.strictEqual(src.calls.load, 0, 'covered: $text reads no field of its own');
      assert.deepStrictEqual(
        (await new Cursor(src, 'T', { $text: 'w', n: 1 }).fetch()).map((r) => r.id),
        ['a'],
      );
    },
  );
});

test('query guards: a pattern the size of a document, a projection of __proto__', () => {
  const { compileQuery, Cursor } = require('../src/query/cursor.js');
  assert.throws(() => compileQuery({ key: { $regex: 'a'.repeat(1001) } }), /longer than 1000/);
  assert.doesNotThrow(() => compileQuery({ key: { $regex: 'a'.repeat(1000) } }));
  const source = { logger: null, candidates: () => null, ids: () => [], row: () => null, indexed: () => new Set() };
  assert.throws(() => new Cursor(source, 'T').projection(['__proto__']), TypeError);
});
