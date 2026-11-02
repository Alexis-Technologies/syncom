'use strict';

// The update operators as a pure expansion (src/operators.js): every operator
// against the calls it means over a record, by the kind of each field.

const test = require('node:test');
const assert = require('node:assert');
const { isOperators, expand } = require('../src/operators.js');

const kinds = {
  hits: 'counter',
  tags: 'set',
  list: 'list',
  body: 'text',
  arr: 'register',
  n: 'register',
  s: 'register',
};
const kindAt = (field) => kinds[field];
const view = { hits: 3, tags: ['a'], list: [1, 2, 3], body: 'ab', arr: [1, 2], n: 5, s: 'm', nested: { a: 1 } };

test('update operators', async (t) => {
  await t.test('isOperators(): every key an operator, or none; mixed is a TypeError', () => {
    assert.strictEqual(isOperators({ $set: { a: 1 }, $inc: { b: 1 } }), true);
    assert.strictEqual(isOperators({ a: 1, 'b/c': 2 }), false);
    assert.strictEqual(isOperators({}), false);
    assert.throws(() => isOperators({ $set: { a: 1 }, b: 2 }), TypeError);
    assert.throws(() => expand({ $nope: {} }, view, kindAt), /unknown operator/);
  });

  await t.test('each operator goes by the kind of its field, and the rest is a rewrite of a register', () => {
    assert.deepStrictEqual(expand({ $inc: { hits: 2, fresh: 1 } }, view, kindAt), [
      ['inc', 'hits', 2],
      ['inc', 'fresh', 1],
    ]);
    // A set, an absent field: add()/remove(); a register's array: rewritten whole, as a set would read.
    assert.deepStrictEqual(
      expand({ $addToSet: { tags: 'b', fresh: { $each: [1, 2] }, arr: { $each: [2, 3] } } }, view, kindAt),
      [
        ['add', 'tags', ['b']],
        ['add', 'fresh', [1, 2]],
        ['update', { arr: [1, 2, 3] }],
      ],
    );
    assert.deepStrictEqual(expand({ $pull: { tags: 'a', arr: { $in: [1, 9] } } }, view, kindAt), [
      ['remove', 'tags', ['a']],
      ['update', { arr: [2] }],
    ]);
    assert.deepStrictEqual(expand({ $addToSet: { arr: 1 }, $pull: { arr: 9 } }, view, kindAt), [], 'nothing to change');
    // Object elements are held equal whatever their key order, as deepEqual holds them.
    assert.deepStrictEqual(
      expand({ $addToSet: { arr: { $each: [{ b: 2, a: 1 }] } } }, { ...view, arr: [{ a: 1, b: 2 }] }, kindAt),
      [],
      'held already',
    );
    assert.deepStrictEqual(expand({ $pull: { arr: { b: 2, a: 1 } } }, { ...view, arr: [{ a: 1, b: 2 }, 3] }, kindAt), [
      ['update', { arr: [3] }],
    ]);
    // A list and a text take push(); a register's array or an absent field is written as an array.
    assert.deepStrictEqual(expand({ $push: { list: 9, body: 'c', arr: { $each: [3, 4] }, fresh: 5 } }, view, kindAt), [
      ['push', 'list', [9]],
      ['push', 'body', 'c'],
      ['update', { arr: [1, 2, 3, 4], fresh: [5] }],
    ]);
    assert.deepStrictEqual(expand({ $pop: { list: 1, arr: -1, fresh: 1 } }, view, kindAt), [
      ['splice', 'list', 2, 1],
      ['update', { arr: [2] }],
    ]);
    assert.throws(() => expand({ $pop: { list: 2 } }, view, kindAt), TypeError);
    // $min/$max write only where the comparison holds; a type apart is a TypeError.
    assert.deepStrictEqual(expand({ $min: { n: 7, s: 'a' }, $max: { n: 7, fresh: 1 } }, view, kindAt), [
      ['update', { s: 'a', n: 7, fresh: 1 }],
    ]);
    assert.deepStrictEqual(expand({ $min: { n: 5 }, $max: { n: 5 } }, view, kindAt), []);
    assert.throws(() => expand({ $min: { n: 'x' } }, view, kindAt), TypeError);
    assert.throws(() => expand({ $max: { nested: 1 } }, view, kindAt), TypeError);
    // $rename is an unset and a set; a field that is not there renames nothing; $unset takes names or an object.
    assert.deepStrictEqual(expand({ $rename: { s: 't', nope: 'x' } }, view, kindAt), [
      ['unset', ['s']],
      ['update', { t: 'm' }],
    ]);
    assert.deepStrictEqual(expand({ $unset: { n: '', s: 1 } }, view, kindAt), [['unset', ['n', 's']]]);
    assert.deepStrictEqual(expand({ $unset: 'n' }, view, kindAt), [['unset', ['n']]]);
    assert.deepStrictEqual(expand({ $set: { 'nested/b': 2, z: null } }, null, kindAt), [
      ['update', { 'nested/b': 2, z: null }],
    ]);
    // The arguments are checked as the methods check them.
    assert.throws(() => expand({ $set: 5 }, view, kindAt), TypeError);
    assert.throws(() => expand({ $inc: { n: 'x' } }, view, kindAt), TypeError);
    assert.throws(() => expand({ $set: JSON.parse('{"__proto__":1}') }, view, kindAt), TypeError);
    assert.throws(() => expand({ $addToSet: { tags: { $each: 'x' } } }, view, kindAt), TypeError);
    assert.throws(() => expand({ $set: { a: () => 1 } }, view, kindAt), TypeError);
  });
});
