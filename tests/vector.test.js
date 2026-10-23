'use strict';

const test = require('node:test');
const assert = require('node:assert');
const vector = require('../src/vector.js');

test('vector module', async (t) => {
  await t.test('compareClock orders by ts, then origin, and treats null as oldest', () => {
    assert.strictEqual(vector.compareClock([1, 'a'], [2, 'a']), -1);
    assert.strictEqual(vector.compareClock([2, 'a'], [1, 'z']), 1);
    assert.strictEqual(vector.compareClock([1, 'a'], [1, 'b']), -1);
    assert.strictEqual(vector.compareClock([1, 'b'], [1, 'a']), 1);
    assert.strictEqual(vector.compareClock([1, 'a'], [1, 'a']), 0);
    assert.strictEqual(vector.compareClock(null, [1, 'a']), -1);
    assert.strictEqual(vector.compareClock([1, 'a'], null), 1);
    assert.strictEqual(vector.compareClock(null, null), 0);
    assert.deepStrictEqual(vector.maxClock([1, 'a'], [1, 'b']), [1, 'b']);
    assert.deepStrictEqual(vector.maxClock(null, [1, 'b']), [1, 'b']);
  });

  await t.test('vectorMax and vectorHas', () => {
    assert.deepStrictEqual(vector.vectorMax({ a: 2, b: 1 }, { a: 1, c: 3 }), { a: 2, b: 1, c: 3 });
    assert.strictEqual(vector.vectorHas({ a: 3 }, { origin: 'a', seq: 3 }), true);
    assert.strictEqual(vector.vectorHas({ a: 3 }, { origin: 'a', seq: 4 }), false);
    assert.strictEqual(vector.vectorHas({}, { origin: 'a', seq: 1 }), false);
  });

  await t.test('event ids round-trip and reject garbage', () => {
    assert.strictEqual(vector.formatEventId('ep', 7), 'ep.7');
    assert.deepStrictEqual(vector.parseEventId('ep.7'), { epoch: 'ep', seq: 7 });
    assert.deepStrictEqual(vector.parseEventId('a.b.7'), { epoch: 'a.b', seq: 7 });
    assert.strictEqual(vector.parseEventId('nodot'), null);
    assert.strictEqual(vector.parseEventId('.7'), null);
    assert.strictEqual(vector.parseEventId('ep.x'), null);
    assert.strictEqual(vector.parseEventId('ep.-1'), null);
    assert.strictEqual(vector.parseEventId(7), null);
  });

  await t.test('Clock is monotonic and never falls behind an observed stamp', () => {
    const clock = new vector.Clock();
    const a = clock.now();
    const b = clock.now();
    assert.ok(b > a);
    clock.observe(b + 1_000_000);
    assert.ok(clock.now() > b + 1_000_000);
    clock.observe('nope');
    clock.observe(1);
    assert.ok(clock.now() > b + 1_000_000);
  });
});
