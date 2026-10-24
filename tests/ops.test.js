'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  applyOp,
  mergeEntry,
  isAlive,
  createEntry,
  isCounter,
  isSet,
  isSeq,
  observedTags,
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

  await t.test('add and remove keep an observed-remove set per field', () => {
    const added = applyOp(null, op('add', 1, 'A', { seq: 1, key: 'tags', value: ['bug', 'ui'] }));
    assert.strictEqual(added.changed, true);
    assert.deepStrictEqual(added.entry.data, { tags: ['bug', 'ui'] });
    assert.deepStrictEqual(added.delta, { tags: ['bug', 'ui'] });
    assert.deepStrictEqual(added.entry.meta.sets, { tags: { '"bug"': { A: [1, 0] }, '"ui"': { A: [1, 0] } } });
    assert.strictEqual(isSet(added.entry.meta, 'tags'), true);
    assert.strictEqual(isSet(added.entry.meta, 'other'), false);
    assert.strictEqual(isSet({ clock: {}, counters: {} }, 'tags'), false, 'an entry from before sets existed');
    // A set reads sorted by element text: it has no insertion order.
    const more = applyOp(added.entry, op('add', 2, 'B', { seq: 1, key: 'tags', value: ['api', 'bug'] })).entry;
    assert.deepStrictEqual(more.data.tags, ['api', 'bug', 'ui']);
    assert.deepStrictEqual(more.meta.sets.tags['"bug"'], { A: [1, 0], B: [2, 0] });
    assert.strictEqual(applyOp(more, op('add', 2, 'B', { seq: 1, key: 'tags', value: ['api', 'bug'] })).changed, false);
    // A remove carries the tags its node observed; only those die.
    const tags = observedTags(more.meta, 'tags', ['bug', 'nope']);
    assert.deepStrictEqual(tags, [['bug', { A: 1, B: 2 }]]);
    const removed = applyOp(more, op('remove', 3, 'C', { seq: 1, key: 'tags', value: tags }));
    assert.deepStrictEqual(removed.entry.data.tags, ['api', 'ui']);
    assert.deepStrictEqual(removed.delta, { tags: ['api', 'ui'] });
    assert.deepStrictEqual(removed.entry.meta.sets.tags['"bug"'], { A: [1, 1], B: [2, 2] });
    assert.strictEqual(
      applyOp(removed.entry, op('remove', 3, 'C', { seq: 1, key: 'tags', value: tags })).changed,
      false,
    );
    // A dead tag is still observed (a peer may not have seen it die yet).
    assert.deepStrictEqual(observedTags(removed.entry.meta, 'tags', ['bug']), [['bug', { A: 1, B: 2 }]]);
    // Removing what nobody added, or nothing, is nothing.
    assert.deepStrictEqual(observedTags(removed.entry.meta, 'tags', ['nope']), []);
    assert.deepStrictEqual(observedTags(removed.entry.meta, 'other', ['bug']), []);
    assert.deepStrictEqual(observedTags(null, 'tags', ['bug']), []);
    assert.strictEqual(applyOp(removed.entry, op('remove', 4, 'C', { seq: 2, key: 'tags', value: [] })).changed, false);
    // A set with nothing live reads as [] and is still a set.
    const all = observedTags(removed.entry.meta, 'tags', ['ui', 'api']);
    const empty = applyOp(removed.entry, op('remove', 5, 'C', { seq: 3, key: 'tags', value: all })).entry;
    assert.deepStrictEqual(empty.data, { tags: [] });
    assert.strictEqual(isSet(empty.meta, 'tags'), true);
    // Elements are JSON values, told apart by their text.
    // Sorted by key — the JSON text — whatever the add said.
    const mixed = replay([op('add', 1, 'A', { seq: 1, key: 's', value: [1, '1', { a: 1 }, [2], null, true] })]);
    assert.deepStrictEqual(mixed.data.s, ['1', 1, [2], null, true, { a: 1 }]);
    assert.deepStrictEqual(Object.keys(mixed.meta.sets.s).sort(), ['"1"', '1', '[2]', 'null', 'true', '{"a":1}']);
    // The previous entry is untouched: applyOp hands out a new one.
    assert.deepStrictEqual(added.entry.data, { tags: ['bug', 'ui'] });
    assert.deepStrictEqual(added.entry.meta.sets.tags['"bug"'], { A: [1, 0] });
  });

  await t.test('a set converges: concurrent adds both keep, an unobserved add beats a remove', () => {
    const add = (ts, origin, seq, elements) => op('add', ts, origin, { seq, key: 't', value: elements });
    const remove = (ts, origin, seq, tags) => op('remove', ts, origin, { seq, key: 't', value: tags });
    assertCommutes([add(1, 'A', 1, ['p']), add(2, 'B', 1, ['q'])], { t: ['p', 'q'] });
    // B removes what it saw of A's add@1; A's re-add@3 was not seen: it survives.
    assertCommutes([add(1, 'A', 1, ['x']), remove(2, 'B', 1, [['x', { A: 1 }]]), add(3, 'A', 2, ['x'])], { t: ['x'] });
    // The remove observed the newest add: the element goes in any order — a
    // remove that lands before the add it observed kills it on arrival.
    assertCommutes([add(1, 'A', 1, ['x']), remove(2, 'B', 1, [['x', { A: 1 }]])], { t: [] });
    // Re-add by the remover itself.
    assertCommutes([add(1, 'A', 1, ['x']), remove(2, 'B', 1, [['x', { A: 1 }]]), add(3, 'B', 2, ['x'])], { t: ['x'] });
    // Two origins add the same element; one remove observed only one of them.
    assertCommutes([add(1, 'A', 1, ['x']), add(2, 'B', 1, ['x']), remove(3, 'C', 1, [['x', { A: 1 }]])], {
      t: ['x'],
    });
    assertCommutes([add(1, 'A', 1, ['x']), add(2, 'B', 1, ['x']), remove(3, 'C', 1, [['x', { A: 1, B: 2 }]])], {
      t: [],
    });
  });

  await t.test('a reset drops set tags older than it and clamps the rest, so metas agree too', () => {
    const add = (ts, origin, seq, elements) => op('add', ts, origin, { seq, key: 't', value: elements });
    const remove = (ts, origin, seq, tags) => op('remove', ts, origin, { seq, key: 't', value: tags });
    // A write without the field: the older add goes, the newer one stays.
    assertCommutes([add(1, 'A', 1, ['old']), op('write', 2, 'W', { data: { x: 1 } }), add(3, 'A', 2, ['new'])], {
      x: 1,
      t: ['new'],
    });
    // A remove whose tags are below the reset is moot: no empty set appears.
    assertCommutes(
      [add(1, 'A', 1, ['x']), op('write', 2, 'W', { data: { x: 1 } }), remove(3, 'B', 1, [['x', { A: 1 }]])],
      {
        x: 1,
      },
    );
    // The clamp: a removed tag below the reset reads as none whichever came first.
    assertCommutes(
      [
        add(1, 'A', 1, ['x']),
        remove(2, 'B', 1, [['x', { A: 1 }]]),
        add(5, 'A', 2, ['x']),
        op('write', 4, 'W', { data: { y: 1 } }),
      ],
      { y: 1, t: ['x'] },
    );
    const clamped = replay([add(1, 'A', 1, ['x']), remove(2, 'B', 1, [['x', { A: 1 }]]), add(5, 'A', 2, ['x'])]);
    const reset = applyOp(clamped, op('write', 4, 'W', { data: { y: 1 } }));
    assert.deepStrictEqual(reset.entry.meta.sets.t['"x"'], { A: [5, 0] });
    assert.deepStrictEqual(reset.delta, { y: 1 }, 'the array did not change, so the field is not in the delta');
    // A write carrying the field as a register: below a concurrent add it is
    // refused on that field; above every add it resets the set to a register.
    const concurrent = applyOp(replay([add(3, 'A', 1, ['x'])]), op('write', 2, 'W', { data: { t: 'w', z: 1 } }));
    assert.deepStrictEqual(concurrent.rejected, [{ field: 't', reason: 'set' }]);
    assert.deepStrictEqual(concurrent.entry.data, { t: ['x'], z: 1 });
    const over = applyOp(replay([add(1, 'A', 1, ['x'])]), op('write', 2, 'W', { data: { t: 'w' } }));
    assert.deepStrictEqual(over.rejected, []);
    assert.deepStrictEqual(over.entry.data, { t: 'w' });
    assert.deepStrictEqual(over.entry.meta.sets, {});
    // A tombstone: an add newer than it revives, an older one does not.
    const dead = replay([add(1, 'A', 1, ['x']), op('delete', 2, 'D')]);
    assert.strictEqual(isAlive(dead), false);
    assert.deepStrictEqual(dead.data, {});
    const back = applyOp(dead, add(3, 'A', 2, ['y'])).entry;
    assert.strictEqual(isAlive(back), true);
    assert.deepStrictEqual(back.data, { t: ['y'] });
    assertCommutes([op('delete', 2, 'D'), add(1, 'A', 1, ['x'])], {});
    assertCommutes([op('delete', 2, 'D'), add(3, 'A', 1, ['x'])], { t: ['x'] });
    // An add newer than the tombstone revives even once removed — like a
    // counter back at zero — and a remove alone never does.
    const gone = replay([op('delete', 2, 'D'), add(3, 'A', 1, ['x']), remove(4, 'B', 1, [['x', { A: 3 }]])]);
    assert.strictEqual(isAlive(gone), true);
    assert.deepStrictEqual(gone.data, { t: [] });
    assert.strictEqual(isAlive(replay([op('delete', 2, 'D'), remove(4, 'B', 1, [['x', { A: 3 }]])])), false);
  });

  await t.test('a field is a register, a counter or a set — never two of them', () => {
    const add = (ts, origin, seq, elements) => op('add', ts, origin, { seq, key: 't', value: elements });
    const register = replay([op('set', 1, 'A', { data: { t: 1 } })]);
    const addOnRegister = applyOp(register, add(2, 'B', 1, ['x']));
    assert.deepStrictEqual(addOnRegister.rejected, [{ field: 't', reason: 'register' }]);
    assert.strictEqual(addOnRegister.changed, false);
    const counter = replay([op('inc', 1, 'A', { seq: 1, key: 't', value: 1 })]);
    const removeOnCounter = applyOp(counter, op('remove', 2, 'B', { seq: 1, key: 't', value: [['x', { A: 1 }]] }));
    assert.deepStrictEqual(removeOnCounter.rejected, [{ field: 't', reason: 'counter' }]);
    assert.strictEqual(removeOnCounter.changed, false);
    const set = replay([add(1, 'A', 1, ['x'])]);
    const setOnSet = applyOp(set, op('set', 2, 'B', { data: { t: 5, other: 1 } }));
    assert.deepStrictEqual(setOnSet.rejected, [{ field: 't', reason: 'set' }]);
    assert.deepStrictEqual(setOnSet.entry.data, { t: ['x'], other: 1 });
    const incOnSet = applyOp(set, op('inc', 2, 'B', { seq: 1, key: 't', value: 1 }));
    assert.deepStrictEqual(incOnSet.rejected, [{ field: 't', reason: 'set' }]);
    assert.strictEqual(incOnSet.changed, false);
    // Merges: the register, then the counter, wins over a set.
    const reg = replay([op('set', 9, 'R', { data: { t: 'text' } })]);
    assert.deepStrictEqual(mergeEntry(reg, set).data, { t: 'text' });
    assert.deepStrictEqual(mergeEntry(set, reg).data, { t: 'text' });
    assert.deepStrictEqual(mergeEntry(set, reg).meta.sets, {});
    assert.deepStrictEqual(mergeEntry(counter, set).data, { t: 1 });
    assert.deepStrictEqual(mergeEntry(set, counter).data, { t: 1 });
    assert.deepStrictEqual(mergeEntry(set, counter).meta.sets, {});
    // Malformed payloads are ignored, not applied half-way.
    assert.strictEqual(applyOp(set, op('add', 2, 'B', { seq: 1, key: 't', value: 'nope' })).changed, false);
    assert.strictEqual(applyOp(set, op('add', 2, 'B', { seq: 1, key: 5, value: ['x'] })).changed, false);
    assert.strictEqual(
      applyOp(set, op('remove', 2, 'B', { seq: 1, key: 't', value: [['x', { A: 9 }]] })).changed,
      false,
    );
    const junk = [['x', { A: 1.5 }], ['x', { A: 0 }], ['x', { A: -1 }], ['x', 'nope'], ['x'], 'x', null];
    assert.strictEqual(applyOp(set, op('remove', 2, 'B', { seq: 1, key: 't', value: junk })).changed, false);
    const nothing = applyOp(set, op('add', 2, 'B', { seq: 1, key: 'u', value: [undefined, () => 1] }));
    assert.strictEqual(nothing.changed, false, 'nothing JSON can carry');
    assert.deepStrictEqual(nothing.entry.meta.sets, set.meta.sets, 'no empty map left behind');
    assert.strictEqual(applyOp(null, op('add', 1, 'A', { seq: 1, key: '__proto__', value: ['x'] })).changed, false);
    assert.strictEqual(applyOp(null, op('add', 1, '__proto__', { seq: 1, key: 't', value: ['x'] })).changed, false);
    assert.strictEqual(Object.hasOwn(Object.prototype, 't'), false);
  });

  await t.test('mergeEntry joins set histories like replaying both', () => {
    const add = (ts, origin, seq, elements) => op('add', ts, origin, { seq, key: 't', value: elements });
    const remove = (ts, origin, seq, tags) => op('remove', ts, origin, { seq, key: 't', value: tags });
    const left = [add(1, 'A', 1, ['p', 'q']), remove(2, 'A', 2, [['q', { A: 1 }]])];
    // B's remove observed A's add of p; replaying B alone holds that as a
    // removal waiting for the add.
    const right = [add(3, 'B', 1, ['q', 'r']), remove(4, 'B', 2, [['p', { A: 1 }]])];
    const merged = mergeEntry(replay(left), replay(right));
    const replayed = replay([...left, ...right]);
    assert.deepStrictEqual(merged.data, { t: ['q', 'r'] });
    assert.deepStrictEqual(merged.data, replayed.data);
    assert.deepStrictEqual(merged.meta, replayed.meta);
    assert.deepStrictEqual(merged.meta.sets.t['"p"'], { A: [1, 1] });
    assert.deepStrictEqual(replay(right).meta.sets.t['"p"'], { A: [0, 1] });
    assert.deepStrictEqual(mergeEntry(merged, merged), merged);
    assert.deepStrictEqual(mergeEntry(replay(right), replay(left)), merged);
    assert.deepStrictEqual(mergeEntry(null, merged), merged);
    // A merge op from a peer: the same join, through normalizeMeta.
    const joined = applyOp(replay(left), op('merge', 9, 'C', { data: replay(right).data, meta: replay(right).meta }));
    assert.strictEqual(joined.changed, true);
    assert.deepStrictEqual(joined.entry.data, merged.data);
    assert.deepStrictEqual(joined.entry.meta, merged.meta);
    assert.deepStrictEqual(joined.delta, { t: ['q', 'r'] });
    assert.strictEqual(
      applyOp(joined.entry, op('merge', 9, 'C', { data: merged.data, meta: merged.meta })).changed,
      false,
    );
    // Replaying with a reset in the middle still equals the merge.
    const withReset = [...left, op('delete', 5, 'B'), add(6, 'B', 3, ['s'])];
    const reset = mergeEntry(replay(left), replay([op('delete', 5, 'B'), add(6, 'B', 3, ['s'])]));
    assert.deepStrictEqual(reset.data, replay(withReset).data);
    assert.deepStrictEqual(reset.meta, replay(withReset).meta);
    assert.deepStrictEqual(reset.data, { t: ['s'] });
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
    // Both components of a set slot count: a removed tag this node has not
    // seen the add of is still a stamp it must not write below.
    meta.sets = { t: { '"x"': { y: [14, 0], z: [0, 15] } } };
    assert.deepStrictEqual(latestClock(meta), [15, 'z']);
    meta.sets.t['"x"'].z = [16, 15];
    assert.deepStrictEqual(latestClock(meta), [16, 'z']);
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

  await t.test('purge wins at any stamp, forever; a merge with a purged side is purged', () => {
    const live = replay([
      op('set', 5, 'A', { data: { x: 1, y: 1 } }),
      op('inc', 6, 'A', { seq: 6, key: 'n', value: 2 }),
      op('add', 7, 'A', { seq: 7, key: 't', value: ['x'] }),
    ]);
    const purged = applyOp(live, op('purge', 1, 'B', { seq: 1 }));
    assert.strictEqual(purged.changed, true, 'an older stamp still purges');
    assert.deepStrictEqual(purged.entry.data, {});
    assert.deepStrictEqual(purged.delta, { x: undefined, y: undefined, n: undefined, t: undefined });
    assert.deepStrictEqual(purged.entry.meta.counters, {});
    assert.deepStrictEqual(purged.entry.meta.sets, {});
    assert.deepStrictEqual(purged.entry.meta.clock, {});
    assert.deepStrictEqual(purged.entry.meta.purged, [1, 'B']);
    assert.strictEqual(isAlive(purged.entry), false);
    // Nothing later lands: a write, a set, an inc, a delete — at any stamp.
    for (const later of [
      op('write', 99, 'C', { data: { x: 2 } }),
      op('set', 99, 'C', { data: { x: 2 } }),
      op('inc', 99, 'C', { seq: 99, key: 'n', value: 1 }),
      op('add', 99, 'C', { seq: 99, key: 't', value: ['y'] }),
      op('delete', 99, 'C'),
    ]) {
      const result = applyOp(purged.entry, later);
      assert.strictEqual(result.changed, false, later.type);
      assert.deepStrictEqual(result.entry, purged.entry);
    }
    // Again, at the same stamp: a no-op; at a later one: the stamp moves.
    assert.strictEqual(applyOp(purged.entry, op('purge', 1, 'B', { seq: 1 })).changed, false);
    assert.strictEqual(applyOp(purged.entry, op('purge', 7, 'B', { seq: 7 })).changed, true);
    assert.strictEqual(applyOp(null, op('purge', 1, 'B', { seq: 1 })).changed, true, 'an unknown record is purged too');
    // Whatever order the purge and the writes arrive in, the result is the same.
    assertCommutes(
      [op('set', 5, 'A', { data: { x: 1 } }), op('purge', 1, 'B', { seq: 1 }), op('write', 9, 'C', { data: { z: 1 } })],
      {},
    );
    // Merges: a purged side wins.
    const other = replay([op('set', 8, 'D', { data: { x: 3 } })]);
    assert.deepStrictEqual(mergeEntry(purged.entry, other).data, {});
    assert.deepStrictEqual(mergeEntry(other, purged.entry).meta.purged, [1, 'B']);
    assert.strictEqual(isAlive(mergeEntry(other, purged.entry)), false);
    const joined = applyOp(other, op('merge', 1, 'E', { data: purged.entry.data, meta: purged.entry.meta }));
    assert.strictEqual(joined.changed, true);
    assert.deepStrictEqual(joined.entry.data, {});
    assert.deepStrictEqual(latestClock(purged.entry.meta), [1, 'B']);
    assert.deepStrictEqual(latestClock({ purged: [3, 'Z'], clock: { a: [1, 'A'] } }), [3, 'Z']);
    const packed = packOps([op('purge', 1, 'B', { seq: 1 })]);
    assert.strictEqual(packed[0][3], 'p');
    assert.strictEqual(unpackOps(packed)[0].type, 'purge');
  });

  await t.test(
    'packOps carries v, actor, sig, digest and nonce in slots 13 to 17; older rows read without them',
    () => {
      const sig = 'S'.repeat(86);
      const digest = 'd'.repeat(64);
      const ops = [
        {
          origin: 'A',
          seq: 1,
          ts: 1,
          type: 'write',
          id: 'r',
          scope: 's',
          data: { x: 1 },
          v: 2,
          actor: 'u1',
          sig,
          digest,
          nonce: 'n'.repeat(20),
        },
        { origin: 'A', seq: 2, ts: 2, type: 'inc', id: 'r', key: 'n', value: 1 },
        { origin: 'A', seq: 3, ts: 3, type: 'advance', vector: { B: 4 }, from: 'B', sig },
      ];
      const packed = packOps(ops);
      assert.strictEqual(packed[0].length, 17);
      assert.strictEqual(packed[0][12], 2);
      assert.strictEqual(packed[0][13], 'u1');
      assert.strictEqual(packed[0][14], sig);
      assert.strictEqual(packed[0][15], digest);
      assert.strictEqual(packed[0][16], 'n'.repeat(20));
      assert.deepStrictEqual(packed[1].slice(12), [null, null, null, null, null]);
      assert.deepStrictEqual(packed[2].slice(14), [sig, null, null]);
      assert.deepStrictEqual(unpackOps(JSON.parse(JSON.stringify(packed))), ops);
      // Rows of the previous shapes (14, 13 and 12 slots) and a short one.
      assert.deepStrictEqual(
        unpackOps([packed[0].slice(0, 14)]),
        [ops[0]].map(({ sig, digest, nonce, ...op }) => op),
      );
      assert.deepStrictEqual(
        unpackOps([packed[0].slice(0, 13)]),
        [ops[0]].map(({ actor, sig, digest, nonce, ...op }) => op),
      );
      assert.deepStrictEqual(
        unpackOps([packed[0].slice(0, 12)]),
        [ops[0]].map(({ v, actor, sig, digest, nonce, ...op }) => op),
      );
      assert.deepStrictEqual(unpackOps([['A', 1, 1, 'w', 'r']]), [
        { origin: 'A', seq: 1, ts: 1, type: 'write', id: 'r' },
      ]);
      assert.deepStrictEqual(unpackOps([['A', 1, 1, 'w'], 'nope']), []);
      assert.deepStrictEqual(unpackOps('nope'), []);
      // The set ops: `+` and `-`, their payload in the key/value slots like inc.
      const sets = [
        { origin: 'A', seq: 4, ts: 4, type: 'add', id: 'r', key: 't', value: ['x', { a: 1 }] },
        { origin: 'A', seq: 5, ts: 5, type: 'remove', id: 'r', key: 't', value: [['x', { A: 4 }]] },
      ];
      const rows = packOps(sets);
      assert.strictEqual(rows[0][3], '+');
      assert.strictEqual(rows[1][3], '-');
      assert.deepStrictEqual(rows[1][9], [['x', { A: 4 }]]);
      assert.deepStrictEqual(unpackOps(JSON.parse(JSON.stringify(rows))), sets);
    },
  );
});

test('ops: a peer-shaped meta reaches nothing it should not', async (t) => {
  await t.test('normalizeMeta rebuilds a merge meta from own keys and well-formed stamps alone', () => {
    const base = replay([op('set', 1, 'A', { data: { x: 1 } }), op('inc', 2, 'A', { seq: 2, key: 'n', value: 1 })]);
    const hostile = JSON.parse(
      '{"clock":{"__proto__":[5,"evil"],"x":"nope","y":[9,"B"],"constructor":[7,"B"]},' +
        '"counters":{"__proto__":{"pwned":[1,1,1]},"constructor":{"zzz":[1,1,1]},' +
        '"n":{"B":[1,"0abc",3],"C":[2,4,5],"__proto__":[1,1,1]}},' +
        '"base":"no","deleted":[1],"purged":{"a":1},"v":"2"}',
    );
    assert.deepStrictEqual(latestClock(hostile), [9, 'B']);
    const merged = applyOp(base, op('merge', 3, 'B', { data: { y: 2, constructor: 'c' }, meta: hostile }));
    assert.strictEqual(Object.hasOwn(Object.prototype, 'pwned'), false, 'Object.prototype is untouched');
    assert.strictEqual(Object.hasOwn(Object, 'zzz'), false, 'Object is untouched');
    assert.strictEqual(merged.changed, true);
    assert.deepStrictEqual(merged.entry.data, { x: 1, y: 2, constructor: 'c', n: 5 });
    assert.deepStrictEqual(Object.keys(merged.entry.meta.counters.n).sort(), ['A', 'C'], 'the malformed count is out');
    assert.strictEqual(Object.getPrototypeOf(merged.entry.meta.counters), Object.prototype);
    assert.strictEqual(Object.getPrototypeOf(merged.entry.meta.clock), Object.prototype);
    assert.strictEqual('v' in merged.entry.meta, false, 'a string v is not a version');
    assert.strictEqual(merged.entry.meta.base, null, 'a non-stamp base is none');
    assert.strictEqual(merged.entry.meta.deleted, null, 'a one-element array is not a stamp');
    assert.strictEqual('purged' in merged.entry.meta, false);
    // The peer's object is not kept by reference.
    const kept = applyOp(null, op('merge', 1, 'B', { data: { y: 1 }, meta: { clock: { y: [1, 'B'] }, counters: {} } }));
    hostile.clock.y[0] = 99;
    assert.deepStrictEqual(kept.entry.meta.clock.y, [1, 'B']);
  });

  await t.test('normalizeMeta keeps only well-formed set slots under canonical JSON keys', () => {
    const base = replay([op('add', 1, 'A', { seq: 1, key: 't', value: ['x'] })]);
    const hostile = JSON.parse(
      '{"sets":{"__proto__":{"\\"x\\"":{"A":[1,0]}},' +
        '"t":{"__proto__":{"A":[1,0]},"1.0":{"A":[1,0]},"nope":{"A":[1,0]},"{\\"b\\":1,\\"a\\":2}":{"A":[1,0]},' +
        '"\\"ok\\"":{"__proto__":[1,0],"A":[1,0],"B":[0,0],"C":[1,"x"],"D":[-1,2],"E":[2,1],"F":[1,0,0]}},' +
        '"empty":{"\\"x\\"":{"A":"no"}},"flat":"no"}}',
    );
    assert.deepStrictEqual(latestClock(hostile), [2, 'E']);
    const merged = applyOp(base, op('merge', 3, 'B', { data: { t: ['ok'] }, meta: hostile }));
    assert.strictEqual(Object.hasOwn(Object.prototype, 'A'), false, 'Object.prototype is untouched');
    assert.strictEqual(merged.changed, true);
    // `{"b":1,"a":2}` is canonical text too — elements are JSON text, not
    // JSON values, so key order tells two objects apart on every node alike.
    assert.deepStrictEqual(merged.entry.meta.sets, {
      t: { '"x"': { A: [1, 0] }, '{"b":1,"a":2}': { A: [1, 0] }, '"ok"': { A: [1, 0], E: [2, 1] } },
    });
    assert.deepStrictEqual(merged.entry.data, { t: ['ok', 'x', { b: 1, a: 2 }] });
    assert.strictEqual(Object.getPrototypeOf(merged.entry.meta.sets), Object.prototype);
    // The peer's object is not kept by reference.
    hostile.sets.t['"ok"'].A[0] = 99;
    assert.deepStrictEqual(merged.entry.meta.sets.t['"ok"'].A, [1, 0]);
    // A meta from before sets existed merges as an empty set of sets.
    const old = applyOp(base, op('merge', 4, 'B', { data: { y: 1 }, meta: { clock: { y: [4, 'B'] }, counters: {} } }));
    assert.deepStrictEqual(old.entry.data, { t: ['x'], y: 1 });
  });

  await t.test('splice keeps a list or a text per field; the first op decides the kind', () => {
    const splice = (ts, origin, seq, key, value) => op('splice', ts, origin, { seq, key, value });
    const first = applyOp(null, splice(1, 'A', 1, 'body', { at: '^', content: 'ab' }));
    assert.strictEqual(first.changed, true);
    assert.deepStrictEqual(first.entry.data, { body: 'ab' });
    assert.deepStrictEqual(first.delta, { body: 'ab' });
    assert.strictEqual(isSeq(first.entry.meta, 'body'), true);
    assert.strictEqual(isSeq(first.entry.meta, 'other'), false);
    assert.strictEqual(isSeq({ clock: {}, counters: {} }, 'body'), false, 'an entry from before sequences existed');
    assert.strictEqual(first.entry.meta.seqs.body.k, 't');
    assert.deepStrictEqual(Object.keys(first.entry.meta.seqs.body.runs), ['1:A']);
    // The same origin typing on extends the run; a cut keeps the places.
    const more = applyOp(first.entry, splice(2, 'A', 2, 'body', { run: '1:A', from: 2, content: 'c' }));
    assert.deepStrictEqual(more.entry.data, { body: 'abc' });
    assert.deepStrictEqual(Object.keys(more.entry.meta.seqs.body.runs), ['1:A']);
    const cut = applyOp(more.entry, splice(3, 'B', 1, 'body', { cut: [['1:A', 1, 1]], content: '' }));
    assert.deepStrictEqual(cut.entry.data, { body: 'ac' });
    assert.deepStrictEqual(cut.delta, { body: 'ac' });
    assert.deepStrictEqual(cut.entry.meta.seqs.body.runs['1:A'], ['^', ['a', 1, 'c']]);
    assert.strictEqual(
      applyOp(cut.entry, splice(3, 'B', 1, 'body', { cut: [['1:A', 1, 1]], content: '' })).changed,
      false,
    );
    // A list holds JSON values.
    const list = applyOp(cut.entry, splice(4, 'A', 3, 'items', { at: '^', content: [1, { x: 2 }] }));
    assert.deepStrictEqual(list.entry.data, { body: 'ac', items: [1, { x: 2 }] });
    assert.strictEqual(list.entry.meta.seqs.items.k, 'l');
    // The kinds never meet: a list op on a text, a text op on a list.
    const clash = applyOp(list.entry, splice(5, 'B', 2, 'body', { at: '^', content: ['x'] }));
    assert.deepStrictEqual([clash.changed, clash.rejected], [false, [{ field: 'body', reason: 'text' }]]);
    const clash2 = applyOp(list.entry, splice(5, 'B', 2, 'items', { at: '^', content: 'x' }));
    assert.deepStrictEqual([clash2.changed, clash2.rejected], [false, [{ field: 'items', reason: 'list' }]]);
    // A malformed payload is nothing; a duplicate is nothing.
    for (const value of ['nope', null, { content: 5 }, { at: '^' }, { at: '$', content: 'x' }, { content: '' }]) {
      const r = applyOp(list.entry, splice(6, 'C', 1, 'body', value));
      assert.deepStrictEqual([r.changed, r.rejected], [false, []], JSON.stringify(value));
    }
    assert.strictEqual(
      applyOp(list.entry, splice(4, 'A', 3, 'items', { at: '^', content: [1, { x: 2 }] })).changed,
      false,
    );
    // A cut that arrives before any run of its field is news: the field
    // exists, reads empty, and remembers what to cut.
    const early = applyOp(null, splice(9, 'C', 1, 'body', { cut: [['8:A', 0, 1]], content: '' }));
    assert.strictEqual(early.changed, true);
    assert.deepStrictEqual(early.entry.data, { body: '' });
    assert.deepStrictEqual(early.entry.meta.seqs.body.cuts, { '8:A': [[0, 1]] });
    const late = applyOp(early.entry, splice(8, 'A', 1, 'body', { at: '^', content: 'xy' }));
    assert.deepStrictEqual(late.entry.data, { body: 'y' });
    assert.strictEqual(late.entry.meta.seqs.body.cuts, undefined);
    // The previous entry is untouched: applyOp hands out a new one.
    assert.deepStrictEqual(first.entry.data, { body: 'ab' });
    assert.deepStrictEqual(first.entry.meta.seqs.body.runs['1:A'], ['^', ['ab']]);
  });

  await t.test('a list or a text is never also a register, a counter or a set', () => {
    const splice = (ts, origin, seq, key, value) => op('splice', ts, origin, { seq, key, value });
    const text = replay([splice(10, 'A', 1, 'body', { at: '^', content: 'ab' })]);
    const set = applyOp(text, op('set', 11, 'B', { data: { body: 'plain', ok: 1 } }));
    assert.deepStrictEqual(set.rejected, [{ field: 'body', reason: 'text' }]);
    assert.deepStrictEqual(set.entry.data, { body: 'ab', ok: 1 });
    const inc = applyOp(text, op('inc', 11, 'B', { seq: 1, key: 'body', value: 1 }));
    assert.deepStrictEqual([inc.changed, inc.rejected], [false, [{ field: 'body', reason: 'text' }]]);
    const add = applyOp(text, op('add', 11, 'B', { seq: 1, key: 'body', value: ['x'] }));
    assert.deepStrictEqual([add.changed, add.rejected], [false, [{ field: 'body', reason: 'text' }]]);
    const list = replay([splice(10, 'A', 1, 'items', { at: '^', content: [1] })]);
    assert.deepStrictEqual(applyOp(list, op('inc', 11, 'B', { seq: 1, key: 'items', value: 1 })).rejected, [
      { field: 'items', reason: 'list' },
    ]);
    // And the other way round.
    const reg = replay([op('set', 1, 'A', { data: { body: 'x' } })]);
    assert.deepStrictEqual(applyOp(reg, splice(2, 'B', 1, 'body', { at: '^', content: 'y' })).rejected, [
      { field: 'body', reason: 'register' },
    ]);
    const counter = replay([op('inc', 1, 'A', { seq: 1, key: 'n', value: 1 })]);
    assert.deepStrictEqual(applyOp(counter, splice(2, 'B', 1, 'n', { at: '^', content: 'y' })).rejected, [
      { field: 'n', reason: 'counter' },
    ]);
    const tags = replay([op('add', 1, 'A', { seq: 1, key: 'tags', value: ['x'] })]);
    assert.deepStrictEqual(applyOp(tags, splice(2, 'B', 1, 'tags', { at: '^', content: 'y' })).rejected, [
      { field: 'tags', reason: 'set' },
    ]);
    // A whole-record write above every run resets the field to a register;
    // one below the runs leaves the text and is refused for that field.
    const above = applyOp(text, op('write', 20, 'B', { data: { body: 'plain' } }));
    assert.deepStrictEqual([above.entry.data, above.rejected], [{ body: 'plain' }, []]);
    assert.strictEqual(isSeq(above.entry.meta, 'body'), false);
    const below = applyOp(text, op('write', 5, 'B', { data: { body: 'plain' } }));
    assert.deepStrictEqual([below.entry.data, below.rejected], [{ body: 'ab' }, [{ field: 'body', reason: 'text' }]]);
  });

  await t.test('a text converges: concurrent inserts, cuts, extensions and a reset, in any order', () => {
    const splice = (ts, origin, seq, key, value) => op('splice', ts, origin, { seq, key, value });
    const a1 = splice(10, 'A', 1, 'body', { at: '^', content: 'ab' });
    const b1 = splice(20, 'B', 1, 'body', { at: '>10:1:A', content: 'X' }); // after b, having seen ab
    const a2 = splice(30, 'A', 2, 'body', { run: '10:A', from: 2, content: 'c' }); // A types on, unaware of X
    const b2 = splice(35, 'B', 2, 'body', { at: '<10:0:A', content: 'Y' }); // before a
    const c1 = splice(40, 'C', 1, 'body', { cut: [['10:A', 0, 1]], content: '' }); // deletes a
    assertCommutes([a1, b1, a2, b2, c1], { body: 'YbcX' });
    // A reset in the middle drops every run below it; Y, stamped above and
    // anchored on a dropped element, reads from the head.
    const reset = op('write', 25, 'D', { data: {} });
    assertCommutes([a1, b1, a2, b2, c1, reset], { body: 'Y' });
    const after = replay([a1, b1, a2, reset, b2, c1]);
    assert.strictEqual(after.meta.seqs.body.cuts, undefined, 'a cut on a dropped run is dropped too');
    assert.deepStrictEqual(Object.keys(after.meta.seqs.body.runs), ['35:B']);
    // A reset above everything frees the field.
    const gone = applyOp(after, op('delete', 50, 'D'));
    assert.deepStrictEqual(gone.entry.data, {});
    assert.strictEqual(gone.entry.meta.seqs.body, undefined);
    assert.deepStrictEqual(gone.delta, { body: undefined });
    assert.strictEqual(isAlive(gone.entry), false);
    // Typing after the tombstone revives the record.
    const revived = applyOp(gone.entry, splice(60, 'A', 3, 'body', { at: '^', content: 'z' }));
    assert.strictEqual(isAlive(revived.entry), true);
    assert.deepStrictEqual(revived.entry.data, { body: 'z' });
    assert.deepStrictEqual(latestClock(revived.entry.meta), [60, '']);
  });

  await t.test('a list moves and assigns through applyOp; concurrent moves leave the element once', () => {
    const items = (ts, origin, seq, value) => op('splice', ts, origin, { seq, key: 'items', value });
    const a1 = items(10, 'A', 1, { at: '^', content: [1, 2, 3] });
    const assign = op('assign', 20, 'B', { seq: 1, key: 'items', value: { elem: '10:1:A', value: 'two' } });
    const toEnd = op('move', 30, 'C', {
      seq: 1,
      key: 'items',
      value: { elem: '10:0:A', cut: ['10:A', 0, 1], at: '>10:2:A', value: 1 },
    });
    assertCommutes([a1, assign, toEnd], { items: ['two', 3, 1] });
    // Two moves of one element: the newer stamp names where it shows.
    const toHead = op('move', 40, 'D', {
      seq: 1,
      key: 'items',
      // To the head: a left child of the first element — `^` would be a child
      // of the root, ordered among them by origin, D after A.
      value: { elem: '10:0:A', cut: ['10:A', 0, 1], at: '<10:0:A', value: 1 },
    });
    assertCommutes([a1, assign, toEnd, toHead], { items: [1, 'two', 3] });
    // A cut of the old slot concurrent with a move: the move brings it back.
    const cut = items(25, 'B', 2, { cut: [['10:A', 0, 1]], content: [] });
    assertCommutes([a1, assign, cut, toEnd], { items: ['two', 3, 1] });
    // The assigned value travels with the element.
    const assignMoved = op('assign', 50, 'E', { seq: 1, key: 'items', value: { elem: '10:0:A', value: 'one' } });
    assertCommutes([a1, toEnd, toHead, assignMoved], { items: ['one', 2, 3] });
    // Refusals: a text, a register, a counter, a set; a field with no block is nothing.
    const text = replay([op('splice', 10, 'A', { seq: 1, key: 'body', value: { at: '^', content: 'ab' } })]);
    const onText = applyOp(text, op('assign', 11, 'B', { seq: 1, key: 'body', value: { elem: '10:0:A', value: 'x' } }));
    assert.deepStrictEqual([onText.changed, onText.rejected], [false, [{ field: 'body', reason: 'text' }]]);
    const reg = replay([op('set', 1, 'A', { data: { f: 1 } })]);
    assert.deepStrictEqual(applyOp(reg, op('move', 2, 'B', { seq: 1, key: 'f', value: toEnd.value })).rejected, [
      { field: 'f', reason: 'register' },
    ]);
    // A register for an element whose run is not here yet names the field a
    // list and waits — like a cut that comes before its run.
    const none = applyOp(reg, op('assign', 2, 'B', { seq: 1, key: 'other', value: { elem: '10:0:A', value: 1 } }));
    assert.deepStrictEqual([none.changed, none.rejected, none.entry.data.other], [true, [], []]);
    assert.deepStrictEqual(none.entry.meta.seqs.other.vals, { '10:0:A': [2, 'B', 1] });
    // Merge == replay with registers, and the codes are one character.
    const left = replay([a1, assign]);
    const right = replay([a1, toEnd, toHead]);
    const all = replay([a1, assign, toEnd, toHead]);
    assert.deepStrictEqual(mergeEntry(left, right).meta, all.meta);
    assert.deepStrictEqual(mergeEntry(left, right).data, all.data);
    assert.deepStrictEqual(
      packOps([assign, toEnd]).map((row) => row[3]),
      ['=', '^'],
    );
    assert.deepStrictEqual(
      unpackOps(packOps([assign, toEnd])).map((o) => o.type),
      ['assign', 'move'],
    );
  });

  await t.test('a mark rides on a text through applyOp; a list, a register or a counter refuses it', () => {
    const text = op('splice', 10, 'A', { seq: 1, key: 'body', value: { at: '^', content: 'hello' } });
    const bold = op('mark', 20, 'B', {
      seq: 1,
      key: 'body',
      value: { start: '<10:0:A', end: '<10:3:A', key: 'bold', value: true },
    });
    const marked = replay([text, bold]);
    assert.deepStrictEqual(marked.data, { body: 'hello' }, 'the field reads as the plain string');
    assert.deepStrictEqual(marked.meta.seqs.body.marks, { '20:B': ['<10:0:A', '<10:3:A', 'bold', true, 0] });
    assertCommutes([text, bold], { body: 'hello' });
    // A mark that arrives before its text names the field a text and waits.
    const early = applyOp(null, bold);
    assert.deepStrictEqual([early.changed, early.entry.data], [true, { body: '' }]);
    assert.deepStrictEqual(applyOp(early.entry, text).entry.meta, marked.meta);
    // Refusals.
    const list = replay([op('splice', 10, 'A', { seq: 1, key: 'items', value: { at: '^', content: [1] } })]);
    const onList = applyOp(list, op('mark', 11, 'B', { seq: 1, key: 'items', value: bold.value }));
    assert.deepStrictEqual([onList.changed, onList.rejected], [false, [{ field: 'items', reason: 'list' }]]);
    const reg = replay([op('set', 1, 'A', { data: { body: 'x' } })]);
    assert.deepStrictEqual(applyOp(reg, op('mark', 2, 'B', { seq: 1, key: 'body', value: bold.value })).rejected, [
      { field: 'body', reason: 'register' },
    ]);
    // Merge == replay; the code is one character; a purge erases marks.
    const off = op('mark', 30, 'C', { seq: 1, key: 'body', value: { off: '20:B' } });
    assert.deepStrictEqual(mergeEntry(replay([text, bold]), replay([text, off])).meta, replay([text, bold, off]).meta);
    assert.strictEqual(packOps([bold])[0][3], '*');
    assert.strictEqual(unpackOps(packOps([bold]))[0].type, 'mark');
    assert.deepStrictEqual(applyOp(marked, op('purge', 99, 'P')).entry.meta.seqs, {});
  });

  await t.test('mergeEntry joins two sequence histories like replaying both; kinds keep their precedence', () => {
    const splice = (ts, origin, seq, key, value) => op('splice', ts, origin, { seq, key, value });
    const a1 = splice(10, 'A', 1, 'body', { at: '^', content: 'ab' });
    const b1 = splice(20, 'B', 1, 'body', { at: '>10:1:A', content: 'X' });
    const a2 = splice(30, 'A', 2, 'body', { run: '10:A', from: 2, content: 'c' });
    const b2 = splice(35, 'B', 2, 'body', { at: '<10:0:A', content: 'Y' });
    const c1 = splice(40, 'C', 1, 'body', { cut: [['10:A', 0, 1]], content: '' });
    const left = replay([a1, a2, c1]);
    const right = replay([a1, b1, b2]);
    const all = replay([a1, b1, a2, b2, c1]);
    const merged = mergeEntry(left, right);
    assert.deepStrictEqual(merged.data, all.data);
    assert.deepStrictEqual(merged.meta, all.meta);
    assert.deepStrictEqual(mergeEntry(right, left).meta, all.meta, 'commutative');
    // Through a merge op, with the peer's meta normalized on the way in.
    const viaOp = applyOp(
      left,
      op('merge', 50, 'M', { data: right.data, meta: JSON.parse(JSON.stringify(right.meta)) }),
    );
    assert.deepStrictEqual(viaOp.entry.data, all.data);
    assert.deepStrictEqual(viaOp.entry.meta, all.meta);
    assert.strictEqual(applyOp(viaOp.entry, op('merge', 51, 'M', { data: all.data, meta: all.meta })).changed, false);
    // A hostile block in a peer's meta is dropped, not kept by reference.
    const hostile = {
      ...right.meta,
      seqs: { body: { k: 'x' }, ['__proto__']: right.meta.seqs.body, ok: right.meta.seqs.body },
    };
    const guarded = applyOp(left, op('merge', 52, 'M', { data: { ok: 'YbX' }, meta: hostile }));
    assert.deepStrictEqual(Object.keys(guarded.entry.meta.seqs).sort(), ['body', 'ok']);
    assert.strictEqual(Object.getPrototypeOf(guarded.entry.meta.seqs), Object.prototype);
    // Precedence on a merge: register, then counter, then set, then list, then text.
    const text = replay([splice(10, 'A', 1, 'f', { at: '^', content: 'ab' })]);
    const reg = replay([op('set', 5, 'B', { data: { f: 'reg' } })]);
    assert.deepStrictEqual(mergeEntry(text, reg).data, { f: 'reg' });
    assert.strictEqual(isSeq(mergeEntry(reg, text).meta, 'f'), false);
    const counter = replay([op('inc', 5, 'B', { seq: 1, key: 'f', value: 2 })]);
    assert.deepStrictEqual(mergeEntry(text, counter).data, { f: 2 });
    const set = replay([op('add', 5, 'B', { seq: 1, key: 'f', value: ['s'] })]);
    assert.deepStrictEqual(mergeEntry(text, set).data, { f: ['s'] });
    const list = replay([splice(12, 'B', 1, 'f', { at: '^', content: [1] })]);
    assert.deepStrictEqual(mergeEntry(text, list).data, { f: [1] }, 'a list outranks a text');
    assert.deepStrictEqual(mergeEntry(list, text).data, { f: [1] });
    // A purge erases sequences with everything else.
    const purged = applyOp(all, op('purge', 99, 'P'));
    assert.deepStrictEqual([purged.entry.data, purged.entry.meta.seqs], [{}, {}]);
    assert.strictEqual(applyOp(purged.entry, a1).changed, false);
    // The op code is one character.
    const [row] = packOps([a1]);
    assert.strictEqual(row[3], '/');
    assert.deepStrictEqual(row[8], 'body');
    assert.deepStrictEqual(row[9], a1.value);
    assert.strictEqual(unpackOps([row])[0].type, 'splice');
  });

  await t.test('fields named after Object.prototype members are fields; __proto__ never is', () => {
    const entry = replay([
      op('write', 1, 'A', { data: { constructor: 1, toString: 't', hasOwnProperty: true, ok: 1 } }),
    ]);
    assert.deepStrictEqual(entry.data, { constructor: 1, toString: 't', hasOwnProperty: true, ok: 1 });
    const bumped = applyOp(entry, op('set', 2, 'B', { data: { constructor: 2 } }));
    assert.strictEqual(bumped.entry.data.constructor, 2);
    const counted = applyOp(null, op('inc', 1, 'A', { seq: 1, key: 'constructor', value: 3 }));
    assert.deepStrictEqual(counted.entry.data, { constructor: 3 });
    assert.strictEqual(isCounter(counted.entry.meta, 'constructor'), true);
    assert.strictEqual(isCounter(counted.entry.meta, 'toString'), false);
    assert.strictEqual(Object.hasOwn(Object, 'A'), false, 'the counter did not land on Object');
    assert.strictEqual(applyOp(null, op('inc', 1, 'A', { seq: 1, key: '__proto__', value: 1 })).changed, false);
    assert.strictEqual(applyOp(null, op('inc', 1, '__proto__', { seq: 1, key: 'n', value: 1 })).changed, false);
    const both = mergeEntry(counted.entry, replay([op('set', 5, 'B', { data: { constructor: 'reg' } })]));
    assert.deepStrictEqual(both.data, { constructor: 'reg' }, 'the register wins over the counter, through own keys');
  });

  await t.test('pack and unpack look type codes up as own keys', () => {
    const [row] = packOps([{ origin: 'A', seq: 1, ts: 1, type: 'constructor', id: 'r' }]);
    assert.strictEqual(row[3], 'constructor');
    const [back] = unpackOps([['A', 1, 1, 'constructor', 'r']]);
    assert.strictEqual(back.type, 'constructor', 'an unknown code stays a string for the storage to refuse');
  });
});
