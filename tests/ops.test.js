'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  applyOp,
  mergeEntry,
  isAlive,
  createEntry,
  isCounter,
  latestClock,
  packOps,
  unpackOps,
} = require('../src/ops.js');

const op = (type, ts, origin, extra = {}) => ({ type, ts, origin, seq: extra.seq ?? ts, id: 'r', ...extra });

// Every permutation of a list — the commutativity check runs them all.
const permutations = (items) => {
  if (items.length <= 1) return [items];
  const out = [];
  items.forEach((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) out.push([item, ...tail]);
  });
  return out;
};

const replay = (ops) => {
  let entry = null;
  for (const item of ops) entry = applyOp(entry, item).entry;
  return entry;
};

// Storage applies one origin's ops in seq order, so only interleavings that
// keep that order are reachable — those are the ones that must agree.
const orderedPerOrigin = (sequence) => {
  const last = {};
  for (const item of sequence) {
    if ((last[item.origin] ?? 0) > item.seq) return false;
    last[item.origin] = item.seq;
  }
  return true;
};

const assertCommutes = (ops, expectedData) => {
  const results = permutations(ops).filter(orderedPerOrigin).map(replay);
  for (const result of results) {
    assert.deepStrictEqual(result.data, expectedData);
    assert.deepStrictEqual(result.meta, results[0].meta);
  }
};

test('ops module', async (t) => {
  await t.test('set is last-writer-wins per field', () => {
    const a = applyOp(null, op('set', 1, 'A', { data: { x: 1, y: 1 } }));
    assert.strictEqual(a.changed, true);
    assert.deepStrictEqual(a.delta, { x: 1, y: 1 });
    const b = applyOp(a.entry, op('set', 2, 'B', { data: { x: 2 } }));
    assert.deepStrictEqual(b.entry.data, { x: 2, y: 1 });
    // An older concurrent write to x loses; y is untouched.
    const c = applyOp(b.entry, op('set', 1, 'C', { data: { x: 9 } }));
    assert.strictEqual(c.changed, false);
    assert.deepStrictEqual(c.entry.data, { x: 2, y: 1 });
    // Equal ts: the origin breaks the tie deterministically.
    assertCommutes([op('set', 5, 'A', { data: { x: 'a' } }), op('set', 5, 'B', { data: { x: 'b' } })], { x: 'b' });
  });

  await t.test('applying the same op twice is a no-op', () => {
    const first = applyOp(null, op('set', 1, 'A', { data: { x: 1 } }));
    const again = applyOp(first.entry, op('set', 1, 'A', { data: { x: 1 } }));
    assert.strictEqual(again.changed, false);
    assert.deepStrictEqual(again.entry, first.entry);
    const inc = applyOp(first.entry, op('inc', 2, 'A', { seq: 2, key: 'n', value: 3 }));
    const incAgain = applyOp(inc.entry, op('inc', 2, 'A', { seq: 2, key: 'n', value: 3 }));
    assert.strictEqual(incAgain.changed, false);
    assert.strictEqual(incAgain.entry.data.n, 3);
  });

  await t.test('write resets the record and commutes with a concurrent set', () => {
    // set@7 to a field the write@6 does not carry survives; set@5 does not.
    assertCommutes(
      [
        op('set', 5, 'S', { data: { old: 1 } }),
        op('write', 6, 'W', { data: { fresh: true } }),
        op('set', 7, 'T', { data: { later: 2 } }),
      ],
      { fresh: true, later: 2 },
    );
    // A write and a set on the SAME field: the newer stamp wins either way.
    assertCommutes([op('write', 6, 'W', { data: { x: 'w' } }), op('set', 7, 'T', { data: { x: 't' } })], { x: 't' });
    assertCommutes([op('write', 8, 'W', { data: { x: 'w' } }), op('set', 7, 'T', { data: { x: 't' } })], { x: 'w' });
  });

  await t.test('delete tombstones; a newer write revives; an older set does not', () => {
    const live = replay([op('set', 1, 'A', { data: { x: 1 } })]);
    const dead = applyOp(live, op('delete', 2, 'B')).entry;
    assert.strictEqual(isAlive(dead), false);
    assert.deepStrictEqual(dead.data, {});
    const stale = applyOp(dead, op('set', 1, 'C', { data: { x: 9 } }));
    assert.strictEqual(isAlive(stale.entry), false);
    assert.strictEqual(stale.changed, false);
    const revived = applyOp(dead, op('set', 3, 'C', { data: { y: 2 } }));
    assert.strictEqual(isAlive(revived.entry), true);
    assert.deepStrictEqual(revived.entry.data, { y: 2 });
    assertCommutes(
      [op('set', 1, 'A', { data: { x: 1 } }), op('delete', 2, 'B'), op('write', 3, 'C', { data: { z: 1 } })],
      {
        z: 1,
      },
    );
    assertCommutes([op('delete', 2, 'B'), op('set', 1, 'A', { data: { x: 1 } })], {});
    assert.strictEqual(isAlive(null), false);
    assert.strictEqual(isAlive(createEntry()), true);
  });

  await t.test('inc is a per-origin counter: commutative, idempotent, summed', () => {
    const ops = [
      op('inc', 1, 'A', { seq: 1, key: 'n', value: 2 }),
      op('inc', 2, 'B', { seq: 1, key: 'n', value: 3 }),
      op('inc', 3, 'A', { seq: 2, key: 'n', value: -1 }),
    ];
    assertCommutes(ops, { n: 4 });
    const entry = replay(ops);
    assert.strictEqual(isCounter(entry.meta, 'n'), true);
    assert.deepStrictEqual(entry.meta.counters.n, { A: [2, 1, 3], B: [1, 3, 2] });
    // A counter revives a tombstone like any newer write.
    const dead = applyOp(entry, op('delete', 5, 'D')).entry;
    assert.strictEqual(isAlive(dead), false);
    const back = applyOp(dead, op('inc', 6, 'A', { seq: 3, key: 'n', value: 1 })).entry;
    assert.strictEqual(isAlive(back), true);
    assert.deepStrictEqual(back.data, { n: 1 });
  });

  await t.test('a field is a register or a counter, never both', () => {
    const register = replay([op('set', 1, 'A', { data: { n: 1 } })]);
    const incOnRegister = applyOp(register, op('inc', 2, 'B', { seq: 1, key: 'n', value: 1 }));
    assert.deepStrictEqual(incOnRegister.rejected, [{ field: 'n', reason: 'register' }]);
    assert.strictEqual(incOnRegister.changed, false);
    const counter = replay([op('inc', 1, 'A', { seq: 1, key: 'n', value: 1 })]);
    const setOnCounter = applyOp(counter, op('set', 2, 'B', { data: { n: 5, other: 1 } }));
    assert.deepStrictEqual(setOnCounter.rejected, [{ field: 'n', reason: 'counter' }]);
    assert.deepStrictEqual(setOnCounter.entry.data, { n: 1, other: 1 });
    // Malformed ops are ignored rather than applied half-way.
    assert.strictEqual(applyOp(counter, op('set', 3, 'B', { data: 'nope' })).changed, false);
    assert.strictEqual(applyOp(counter, op('inc', 3, 'B', { key: 'n', value: 'nope' })).changed, false);
    assert.strictEqual(applyOp(counter, op('bogus', 3, 'B')).changed, false);
    // Inherited keys are not fields; a JSON "__proto__" key is skipped.
    assert.strictEqual(applyOp(counter, op('set', 3, 'B', { data: { __proto__: { evil: 1 } } })).changed, false);
    const poisoned = applyOp(counter, op('set', 3, 'B', { data: JSON.parse('{"__proto__":{"evil":1},"ok":1}') }));
    assert.deepStrictEqual(poisoned.entry.data, { n: 1, ok: 1 });
    assert.strictEqual(Object.getPrototypeOf(poisoned.entry.data), Object.prototype);
  });

  await t.test('a reset drops counter entries older than it', () => {
    assertCommutes([op('inc', 1, 'A', { seq: 1, key: 'n', value: 5 }), op('write', 2, 'W', { data: { x: 1 } })], {
      x: 1,
    });
    assertCommutes([op('write', 2, 'W', { data: { x: 1 } }), op('inc', 3, 'A', { seq: 2, key: 'n', value: 5 })], {
      x: 1,
      n: 5,
    });
  });

  await t.test('latestClock is the newest stamp an entry holds, or null', () => {
    assert.strictEqual(latestClock(null), null);
    assert.strictEqual(latestClock(createEntry().meta), null);
    const meta = {
      clock: { a: [5, 'x'], b: [9, 'y'] },
      base: [3, 'x'],
      deleted: null,
      counters: { hits: { x: [1, 2, 7], z: [4, 1, 9] } },
    };
    assert.deepStrictEqual(latestClock(meta), [9, 'z'], 'ties break by origin, like compareClock');
    meta.deleted = [12, 'x'];
    assert.deepStrictEqual(latestClock(meta), [12, 'x']);
    // Peer-shaped garbage is tolerated, not trusted.
    assert.deepStrictEqual(latestClock({ clock: { a: 'nope', b: [2, 'b'] }, counters: { c: 3, d: { o: 'x' } } }), [
      2,
      'b',
    ]);
  });

  await t.test('mergeEntry joins two histories like replaying both', () => {
    const left = [op('set', 1, 'A', { data: { x: 1, y: 1 } }), op('inc', 2, 'A', { seq: 2, key: 'n', value: 2 })];
    const right = [
      op('set', 3, 'B', { data: { x: 2 } }),
      op('inc', 4, 'B', { seq: 1, key: 'n', value: 3 }),
      op('delete', 5, 'B'),
      op('set', 6, 'B', { data: { z: 1 } }),
    ];
    const merged = mergeEntry(replay(left), replay(right));
    const replayed = replay([...left, ...right]);
    assert.deepStrictEqual(merged.data, replayed.data);
    assert.deepStrictEqual(merged.meta, replayed.meta);
    // Idempotent and commutative.
    assert.deepStrictEqual(mergeEntry(merged, merged), merged);
    assert.deepStrictEqual(mergeEntry(replay(right), replay(left)), merged);
    assert.deepStrictEqual(mergeEntry(null, merged), merged);
    assert.deepStrictEqual(mergeEntry(merged, null), merged);
    assert.strictEqual(mergeEntry(null, null), null);
    // Overlapping counter histories join by the higher seq, not by adding.
    const a = replay([
      op('inc', 1, 'A', { seq: 1, key: 'n', value: 1 }),
      op('inc', 2, 'A', { seq: 2, key: 'n', value: 1 }),
    ]);
    const b = replay([op('inc', 1, 'A', { seq: 1, key: 'n', value: 1 })]);
    assert.deepStrictEqual(mergeEntry(a, b).data, { n: 2 });
    // A register on one side and a counter on the other: the register wins.
    const reg = replay([op('set', 9, 'R', { data: { n: 'text' } })]);
    const cnt = replay([op('inc', 1, 'C', { seq: 1, key: 'n', value: 4 })]);
    assert.deepStrictEqual(mergeEntry(reg, cnt).data, { n: 'text' });
    assert.deepStrictEqual(mergeEntry(cnt, reg).data, { n: 'text' });
  });

  await t.test('meta.v is the schema version of the last whole-record write', () => {
    const fresh = applyOp(null, op('set', 1, 'A', { data: { x: 1 }, v: 2 }));
    assert.strictEqual(fresh.entry.meta.v, 2, 'a set that creates the entry takes its v');
    const later = applyOp(fresh.entry, op('set', 2, 'B', { data: { x: 2 }, v: 3 }));
    assert.strictEqual(later.entry.meta.v, 2, 'a later set leaves it');
    const incremented = applyOp(later.entry, op('inc', 3, 'B', { seq: 3, key: 'n', value: 1, v: 3 }));
    assert.strictEqual(incremented.entry.meta.v, 2);
    const written = applyOp(incremented.entry, op('write', 4, 'B', { data: { x: 3 }, v: 3 }));
    assert.strictEqual(written.entry.meta.v, 3, 'a write sets it');
    const stale = applyOp(written.entry, op('write', 1, 'C', { data: { x: 0 }, v: 9 }));
    assert.strictEqual(stale.entry.meta.v, 3, 'a stale write does not');
    const deleted = applyOp(written.entry, op('delete', 5, 'B', { v: 4 }));
    assert.strictEqual(deleted.entry.meta.v, 3);
    const unversioned = applyOp(written.entry, op('write', 6, 'D', { data: { x: 4 } }));
    assert.strictEqual(unversioned.entry.meta.v, 3, 'a write without v keeps the last one');
    assert.strictEqual(applyOp(null, op('write', 1, 'A', { data: { x: 1 } })).entry.meta.v, undefined);
    assert.strictEqual('v' in createEntry().meta, false);
    // Merges take the higher one; a peer meta is normalized.
    const a = replay([op('write', 1, 'A', { data: { x: 1 }, v: 2 })]);
    const b = replay([op('write', 2, 'B', { data: { y: 1 }, v: 5 })]);
    assert.strictEqual(mergeEntry(a, b).meta.v, 5);
    assert.strictEqual(mergeEntry(b, a).meta.v, 5);
    assert.strictEqual(mergeEntry(a, replay([op('write', 3, 'C', { data: {} })])).meta.v, 2);
    const merged = applyOp(null, op('merge', 1, 'A', { data: { x: 1 }, meta: { ...a.meta, v: '7' } }));
    assert.strictEqual(merged.entry.meta.v, undefined, 'a non-integer v is dropped');
    const joined = applyOp(a, op('merge', 1, 'A', { data: b.data, meta: b.meta }));
    assert.strictEqual(joined.entry.meta.v, 5);
  });

  await t.test('packOps carries v and actor in its 13th and 14th slots; older rows read without them', () => {
    const ops = [
      { origin: 'A', seq: 1, ts: 1, type: 'write', id: 'r', scope: 's', data: { x: 1 }, v: 2, actor: 'u1' },
      { origin: 'A', seq: 2, ts: 2, type: 'inc', id: 'r', key: 'n', value: 1 },
      { origin: 'A', seq: 3, ts: 3, type: 'advance', vector: { B: 4 }, from: 'B' },
    ];
    const packed = packOps(ops);
    assert.strictEqual(packed[0].length, 14);
    assert.strictEqual(packed[0][12], 2);
    assert.strictEqual(packed[0][13], 'u1');
    assert.strictEqual(packed[1][12], null);
    assert.strictEqual(packed[1][13], null);
    assert.deepStrictEqual(unpackOps(JSON.parse(JSON.stringify(packed))), ops);
    // Rows of the previous shapes (13 and 12 slots) and a short one.
    assert.deepStrictEqual(
      unpackOps([packed[0].slice(0, 13)]),
      [ops[0]].map(({ actor, ...op }) => op),
    );
    assert.deepStrictEqual(
      unpackOps([packed[0].slice(0, 12)]),
      [ops[0]].map(({ v, actor, ...op }) => op),
    );
    assert.deepStrictEqual(unpackOps([['A', 1, 1, 'w', 'r']]), [
      { origin: 'A', seq: 1, ts: 1, type: 'write', id: 'r' },
    ]);
    assert.deepStrictEqual(unpackOps([['A', 1, 1, 'w'], 'nope']), []);
    assert.deepStrictEqual(unpackOps('nope'), []);
  });
});
