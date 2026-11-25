'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vector = require('../src/vector.js');

describe('vector module', () => {
  it('should tell behind, ahead, equal or concurrent with compareVectors', () => {
    assert.strictEqual(vector.compareVectors({ a: 1 }, { a: 1 }), 0);
    assert.strictEqual(vector.compareVectors({}, {}), 0);
    assert.strictEqual(vector.compareVectors({ a: 1 }, { a: 2 }), -1);
    assert.strictEqual(vector.compareVectors({ a: 2, b: 1 }, { a: 2 }), 1);
    assert.strictEqual(vector.compareVectors({}, { a: 1 }), -1, 'a missing key reads as 0');
    assert.strictEqual(vector.compareVectors({ a: 2 }, { b: 2 }), undefined, 'each ahead somewhere: concurrent');
    assert.strictEqual(vector.compareVectors({ a: 1, b: 3 }, { a: 2, b: 2 }), undefined);
  });

  it('should order by ts, then origin, in compareClock, and treat null as oldest', () => {
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

  it('should join with vectorMax and test an op with vectorHas', () => {
    assert.deepStrictEqual(vector.vectorMax({ a: 2, b: 1 }, { a: 1, c: 3 }), { a: 2, b: 1, c: 3 });
    assert.strictEqual(vector.vectorHas({ a: 3 }, { origin: 'a', seq: 3 }), true);
    assert.strictEqual(vector.vectorHas({ a: 3 }, { origin: 'a', seq: 4 }), false);
    assert.strictEqual(vector.vectorHas({}, { origin: 'a', seq: 1 }), false);
  });

  it('should round-trip event ids and reject garbage', () => {
    assert.strictEqual(vector.formatEventId('ep', 7), 'ep.7');
    assert.deepStrictEqual(vector.parseEventId('ep.7'), { epoch: 'ep', seq: 7 });
    assert.deepStrictEqual(vector.parseEventId('a.b.7'), { epoch: 'a.b', seq: 7 });
    assert.strictEqual(vector.parseEventId('nodot'), null);
    assert.strictEqual(vector.parseEventId('.7'), null);
    assert.strictEqual(vector.parseEventId('ep.x'), null);
    assert.strictEqual(vector.parseEventId('ep.-1'), null);
    assert.strictEqual(vector.parseEventId(7), null);
  });

  it('should keep the Clock monotonic, never behind an observed stamp', () => {
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
