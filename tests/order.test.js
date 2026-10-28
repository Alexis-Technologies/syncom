'use strict';

// Fractional indexes: strings that sort with `<`, with room between any two.

const test = require('node:test');
const assert = require('node:assert');
const { between, spread, compare, isKey } = require('../src/order/order.js');

const sorted = (keys) => keys.every((key, i) => i === 0 || keys[i - 1] < key);

test('order', async (t) => {
  await t.test('between gives a key between its bounds, either side open', () => {
    const first = between();
    assert.strictEqual(first, 'V', 'the terminator alone, the middle digit');
    const after = between(first);
    const before = between(null, first);
    const mid = between(first, after);
    assert.ok(sorted([before, first, mid, after]), [before, first, mid, after].join(' '));
    assert.strictEqual(compare(before, first), -1);
    assert.strictEqual(compare(first, first), 0);
    assert.strictEqual(compare(after, first), 1);
    assert.throws(() => between(after, first), RangeError);
    assert.throws(() => between(first, first), RangeError);
    assert.throws(() => between('nope'), TypeError);
    assert.throws(() => between('', first), TypeError);
    assert.throws(() => between(first, undefined, { jitter: -1 }), TypeError);
    assert.strictEqual(isKey(first), true);
    assert.strictEqual(isKey('V1'), false, 'must end in the terminator');
    assert.strictEqual(isKey(''), false);
    assert.strictEqual(isKey(7), false);
  });

  await t.test('keys never run out: appending, prepending and bisecting stay ordered and short', () => {
    const tail = [between()];
    for (let i = 0; i < 500; i++) tail.push(between(tail[tail.length - 1]));
    assert.ok(sorted(tail));
    assert.ok(tail[500].length < 24, `500 appends: ${tail[500].length} characters`);
    const head = [between()];
    for (let i = 0; i < 500; i++) head.unshift(between(null, head[0]));
    assert.ok(sorted(head));
    const lo = between();
    let hi = between(lo);
    const mids = [];
    for (let i = 0; i < 200; i++) {
      hi = between(lo, hi);
      mids.push(hi);
    }
    assert.ok(mids.every((m, i) => lo < m && (i === 0 || m < mids[i - 1])));
    assert.ok(mids[199].length < 40, `200 bisections: ${mids[199].length} characters`);
    // Random inserts between random neighbours.
    let seed = 1;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const keys = [between()];
    for (let i = 0; i < 2000; i++) {
      const at = Math.floor(random() * (keys.length + 1));
      keys.splice(at, 0, between(keys[at - 1] ?? null, keys[at] ?? null));
    }
    assert.ok(sorted(keys));
    assert.strictEqual(new Set(keys).size, keys.length, 'all distinct');
  });

  await t.test('spread gives n keys evenly; jitter keeps the order', () => {
    const ten = spread(null, null, 10);
    assert.strictEqual(ten.length, 10);
    assert.ok(sorted(ten));
    const inner = spread(ten[2], ten[3], 5);
    assert.ok(sorted([ten[2], ...inner, ten[3]]));
    assert.deepStrictEqual(spread(null, null, 0), []);
    assert.throws(() => spread(null, null, -1), TypeError);
    const a = between();
    const b = between(a);
    const jittered = Array.from({ length: 50 }, () => between(a, b, { jitter: 3 }));
    assert.ok(jittered.every((k) => a < k && k < b && isKey(k)));
    assert.ok(new Set(jittered).size > 1, 'jitter tells concurrent inserts apart');
  });
});
