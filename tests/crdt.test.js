'use strict';

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('..');

test('CRDT module', async (t) => {
  await t.test('diff function - basic object diff', () => {
    assert.deepStrictEqual(syncom.diff({}, {}), {});

    const source = { a: 1, b: 2, c: 3 };
    const target = { a: 1, b: 20, d: 4 };
    const result = syncom.diff(source, target);

    assert.deepStrictEqual(result, { b: 20, c: undefined, d: 4 });
  });

  await t.test('diff function - new keys added', () => {
    const source = { a: 1 };
    const target = { a: 1, b: 2, c: 3 };
    const result = syncom.diff(source, target);

    assert.deepStrictEqual(result, { b: 2, c: 3 });
  });

  await t.test('diff function - keys removed', () => {
    const source = { a: 1, b: 2, c: 3 };
    const target = { a: 1 };
    const result = syncom.diff(source, target);

    assert.deepStrictEqual(result, { b: undefined, c: undefined });
  });

  await t.test('diff function - arrays and sets', () => {
    const arrDiff = syncom.diff({ items: [1, 2, 3] }, { items: [1, 2, 3, 4, 5] });
    assert.deepStrictEqual(arrDiff, { items: [4, 5] });

    const setDiff = syncom.diff({ tags: new Set(['a', 'b']) }, { tags: new Set(['a', 'b', 'c']) });
    assert.deepStrictEqual(setDiff, { tags: ['c'] });
  });

  await t.test('diff function - nested objects', () => {
    const source = { user: { name: 'John', age: 30 } };
    const target = { user: { name: 'Jane', age: 30, city: 'NYC' } };
    const result = syncom.diff(source, target);

    assert.deepStrictEqual(result, {
      user: { name: 'Jane', city: 'NYC' },
    });
  });

  await t.test('merge function - basic merge', () => {
    const source = { a: 1, b: 2 };
    const delta = { b: 20, c: 3 };
    const result = syncom.merge(source, delta);

    assert.deepStrictEqual(result, { a: 1, b: 22, c: 3 });
  });

  await t.test('merge function - delete keys', () => {
    const source = { a: 1, b: 2, c: 3 };
    const delta = { b: undefined };
    const result = syncom.merge(source, delta);

    assert.deepStrictEqual(result, { a: 1, c: 3 });
  });

  await t.test('merge function - arrays/sets merge', () => {
    const source = { items: [1, 2, 3] };
    const delta = { items: [3, 4, 5] };
    const result = syncom.merge(source, delta);

    assert.deepStrictEqual(result, { items: [1, 2, 3, 4, 5] });
  });

  await t.test('merge function - counter merge', () => {
    const source = { count: 10 };
    const delta = { count: 5 };
    const result = syncom.merge(source, delta);

    assert.strictEqual(result.count, 15);
  });

  await t.test('merge function - nested objects', () => {
    const source = { user: { name: 'John', age: 30 } };
    const delta = { user: { age: 31, city: 'NYC' } };
    const result = syncom.merge(source, delta);

    assert.deepStrictEqual(result, {
      user: { name: 'John', age: 61, city: 'NYC' },
    });
  });

  await t.test('merge function - null/undefined delta', () => {
    const source = { a: 1, b: 2 };
    const result1 = syncom.merge(source, null);
    const result2 = syncom.merge(source, undefined);

    assert.deepStrictEqual(result1, source);
    assert.deepStrictEqual(result2, source);
  });

  await t.test('merge function - null source', () => {
    const delta = { a: 1, b: 2 };
    const result = syncom.merge(null, delta);

    assert.deepStrictEqual(result, delta);
  });

  await t.test('apply function - write record', () => {
    const source = { a: 1, b: 2 };
    const history = [{ type: 'write', data: { c: 3, d: 4 } }];
    const result = syncom.apply(source, history);

    // A write is a full record write: the state IS the written data.
    assert.deepStrictEqual(result, { c: 3, d: 4 });
    assert.deepStrictEqual(source, { a: 1, b: 2 });

    // A write with no data (a bare marker) copies the state forward.
    assert.deepStrictEqual(syncom.apply(source, [{ type: 'write' }]), { a: 1, b: 2 });
  });

  await t.test('apply function - delete record vs delete key', () => {
    const source = { a: 1, b: 2 };
    // The deletion marker merge() understands: the key is present, set to undefined.
    assert.deepStrictEqual(syncom.apply(source, [{ type: 'delete', key: 'a' }]), { a: undefined, b: 2 });
    // Storage's own shape: no key means the record itself was deleted.
    assert.deepStrictEqual(syncom.apply(source, [{ type: 'delete', id: 'r1' }]), {});
  });

  await t.test('apply function - delta record', () => {
    const source = { a: 1, b: 2 };
    const history = [{ type: 'delta', data: { b: 20, c: 3 } }];
    const result = syncom.apply(source, history);

    assert.deepStrictEqual(result, { a: 1, b: 22, c: 3 });

    const fromEmpty = syncom.apply({}, [{ type: 'delta', data: { a: 1, b: 2 } }]);
    assert.deepStrictEqual(fromEmpty, { a: 1, b: 2 });
  });

  await t.test('apply function - delete record', () => {
    const source = { a: 1, b: 2, c: 3 };
    const history = [{ type: 'delete', key: 'b' }];
    const result = syncom.apply(source, history);

    assert.deepStrictEqual(result, { a: 1, b: undefined, c: 3 });
  });

  await t.test('apply function - inc record', () => {
    const source = { count: 10 };
    const history = [{ type: 'inc', key: 'count', value: 5 }];
    const result = syncom.apply(source, history);

    assert.strictEqual(result.count, 15);
  });

  await t.test('apply function - dec record', () => {
    const source = { count: 10 };
    const history = [{ type: 'dec', key: 'count', value: 3 }];
    const result = syncom.apply(source, history);

    assert.strictEqual(result.count, 7);
  });

  await t.test('apply function - multiple records', () => {
    const source = { a: 1, b: 2 };
    const history = [
      { type: 'delta', data: { b: 20 } },
      { type: 'delta', data: { c: 3 } },
      { type: 'inc', key: 'a', value: 5 },
    ];
    const result = syncom.apply(source, history);

    assert.deepStrictEqual(result, { a: 6, b: 22, c: 3 });
  });

  await t.test('apply function - write replaces the accumulated state', () => {
    const source = { a: 1, b: 2, c: 3 };
    const history = [
      { type: 'delta', data: { d: 4 } },
      { type: 'write', data: { x: 10 } },
      { type: 'delta', data: { x: 1 } },
    ];
    const result = syncom.apply(source, history);

    assert.deepStrictEqual(result, { x: 11 });
  });

  await t.test('apply function - invalid history', () => {
    const source = { a: 1 };
    const result1 = syncom.apply(source, null);
    const result2 = syncom.apply(source, 'not-array');
    const result3 = syncom.apply(source, []);

    assert.deepStrictEqual(result1, source);
    assert.deepStrictEqual(result2, source);
    assert.deepStrictEqual(result3, source);
  });

  await t.test('apply function - invalid records', () => {
    const source = { a: 1 };
    const history = [null, { type: 'unknown' }, { type: 'delta' }, { type: 'delta', data: { b: 2 } }];
    const result = syncom.apply(source, history);

    assert.deepStrictEqual(result, { a: 1, b: 2 });
  });
});
