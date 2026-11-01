'use strict';

// A field whose reading is made when it is read (src/lazy.js): a list's
// field after an op. It reads, copies, assigns and serializes as a plain
// property would, and is rendered once — when something reads it.

const test = require('node:test');
const assert = require('node:assert');
const { lazyField, putLazy, copyData, assignData } = require('../src/lazy.js');
const { applyOp } = require('../src/all/all.js');
const S = require('../src/text/sequence.js');

test('a lazy field is rendered once, when it is read, and reads, copies and serializes as a plain property', () => {
  let renders = 0;
  const data = { title: 'doc' };
  const delta = {};
  const reading = lazyField(data, 'items', () => {
    renders++;
    return [1, 2, 3];
  });
  putLazy(data, 'items', reading);
  putLazy(delta, 'items', reading);
  assert.deepStrictEqual(Object.keys(data), ['title', 'items'], 'enumerable, in its place');
  const copy = copyData(data);
  const merged = assignData({ other: true }, delta);
  assert.strictEqual(renders, 0, 'copied and assigned, never rendered');
  assert.strictEqual(data.items, copy.items, 'one rendering, shared by every copy');
  assert.strictEqual(merged.items, data.items);
  assert.strictEqual(renders, 1);
  assert.strictEqual(JSON.stringify(copy), '{"title":"doc","items":[1,2,3]}');
  assert.deepStrictEqual(structuredClone(data), { title: 'doc', items: [1, 2, 3] });
  assert.deepStrictEqual({ ...data }, { title: 'doc', items: [1, 2, 3] });
  // Assigned and deleted as a plain property; a copy afterwards takes what it is.
  copy.items = 'x';
  assert.strictEqual(copy.items, 'x');
  assert.strictEqual(data.items.length, 3, 'the other copies keep the reading');
  delete merged.items;
  assert.ok(!('items' in merged));
  assert.deepStrictEqual(copyData(copy), { title: 'doc', items: 'x' });
  assert.deepStrictEqual(assignData({}, copy), { title: 'doc', items: 'x' });
  assert.deepStrictEqual(copyData({ plain: 1 }), { plain: 1 }, 'a data object with no lazy field is spread');
  assert.strictEqual(renders, 1);
});

test('a list op renders nothing; a text op renders at once; the reading is what the list reads whole', () => {
  const op = (ts, value, key = 'items') => ({ origin: 'A', seq: ts, ts, type: 'splice', id: 'r', key, value });
  const items = [];
  for (let i = 0; i < 1000; i++) items.push(i);
  let entry = applyOp(null, op(1, { at: '^', content: items })).entry;
  const before = S.stats().listRenders;
  for (let ts = 2; ts < 50; ts++) {
    const idx = S.indexOf(entry, 'items');
    entry = applyOp(entry, op(ts, { ...S.placeInsert(idx, S.lengthOf(idx), 'A', 1), content: [ts] })).entry;
  }
  assert.strictEqual(S.stats().listRenders - before, 0, 'no list read whole on the op path');
  assert.strictEqual(entry.data.items.length, 1048);
  assert.strictEqual(S.stats().listRenders - before, 1, 'read once, whole, when read');
  assert.deepStrictEqual(entry.data.items, S.render(S.indexOf(entry, 'items')));
  const text = applyOp(entry, op(60, { at: '^', content: 'hello' }, 'body')).entry;
  assert.strictEqual(Object.getOwnPropertyDescriptor(text.data, 'body').value, 'hello', 'a text reads at once');
});
