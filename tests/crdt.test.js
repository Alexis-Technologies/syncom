'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const syncom = require('../src/all/all.js');

describe('CRDT module', () => {
  it('should diff two plain objects key by key', () => {
    assert.deepStrictEqual(syncom.diff({}, {}), {});

    const source = { a: 1, b: 2, c: 3 };
    const target = { a: 1, b: 20, d: 4 };
    const result = syncom.diff(source, target);

    assert.deepStrictEqual(result, { b: 20, c: undefined, d: 4 });
  });

  it('should diff the keys added to an object', () => {
    const source = { a: 1 };
    const target = { a: 1, b: 2, c: 3 };
    const result = syncom.diff(source, target);

    assert.deepStrictEqual(result, { b: 2, c: 3 });
  });

  it('should diff the keys removed from an object', () => {
    const source = { a: 1, b: 2, c: 3 };
    const target = { a: 1 };
    const result = syncom.diff(source, target);

    assert.deepStrictEqual(result, { b: undefined, c: undefined });
  });

  it('should diff arrays and sets by the items added', () => {
    const arrDiff = syncom.diff({ items: [1, 2, 3] }, { items: [1, 2, 3, 4, 5] });
    assert.deepStrictEqual(arrDiff, { items: [4, 5] });

    const setDiff = syncom.diff({ tags: new Set(['a', 'b']) }, { tags: new Set(['a', 'b', 'c']) });
    assert.deepStrictEqual(setDiff, { tags: ['c'] });
  });

  it('should diff a null side or a non-collection under an array as nothing, not a throw', () => {
    assert.deepStrictEqual(syncom.diff({ a: null }, { a: { b: 1 } }), { a: { b: 1 } });
    assert.deepStrictEqual(syncom.diff(null, { a: 1 }), { a: 1 });
    assert.deepStrictEqual(syncom.diff({ a: 5 }, { a: [1, 2] }), { a: [1, 2] });
    const chars = syncom.diff({ a: 'ab' }, { a: ['a', 'c'] });
    assert.deepStrictEqual(chars, { a: ['a', 'c'] }, 'a string is not a set of characters');
  });

  it('should diff nested objects field by field', () => {
    const source = { user: { name: 'John', age: 30 } };
    const target = { user: { name: 'Jane', age: 30, city: 'NYC' } };
    const result = syncom.diff(source, target);

    assert.deepStrictEqual(result, {
      user: { name: 'Jane', city: 'NYC' },
    });
  });

  it('should merge a delta into an object, adding the numbers both hold', () => {
    const source = { a: 1, b: 2 };
    const delta = { b: 20, c: 3 };
    const result = syncom.merge(source, delta);

    assert.deepStrictEqual(result, { a: 1, b: 22, c: 3 });
  });

  it('should merge an undefined value as a deleted key', () => {
    const source = { a: 1, b: 2, c: 3 };
    const delta = { b: undefined };
    const result = syncom.merge(source, delta);

    assert.deepStrictEqual(result, { a: 1, c: 3 });
  });

  it('should merge arrays and sets as their union', () => {
    const source = { items: [1, 2, 3] };
    const delta = { items: [3, 4, 5] };
    const result = syncom.merge(source, delta);

    assert.deepStrictEqual(result, { items: [1, 2, 3, 4, 5] });
  });

  it('should merge a number as a counter, adding the delta', () => {
    const source = { count: 10 };
    const delta = { count: 5 };
    const result = syncom.merge(source, delta);

    assert.strictEqual(result.count, 15);
  });

  it('should merge nested objects field by field', () => {
    const source = { user: { name: 'John', age: 30 } };
    const delta = { user: { age: 31, city: 'NYC' } };
    const result = syncom.merge(source, delta);

    assert.deepStrictEqual(result, {
      user: { name: 'John', age: 61, city: 'NYC' },
    });
  });

  it('should merge a null or undefined delta as no change', () => {
    const source = { a: 1, b: 2 };
    const result1 = syncom.merge(source, null);
    const result2 = syncom.merge(source, undefined);

    assert.deepStrictEqual(result1, source);
    assert.deepStrictEqual(result2, source);
  });

  it('should merge a delta into a null source as the delta itself', () => {
    const delta = { a: 1, b: 2 };
    const result = syncom.merge(null, delta);

    assert.deepStrictEqual(result, delta);
  });

  it('should apply a write record as the whole state', () => {
    const source = { a: 1, b: 2 };
    const history = [{ type: 'write', data: { c: 3, d: 4 } }];
    const result = syncom.apply(source, history);

    // A write is a full record write: the state IS the written data.
    assert.deepStrictEqual(result, { c: 3, d: 4 });
    assert.deepStrictEqual(source, { a: 1, b: 2 });

    // A write with no data (a bare marker) copies the state forward.
    assert.deepStrictEqual(syncom.apply(source, [{ type: 'write' }]), { a: 1, b: 2 });
  });

  it('should apply a delete record with a key as a deleted key, and without one as a deleted record', () => {
    const source = { a: 1, b: 2 };
    // The deletion marker merge() understands: the key is present, set to undefined.
    assert.deepStrictEqual(syncom.apply(source, [{ type: 'delete', key: 'a' }]), { a: undefined, b: 2 });
    // Storage's own shape: no key means the record itself was deleted.
    assert.deepStrictEqual(syncom.apply(source, [{ type: 'delete', id: 'r1' }]), {});
  });

  it('should apply a delta record by merging it', () => {
    const source = { a: 1, b: 2 };
    const history = [{ type: 'delta', data: { b: 20, c: 3 } }];
    const result = syncom.apply(source, history);

    assert.deepStrictEqual(result, { a: 1, b: 22, c: 3 });

    const fromEmpty = syncom.apply({}, [{ type: 'delta', data: { a: 1, b: 2 } }]);
    assert.deepStrictEqual(fromEmpty, { a: 1, b: 2 });
  });

  it('should apply a delete record of a key as the key set to undefined', () => {
    const source = { a: 1, b: 2, c: 3 };
    const history = [{ type: 'delete', key: 'b' }];
    const result = syncom.apply(source, history);

    assert.deepStrictEqual(result, { a: 1, b: undefined, c: 3 });
  });

  it('should apply an inc record by adding its value', () => {
    const source = { count: 10 };
    const history = [{ type: 'inc', key: 'count', value: 5 }];
    const result = syncom.apply(source, history);

    assert.strictEqual(result.count, 15);
  });

  it('should apply a dec record by subtracting its value', () => {
    const source = { count: 10 };
    const history = [{ type: 'dec', key: 'count', value: 3 }];
    const result = syncom.apply(source, history);

    assert.strictEqual(result.count, 7);
  });

  it('should apply multiple records in turn', () => {
    const source = { a: 1, b: 2 };
    const history = [
      { type: 'delta', data: { b: 20 } },
      { type: 'delta', data: { c: 3 } },
      { type: 'inc', key: 'a', value: 5 },
    ];
    const result = syncom.apply(source, history);

    assert.deepStrictEqual(result, { a: 6, b: 22, c: 3 });
  });

  it('should apply a write record by replacing the accumulated state', () => {
    const source = { a: 1, b: 2, c: 3 };
    const history = [
      { type: 'delta', data: { d: 4 } },
      { type: 'write', data: { x: 10 } },
      { type: 'delta', data: { x: 1 } },
    ];
    const result = syncom.apply(source, history);

    assert.deepStrictEqual(result, { x: 11 });
  });

  it('should apply an invalid history as no change', () => {
    const source = { a: 1 };
    const result1 = syncom.apply(source, null);
    const result2 = syncom.apply(source, 'not-array');
    const result3 = syncom.apply(source, []);

    assert.deepStrictEqual(result1, source);
    assert.deepStrictEqual(result2, source);
    assert.deepStrictEqual(result3, source);
  });

  it('should apply a history skipping its invalid records', () => {
    const source = { a: 1 };
    const history = [null, { type: 'unknown' }, { type: 'delta' }, { type: 'delta', data: { b: 2 } }];
    const result = syncom.apply(source, history);

    assert.deepStrictEqual(result, { a: 1, b: 2 });
  });

  it('should take own keys only in diff and merge: __proto__ is never a field', () => {
    const delta = JSON.parse('{"__proto__": {"polluted": true}, "n": 1}');
    const merged = syncom.merge({ n: 1 }, delta);
    assert.strictEqual(Object.getPrototypeOf(merged), Object.prototype);
    assert.strictEqual(merged.polluted, undefined);
    assert.deepStrictEqual(merged, { n: 2 });
    const target = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}');
    const changed = syncom.diff({}, target);
    assert.strictEqual(Object.getPrototypeOf(changed), Object.prototype);
    assert.deepStrictEqual(changed, { a: 1 });
    assert.strictEqual({}.polluted, undefined);
  });

  it('should read only the target’s own keys in merge: a field named like a prototype member is a field', () => {
    assert.deepStrictEqual(syncom.merge({}, { constructor: [2] }), { constructor: [2] });
    assert.deepStrictEqual(syncom.merge({}, { toString: { a: 1 } }), { toString: { a: 1 } });
    assert.deepStrictEqual(syncom.merge({ constructor: [1] }, { constructor: [2] }), { constructor: [1, 2] });
  });
});
