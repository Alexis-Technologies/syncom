'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  isAlive,
  createEntry,
  isCounter,
  isSet,
  isBlock,
  observedTags,
  latestClock,
  packOps,
  unpackOps,
  MAX_COUNT,
  kindOf,
} = require('../src/ops.js');
// The folds under the shipped plugins' registry: the lean core alone refuses a splice or a tree op as a kind it lacks.
const { applyOp, mergeEntry, PLUGINS } = require('../src/all/all.js');
const { createPlugins } = require('../src/plugin.js');
const SHIPPED = createPlugins(PLUGINS);

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
    // The register outranks the counter: where the counter is held, the
    // register's write takes the field; where the register is held, the
    // increment was refused above. Both nodes end with the register.
    const counter = replay([op('inc', 1, 'A', { seq: 1, key: 'n', value: 1 })]);
    const setOnCounter = applyOp(counter, op('set', 2, 'B', { data: { n: 5, other: 1 } }));
    assert.deepStrictEqual(setOnCounter.rejected, []);
    assert.deepStrictEqual(setOnCounter.entry.data, { n: 5, other: 1 });
    assert.strictEqual(isCounter(setOnCounter.entry.meta, 'n'), false);
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
    // A write carrying the field as a register: below a concurrent add the
    // register still outranks the set and takes the field; above every add
    // the reset alone leaves a register.
    const concurrent = applyOp(replay([add(3, 'A', 1, ['x'])]), op('write', 2, 'W', { data: { t: 'w', z: 1 } }));
    assert.deepStrictEqual(concurrent.rejected, []);
    assert.deepStrictEqual(concurrent.entry.data, { t: 'w', z: 1 });
    assert.deepStrictEqual(concurrent.entry.meta.sets, {});
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
    // A register and a counter outrank a set: each takes the field where the set is held.
    const set = replay([add(1, 'A', 1, ['x'])]);
    const setOnSet = applyOp(set, op('set', 2, 'B', { data: { t: 5, other: 1 } }));
    assert.deepStrictEqual([setOnSet.rejected, setOnSet.entry.data], [[], { t: 5, other: 1 }]);
    assert.strictEqual(isSet(setOnSet.entry.meta, 't'), false);
    const incOnSet = applyOp(set, op('inc', 2, 'B', { seq: 1, key: 't', value: 1 }));
    assert.deepStrictEqual([incOnSet.changed, incOnSet.rejected, incOnSet.entry.data], [true, [], { t: 1 }]);
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
    "applyOp reports what the reading shows of an op, in the write API's terms and the reading's indices",
    () => {
      const changesOf = (entry, o) => applyOp(entry, o).changes;
      let r = applyOp(null, op('write', 1, 'A', { data: { a: 1, b: 2 } }));
      assert.deepStrictEqual(r.changes, [
        { action: 'put', field: 'a', value: 1 },
        { action: 'put', field: 'b', value: 2 },
      ]);
      r = applyOp(r.entry, op('inc', 2, 'A', { key: 'n', value: 3 }));
      assert.deepStrictEqual(r.changes, [{ action: 'inc', field: 'n', value: 3 }]);
      r = applyOp(r.entry, op('add', 3, 'A', { key: 'tags', value: ['x', 'y'] }));
      assert.deepStrictEqual(r.changes, [{ action: 'add', field: 'tags', elements: ['x', 'y'] }]);
      assert.deepStrictEqual(changesOf(r.entry, op('add', 4, 'B', { key: 'tags', value: ['x'] })), [], 'already in');
      r = applyOp(r.entry, op('remove', 4, 'A', { key: 'tags', value: [['x', { A: 3 }]] }));
      assert.deepStrictEqual(r.changes, [{ action: 'remove', field: 'tags', elements: ['x'] }]);
      // A text: the insert in the indices after, the cuts in the indices before, last first.
      r = applyOp(r.entry, op('splice', 5, 'A', { key: 'body', value: { at: '^', content: 'hello' } }));
      assert.deepStrictEqual(r.changes, [{ action: 'splice', field: 'body', index: 0, count: 0, content: 'hello' }]);
      const replace = { cut: [['5:A', 1, 2]], content: 'EY', run: '5:A', from: 5 };
      r = applyOp(r.entry, op('splice', 6, 'A', { key: 'body', value: replace }));
      assert.deepStrictEqual(r.changes, [
        { action: 'splice', field: 'body', index: 1, count: 2 },
        { action: 'splice', field: 'body', index: 3, count: 0, content: 'EY' },
      ]);
      assert.strictEqual(r.entry.data.body, 'hloEY');
      const atOnce = { cut: [['5:A', 0, 1]], content: 'J', at: '<5:0:A' };
      r = applyOp(r.entry, op('splice', 7, 'B', { key: 'body', value: atOnce }));
      assert.deepStrictEqual(
        r.changes,
        [{ action: 'splice', field: 'body', index: 0, count: 1, content: 'J' }],
        'one splice',
      );
      assert.strictEqual(r.entry.data.body, 'JloEY');
      const twice = {
        cut: [
          ['5:A', 4, 1],
          ['5:A', 3, 1],
        ],
        content: '',
      };
      assert.deepStrictEqual(changesOf(r.entry, op('splice', 8, 'B', { key: 'body', value: twice })), [
        { action: 'splice', field: 'body', index: 2, count: 1 },
        { action: 'splice', field: 'body', index: 1, count: 1 },
      ]);
      assert.deepStrictEqual(
        changesOf(r.entry, op('splice', 8, 'B', { key: 'body', value: { cut: [['5:A', 2, 2]], content: '' } })),
        [{ action: 'splice', field: 'body', index: 1, count: 1 }],
        'a cut over a slot already gone counts what the reading loses',
      );
      const mark = { start: '<5:3:A', end: '>5:4:A', key: 'bold', value: true };
      r = applyOp(r.entry, op('mark', 8, 'A', { key: 'body', value: mark }));
      assert.deepStrictEqual(r.changes, [
        { action: 'mark', field: 'body', start: 1, end: 3, name: 'bold', value: true, markId: '8:A' },
      ]);
      r = applyOp(r.entry, op('mark', 9, 'A', { key: 'body', value: { off: '8:A' } }));
      assert.deepStrictEqual(r.changes, [
        { action: 'unmarkById', field: 'body', markId: '8:A', start: 1, end: 3, name: 'bold' },
      ]);
      assert.deepStrictEqual(
        changesOf(r.entry, op('mark', 10, 'A', { key: 'body', value: { off: '99:Z' } })),
        [],
        'not here yet',
      );
      // A list: a splice, an assign as setAt, a move by its index before and after.
      r = applyOp(r.entry, op('splice', 10, 'A', { key: 'items', value: { at: '^', content: [1, 2, 3] } }));
      assert.deepStrictEqual(r.changes, [{ action: 'splice', field: 'items', index: 0, count: 0, content: [1, 2, 3] }]);
      r = applyOp(r.entry, op('assign', 11, 'A', { key: 'items', value: { elem: '10:1:A', value: 'two' } }));
      assert.deepStrictEqual(r.changes, [{ action: 'setAt', field: 'items', index: 1, value: 'two' }]);
      const move = { elem: '10:0:A', cut: ['10:A', 0, 1], at: '>10:2:A', value: 1 };
      r = applyOp(r.entry, op('move', 12, 'A', { key: 'items', value: move }));
      assert.deepStrictEqual(r.changes, [{ action: 'move', field: 'items', from: 0, to: 2 }]);
      assert.deepStrictEqual(r.entry.data.items, ['two', 3, 1]);
      const waiting = { elem: '77:0:Z', value: 'v' };
      assert.deepStrictEqual(
        changesOf(r.entry, op('assign', 13, 'A', { key: 'items', value: waiting })),
        [],
        'an element not here',
      );
      // A tree: the node with its parent and the sibling before it; a removal.
      r = applyOp(r.entry, op('tree', 13, 'A', { key: 'outline', value: { node: 'n', parent: null, fi: 'V' } }));
      assert.deepStrictEqual(r.changes, [
        { action: 'treeMove', field: 'outline', node: 'n', parent: null, after: null },
      ]);
      r = applyOp(r.entry, op('tree', 14, 'A', { key: 'outline', value: { node: 'm', parent: 'n', fi: 'V' } }));
      assert.deepStrictEqual(r.changes, [
        { action: 'treeMove', field: 'outline', node: 'm', parent: 'n', after: null },
      ]);
      r = applyOp(r.entry, op('tree', 15, 'A', { key: 'outline', value: { node: 'o', parent: null, fi: 'WV' } }));
      assert.deepStrictEqual(r.changes, [
        { action: 'treeMove', field: 'outline', node: 'o', parent: null, after: 'n' },
      ]);
      r = applyOp(r.entry, op('tree', 16, 'A', { key: 'outline', value: { node: 'n', parent: '$trash', fi: 'V' } }));
      assert.deepStrictEqual(r.changes, [
        { action: 'treeMove', field: 'outline', node: 'o', parent: null, after: null },
        { action: 'treeRemove', field: 'outline', node: 'n' },
      ]);
      // Resets: an unset per field; a whole-record write puts and unsets; a delete, a purge.
      r = applyOp(r.entry, op('unset', 17, 'A', { value: ['a', 'tags'] }));
      assert.deepStrictEqual(r.changes, [
        { action: 'unset', field: 'a' },
        { action: 'unset', field: 'tags' },
      ]);
      r = applyOp(r.entry, op('write', 18, 'A', { data: { z: 1 } }));
      assert.deepStrictEqual(r.changes[0], { action: 'put', field: 'z', value: 1 });
      assert.deepStrictEqual(
        r.changes.slice(1).map((change) => change.action),
        ['unset', 'unset', 'unset', 'unset', 'unset'],
      );
      // A kind outranked reads as a reset with the winner's value; a merge as resets.
      const list = replay([op('splice', 1, 'A', { key: 'f', value: { at: '^', content: [1] } })]);
      assert.deepStrictEqual(changesOf(list, op('inc', 2, 'B', { key: 'f', value: 7 })), [
        { action: 'inc', field: 'f', value: 7 },
      ]);
      const merged = applyOp(null, { ...op('merge', 3, 'M'), data: r.entry.data, meta: r.entry.meta });
      assert.deepStrictEqual(merged.changes, [{ action: 'reset', field: 'z', kind: 'register', value: 1 }]);
      r = applyOp(r.entry, op('delete', 19, 'A'));
      assert.deepStrictEqual(r.changes, [{ action: 'delete' }]);
      assert.deepStrictEqual(changesOf(r.entry, op('purge', 20, 'A')), [{ action: 'purge' }]);
      assert.deepStrictEqual(changesOf(r.entry, op('delete', 18, 'B')), [], 'an older delete changes nothing');
    },
  );

  await t.test(
    'packOps carries v, actor, sig, digest, nonce and msg in slots 13 to 18; older rows read without them',
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
      assert.strictEqual(packed[0].length, 18);
      assert.strictEqual(packed[0][12], 2);
      assert.strictEqual(packed[0][13], 'u1');
      assert.strictEqual(packed[0][14], sig);
      assert.strictEqual(packed[0][15], digest);
      assert.strictEqual(packed[0][16], 'n'.repeat(20));
      assert.deepStrictEqual(packed[1].slice(12), [null, null, null, null, null, null]);
      assert.deepStrictEqual(packed[2].slice(14), [sig, null, null, null]);
      // The message rides in the 18th slot, back as `msg`.
      const [withMessage] = packOps([{ ...ops[1], msg: 'why' }]);
      assert.strictEqual(withMessage[17], 'why');
      assert.strictEqual(unpackOps([withMessage])[0].msg, 'why');
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
    assert.strictEqual(isBlock(first.entry.meta, 'body'), true);
    assert.strictEqual(isBlock(first.entry.meta, 'other'), false);
    assert.strictEqual(isBlock({ clock: {}, counters: {} }, 'body'), false, 'an entry from before sequences existed');
    assert.strictEqual(first.entry.meta.blocks.body.k, 't');
    assert.deepStrictEqual(Object.keys(first.entry.meta.blocks.body.runs), ['1:A']);
    // The same origin typing on extends the run; a cut keeps the places.
    const more = applyOp(first.entry, splice(2, 'A', 2, 'body', { run: '1:A', from: 2, content: 'c' }));
    assert.deepStrictEqual(more.entry.data, { body: 'abc' });
    assert.deepStrictEqual(Object.keys(more.entry.meta.blocks.body.runs), ['1:A']);
    const cut = applyOp(more.entry, splice(3, 'B', 1, 'body', { cut: [['1:A', 1, 1]], content: '' }));
    assert.deepStrictEqual(cut.entry.data, { body: 'ac' });
    assert.deepStrictEqual(cut.delta, { body: 'ac' });
    assert.deepStrictEqual(cut.entry.meta.blocks.body.runs['1:A'], ['^', ['a', 1, 'c']]);
    assert.strictEqual(
      applyOp(cut.entry, splice(3, 'B', 1, 'body', { cut: [['1:A', 1, 1]], content: '' })).changed,
      false,
    );
    // A list holds JSON values.
    const list = applyOp(cut.entry, splice(4, 'A', 3, 'items', { at: '^', content: [1, { x: 2 }] }));
    assert.deepStrictEqual(list.entry.data, { body: 'ac', items: [1, { x: 2 }] });
    assert.strictEqual(list.entry.meta.blocks.items.k, 'l');
    // The kinds never meet: a list outranks a text, so a list op on a text
    // field takes it over, and a text op on a list field is refused.
    const clash = applyOp(list.entry, splice(5, 'B', 2, 'body', { at: '^', content: ['x'] }));
    assert.deepStrictEqual([clash.changed, clash.rejected, clash.entry.data.body], [true, [], ['x']]);
    assert.strictEqual(clash.entry.meta.blocks.body.k, 'l');
    const clash2 = applyOp(list.entry, splice(5, 'B', 2, 'items', { at: '^', content: 'x' }));
    assert.deepStrictEqual([clash2.changed, clash2.rejected], [false, [{ field: 'items', reason: 'list' }]]);
    // A malformed payload changes nothing and is reported as such — a local
    // caller hears of it, a peer's is counted; a duplicate is nothing.
    for (const value of ['nope', null, { content: 5 }, { at: '^' }, { at: '$', content: 'x' }, { content: '' }]) {
      const r = applyOp(list.entry, splice(6, 'C', 1, 'body', value));
      const refused = [{ field: 'body', reason: 'malformed' }];
      assert.deepStrictEqual([r.changed, r.rejected], [false, refused], JSON.stringify(value));
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
    assert.deepStrictEqual(early.entry.meta.blocks.body.cuts, { '8:A': [[0, 1]] });
    const late = applyOp(early.entry, splice(8, 'A', 1, 'body', { at: '^', content: 'xy' }));
    assert.deepStrictEqual(late.entry.data, { body: 'y' });
    assert.strictEqual(late.entry.meta.blocks.body.cuts, undefined);
    // The previous entry is untouched: applyOp hands out a new one.
    assert.deepStrictEqual(first.entry.data, { body: 'ab' });
    assert.deepStrictEqual(first.entry.meta.blocks.body.runs['1:A'], ['^', ['ab']]);
  });

  await t.test('a list or a text is never also a register, a counter or a set', () => {
    const splice = (ts, origin, seq, key, value) => op('splice', ts, origin, { seq, key, value });
    const text = replay([splice(10, 'A', 1, 'body', { at: '^', content: 'ab' })]);
    // A register, a counter and a set all outrank a text or a list: each takes the field.
    const set = applyOp(text, op('set', 11, 'B', { data: { body: 'plain', ok: 1 } }));
    assert.deepStrictEqual([set.rejected, set.entry.data], [[], { body: 'plain', ok: 1 }]);
    assert.strictEqual(isBlock(set.entry.meta, 'body'), false);
    const inc = applyOp(text, op('inc', 11, 'B', { seq: 1, key: 'body', value: 1 }));
    assert.deepStrictEqual([inc.changed, inc.rejected, inc.entry.data], [true, [], { body: 1 }]);
    const add = applyOp(text, op('add', 11, 'B', { seq: 1, key: 'body', value: ['x'] }));
    assert.deepStrictEqual([add.changed, add.rejected, add.entry.data], [true, [], { body: ['x'] }]);
    const list = replay([splice(10, 'A', 1, 'items', { at: '^', content: [1] })]);
    const incOnList = applyOp(list, op('inc', 11, 'B', { seq: 1, key: 'items', value: 1 }));
    assert.deepStrictEqual([incOnList.rejected, incOnList.entry.data], [[], { items: 1 }]);
    // And the other way round: a text op on a register, a counter or a set is refused.
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
    // A whole-record write makes the field a register whether it is stamped
    // above the runs (the reset drops them) or below (the register outranks them).
    const above = applyOp(text, op('write', 20, 'B', { data: { body: 'plain' } }));
    assert.deepStrictEqual([above.entry.data, above.rejected], [{ body: 'plain' }, []]);
    assert.strictEqual(isBlock(above.entry.meta, 'body'), false);
    const below = applyOp(text, op('write', 5, 'B', { data: { body: 'plain' } }));
    assert.deepStrictEqual([below.entry.data, below.rejected], [{ body: 'plain' }, []]);
    assert.strictEqual(isBlock(below.entry.meta, 'body'), false);
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
    assert.strictEqual(after.meta.blocks.body.cuts, undefined, 'a cut on a dropped run is dropped too');
    assert.deepStrictEqual(Object.keys(after.meta.blocks.body.runs), ['35:B']);
    // A reset above everything frees the field.
    const gone = applyOp(after, op('delete', 50, 'D'));
    assert.deepStrictEqual(gone.entry.data, {});
    assert.strictEqual(gone.entry.meta.blocks.body, undefined);
    assert.deepStrictEqual(gone.delta, { body: undefined });
    assert.strictEqual(isAlive(gone.entry), false);
    // Typing after the tombstone revives the record.
    const revived = applyOp(gone.entry, splice(60, 'A', 3, 'body', { at: '^', content: 'z' }));
    assert.strictEqual(isAlive(revived.entry), true);
    assert.deepStrictEqual(revived.entry.data, { body: 'z' });
    assert.deepStrictEqual(latestClock(revived.entry.meta, true), [60, '']);
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
    // A list outranks a text: a list op on a text field takes it over, its
    // register waiting for the element; a register refuses a move.
    const text = replay([op('splice', 10, 'A', { seq: 1, key: 'body', value: { at: '^', content: 'ab' } })]);
    const onText = applyOp(text, op('assign', 11, 'B', { seq: 1, key: 'body', value: { elem: '10:0:A', value: 'x' } }));
    assert.deepStrictEqual([onText.changed, onText.rejected, onText.entry.data.body], [true, [], []]);
    assert.strictEqual(onText.entry.meta.blocks.body.k, 'l');
    const reg = replay([op('set', 1, 'A', { data: { f: 1 } })]);
    assert.deepStrictEqual(applyOp(reg, op('move', 2, 'B', { seq: 1, key: 'f', value: toEnd.value })).rejected, [
      { field: 'f', reason: 'register' },
    ]);
    // A register for an element whose run is not here yet names the field a
    // list and waits — like a cut that comes before its run.
    const none = applyOp(reg, op('assign', 2, 'B', { seq: 1, key: 'other', value: { elem: '10:0:A', value: 1 } }));
    assert.deepStrictEqual([none.changed, none.rejected, none.entry.data.other], [true, [], []]);
    assert.deepStrictEqual(none.entry.meta.blocks.other.vals, { '10:0:A': [2, 'B', 1] });
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
    assert.deepStrictEqual(marked.meta.blocks.body.marks, { '20:B': ['<10:0:A', '<10:3:A', 'bold', true, 0] });
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
    assert.deepStrictEqual(applyOp(marked, op('purge', 99, 'P')).entry.meta.blocks, {});
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
      blocks: { body: { k: 'x' }, ['__proto__']: right.meta.blocks.body, ok: right.meta.blocks.body },
    };
    const guarded = applyOp(left, op('merge', 52, 'M', { data: { ok: 'YbX' }, meta: hostile }));
    assert.deepStrictEqual(Object.keys(guarded.entry.meta.blocks).sort(), ['body', 'ok']);
    assert.strictEqual(Object.getPrototypeOf(guarded.entry.meta.blocks), Object.prototype);
    // Precedence on a merge: register, then counter, then set, then list, then text.
    const text = replay([splice(10, 'A', 1, 'f', { at: '^', content: 'ab' })]);
    const reg = replay([op('set', 5, 'B', { data: { f: 'reg' } })]);
    assert.deepStrictEqual(mergeEntry(text, reg).data, { f: 'reg' });
    assert.strictEqual(isBlock(mergeEntry(reg, text).meta, 'f'), false);
    const counter = replay([op('inc', 5, 'B', { seq: 1, key: 'f', value: 2 })]);
    assert.deepStrictEqual(mergeEntry(text, counter).data, { f: 2 });
    const set = replay([op('add', 5, 'B', { seq: 1, key: 'f', value: ['s'] })]);
    assert.deepStrictEqual(mergeEntry(text, set).data, { f: ['s'] });
    const list = replay([splice(12, 'B', 1, 'f', { at: '^', content: [1] })]);
    assert.deepStrictEqual(mergeEntry(text, list).data, { f: [1] }, 'a list outranks a text');
    assert.deepStrictEqual(mergeEntry(list, text).data, { f: [1] });
    // A purge erases sequences with everything else.
    const purged = applyOp(all, op('purge', 99, 'P'));
    assert.deepStrictEqual([purged.entry.data, purged.entry.meta.blocks], [{}, {}]);
    assert.strictEqual(applyOp(purged.entry, a1).changed, false);
    // The op code is one character.
    const [row] = packOps([a1]);
    assert.strictEqual(row[3], '/');
    assert.deepStrictEqual(row[8], 'body');
    assert.deepStrictEqual(row[9], a1.value);
    assert.strictEqual(unpackOps([row])[0].type, 'splice');
  });

  await t.test('a tree moves through applyOp; concurrent moves that would make a cycle leave one in effect', () => {
    const tree = (ts, origin, seq, node, parent, fi = 'V') =>
      op('tree', ts, origin, { seq, key: 'outline', value: { node, parent, fi } });
    const r = tree(10, 'A', 1, 'r', null);
    const x = tree(20, 'A', 2, 'x', 'r', 'UV');
    const y = tree(30, 'A', 3, 'y', 'r', 'WV');
    const first = applyOp(null, r);
    assert.strictEqual(first.changed, true);
    assert.deepStrictEqual(first.entry.data, { outline: [{ id: 'r', children: [] }] });
    assert.deepStrictEqual(first.delta, { outline: [{ id: 'r', children: [] }] });
    assert.strictEqual(isBlock(first.entry.meta, 'outline'), true);
    assert.strictEqual(isBlock(first.entry.meta, 'other'), false);
    assert.strictEqual(isBlock({ clock: {}, counters: {} }, 'outline'), false, 'an entry from before trees existed');
    assert.deepStrictEqual(first.entry.meta.blocks.outline, {
      k: 'tree',
      ts: 10,
      moves: { r: [[10, 'A', null, 'V']] },
    });
    assert.strictEqual(applyOp(first.entry, r).changed, false, 'a duplicate is nothing');
    // Apart, A puts x under y and B puts y under x: the older move stands,
    // the newer one is kept but does not take — the same on every node.
    const underY = tree(40, 'A', 4, 'x', 'y');
    const underX = tree(50, 'B', 1, 'y', 'x');
    assertCommutes([r, x, y, underY, underX], {
      outline: [{ id: 'r', children: [{ id: 'y', children: [{ id: 'x', children: [] }] }] }],
    });
    const held = replay([r, x, y, underY, underX]);
    assert.deepStrictEqual(held.meta.blocks.outline.moves.y, [
      [30, 'A', 'r', 'WV'],
      [50, 'B', 'x', 'V'],
    ]);
    // A later move of y out from under r makes the lost move count: x
    // comes along, and y hangs where the lost move said.
    const yOut = applyOp(held, tree(60, 'C', 1, 'y', null, 'XV'));
    assert.deepStrictEqual(yOut.entry.data.outline, [
      { id: 'r', children: [] },
      { id: 'y', children: [{ id: 'x', children: [] }] },
    ]);
    // A removal concurrent with a move into the removed subtree hides the mover too.
    const trash = tree(40, 'A', 4, 'y', '$trash');
    const into = tree(50, 'B', 1, 'x', 'y');
    assertCommutes([r, x, y, trash, into], { outline: [{ id: 'r', children: [] }] });
    // A reset drops the moves below it; one above it stays and reads from
    // its parent once the parent is back.
    const write = op('write', 100, 'W', { data: { t: 1 } });
    assertCommutes([r, x, write], { t: 1 });
    const z = tree(150, 'B', 1, 'z', 'r');
    assertCommutes([r, x, write, z], { t: 1, outline: [] });
    const back = applyOp(replay([r, x, write, z]), tree(160, 'A', 3, 'r', null));
    assert.deepStrictEqual(back.entry.data.outline, [{ id: 'r', children: [{ id: 'z', children: [] }] }]);
    // A tree touched after a tombstone revives the record.
    const dead = applyOp(replay([r]), op('delete', 100, 'D'));
    assert.strictEqual(isAlive(dead.entry), false);
    assert.strictEqual(isAlive(applyOp(dead.entry, tree(150, 'A', 2, 'r', null)).entry), true);
    // Every other kind outranks a tree: a tree op on any of them is refused,
    // and any of them landing on a tree takes the field.
    const reg = applyOp(null, op('set', 1, 'A', { data: { outline: 1 } })).entry;
    assert.deepStrictEqual(applyOp(reg, tree(2, 'B', 1, 'r', null)).rejected, [
      { field: 'outline', reason: 'register' },
    ]);
    const onTree = (o) => {
      const result = applyOp(first.entry, o);
      return [result.rejected, kindOf(result.entry, 'outline', SHIPPED) === 'tree', result.entry.data.outline];
    };
    assert.deepStrictEqual(onTree(op('set', 11, 'B', { data: { outline: 1 } })), [[], false, 1]);
    assert.deepStrictEqual(onTree(op('inc', 11, 'B', { seq: 1, key: 'outline', value: 1 })), [[], false, 1]);
    assert.deepStrictEqual(onTree(op('add', 11, 'B', { seq: 1, key: 'outline', value: ['x'] })), [[], false, ['x']]);
    assert.deepStrictEqual(
      onTree(op('splice', 11, 'B', { seq: 1, key: 'outline', value: { at: '^', content: 'x' } })),
      [[], false, 'x'],
    );
    assert.deepStrictEqual(
      onTree(op('assign', 11, 'B', { seq: 1, key: 'outline', value: { elem: '1:0:A', value: 1 } })),
      [[], false, []],
    );
    const counter = applyOp(null, op('inc', 1, 'A', { seq: 1, key: 'outline', value: 1 }));
    assert.deepStrictEqual(applyOp(counter.entry, tree(2, 'B', 1, 'r', null)).rejected, [
      { field: 'outline', reason: 'counter' },
    ]);
    const set = applyOp(null, op('add', 1, 'A', { seq: 1, key: 'outline', value: ['x'] }));
    assert.deepStrictEqual(applyOp(set.entry, tree(2, 'B', 1, 'r', null)).rejected, [
      { field: 'outline', reason: 'set' },
    ]);
    const text = applyOp(null, op('splice', 1, 'A', { seq: 1, key: 'outline', value: { at: '^', content: 'x' } }));
    assert.deepStrictEqual(applyOp(text.entry, tree(2, 'B', 1, 'r', null)).rejected, [
      { field: 'outline', reason: 'text' },
    ]);
    // A malformed payload changes nothing and is reported as such.
    for (const value of [
      'nope',
      null,
      { node: 'n' },
      { node: 'n', parent: 'n', fi: 'V' },
      { node: '$trash', parent: null, fi: 'V' },
      { node: 'n', parent: null, fi: 'not-an-index' },
    ]) {
      const result = applyOp(first.entry, op('tree', 11, 'C', { seq: 1, key: 'outline', value }));
      const refused = [{ field: 'outline', reason: 'malformed' }];
      assert.deepStrictEqual([result.changed, result.rejected], [false, refused], JSON.stringify(value));
    }
    // Over the wire: one code, round-tripped.
    const [packed] = unpackOps(packOps([r]));
    assert.deepStrictEqual(packed, r);
    // mergeEntry joins two tree histories like replaying both; the other
    // kinds outrank a tree.
    const left = replay([r, x, underY]);
    const right = replay([r, y, underX]);
    const all = replay([r, x, y, underY, underX]);
    const merged = mergeEntry(left, right);
    assert.deepStrictEqual(merged.data, all.data);
    assert.deepStrictEqual(merged.meta, all.meta);
    assert.deepStrictEqual(mergeEntry(right, left).meta, all.meta, 'commutative');
    const viaOp = applyOp(
      left,
      op('merge', 70, 'M', { data: right.data, meta: JSON.parse(JSON.stringify(right.meta)) }),
    );
    assert.deepStrictEqual(viaOp.entry.meta.blocks, all.meta.blocks);
    const asText = mergeEntry(first.entry, text.entry);
    assert.deepStrictEqual([asText.data.outline, asText.meta.blocks.outline.k], ['x', 't'], 'a text outranks a tree');
    const asSet = mergeEntry(first.entry, set.entry);
    assert.deepStrictEqual([asSet.data.outline, asSet.meta.blocks], [['x'], {}], 'a set outranks a tree');
    const asCounter = mergeEntry(first.entry, counter.entry);
    assert.deepStrictEqual([asCounter.data.outline, asCounter.meta.blocks], [1, {}], 'a counter outranks a tree');
    const asRegister = mergeEntry(first.entry, applyOp(null, op('set', 1, 'A', { data: { outline: 'reg' } })).entry);
    assert.deepStrictEqual(
      [asRegister.data.outline, asRegister.meta.blocks],
      ['reg', {}],
      'a register outranks a tree',
    );
    // A hostile block is rebuilt from own keys and well-formed moves alone.
    const hostile = applyOp(
      null,
      op('merge', 80, 'M', {
        data: {},
        meta: JSON.parse(
          JSON.stringify({
            clock: {},
            counters: {},
            blocks: {
              outline: {
                k: 'tree',
                moves: { r: [[10, 'A', null, 'V'], 'junk', [5, 'A', 7, 'V']], ['__proto__']: [[1, 'A', null, 'V']] },
              },
              empty: { k: 'tree', moves: {} },
              nokind: { moves: { r: [[10, 'A', null, 'V']] } },
              junk: 5,
            },
          }),
        ),
      }),
    );
    assert.deepStrictEqual(hostile.entry.meta.blocks, {
      outline: { k: 'tree', ts: 10, moves: { r: [[10, 'A', null, 'V']] } },
    });
    assert.deepStrictEqual(latestClock(hostile.entry.meta, true), [10, '']);
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

test('ops: a counter stays a number every node reads alike', async (t) => {
  await t.test('an inc past MAX_COUNT is a bound refusal in any order; the sums add up in origin order', () => {
    const inc = (ts, origin, seq, value) => op('inc', ts, origin, { seq, key: 'n', value });
    // Fractions round by the order they are added in; the reading must not depend on arrival.
    const parts = [inc(1, 'A', 1, 0.1), inc(2, 'B', 1, 0.2), inc(3, 'C', 1, 0.3)];
    const readings = new Set(permutations(parts).map((order) => replay(order).data.n));
    assert.deepStrictEqual([...readings], [0.1 + 0.2 + 0.3]);
    // Past the bound: refused, the origin's slot as it was, the next small inc lands.
    const near = applyOp(null, inc(1, 'A', 1, MAX_COUNT - 1)).entry;
    const over = applyOp(near, inc(2, 'A', 2, 2));
    const refused = { field: 'n', reason: 'bound', detail: 'counter', count: MAX_COUNT + 1, max: MAX_COUNT };
    assert.deepStrictEqual([over.changed, over.rejected, over.entry.data.n], [false, [refused], MAX_COUNT - 1]);
    const next = applyOp(over.entry, inc(3, 'A', 3, 1));
    assert.deepStrictEqual([next.changed, next.entry.data.n], [true, MAX_COUNT]);
    // A first inc past it leaves no field behind; another origin's sum is its own.
    const huge = applyOp(null, inc(1, 'B', 1, 1e308));
    assert.deepStrictEqual([huge.changed, huge.entry.data, huge.entry.meta.counters], [false, {}, {}]);
    const ops = [inc(1, 'A', 1, MAX_COUNT), inc(2, 'A', 2, 1), inc(3, 'B', 1, -5)];
    assertCommutes(ops, { n: MAX_COUNT - 5 });
  });

  await t.test('a merge drops a counter sum past MAX_COUNT and data its meta does not back', () => {
    // What a snapshot page carries for a record this node does not hold: a sum
    // no op could make, and a value with no stamp under it.
    const meta = { clock: { title: [4, 'A'] }, counters: { n: { A: [1, 1e300, 5], B: [1, 2, 6] } } };
    const data = { title: 'doc', n: 1e300, body: 'unstamped' };
    const { entry } = applyOp(null, op('merge', 10, 'H', { seq: 1, data, meta }));
    assert.deepStrictEqual(entry.meta.counters, { n: { B: [1, 2, 6] } });
    assert.deepStrictEqual(entry.data, { title: 'doc', n: 2 });
    // The same join over an entry this node holds reads alike.
    const held = applyOp(null, op('set', 1, 'C', { data: { other: 1 } })).entry;
    const over = applyOp(held, op('merge', 10, 'H', { seq: 1, data, meta })).entry;
    assert.deepStrictEqual(over.data, { other: 1, title: 'doc', n: 2 });
  });
});

test('ops: a payload the engine does not admit is reported, never silent', async (t) => {
  await t.test('a set, a write, an inc, an add or a remove of the wrong shape is malformed', () => {
    const base = applyOp(null, op('set', 1, 'A', { data: { n: 1 } })).entry;
    const cases = [
      op('set', 2, 'B', { data: 'x' }),
      op('write', 2, 'B', { data: [1] }),
      op('inc', 2, 'B', { key: 'hits', value: 'x' }),
      op('inc', 2, 'B', { key: 'hits', value: Infinity }),
      op('inc', 2, 'B', { key: 7, value: 1 }),
      op('add', 2, 'B', { key: 'tags', value: 'x' }),
      op('remove', 2, 'B', { key: 'tags' }),
    ];
    for (const item of cases) {
      const { changed, rejected, entry } = applyOp(base, item);
      const field = typeof item.key === 'string' ? item.key : null;
      assert.deepStrictEqual([changed, rejected], [false, [{ field, reason: 'malformed' }]], JSON.stringify(item));
      assert.deepStrictEqual(entry.data, { n: 1 });
    }
  });
});

test('ops: the bound on pending work is the node’s', async (t) => {
  await t.test('a merge takes a block by the node’s bound, as an op would be', () => {
    // A block holding three pending cuts of runs not here.
    const cuts = { '1:X': [[0, 1]], '1:Y': [[0, 1]], '1:Z': [[0, 1]] };
    const meta = { clock: {}, counters: {}, blocks: { body: { k: 't', ts: 2, runs: { '2:A': ['^', ['ab']] }, cuts } } };
    const merge = (limits) => applyOp(null, op('merge', 10, 'H', { seq: 1, data: { body: 'ab' }, meta }), limits).entry;
    assert.strictEqual(merge({ pendingMax: 2 }).data.body, undefined, 'past a lowered bound: not taken');
    assert.strictEqual(merge({ pendingMax: 3 }).data.body, 'ab', 'within it: taken');
    assert.strictEqual(merge(null).data.body, 'ab', 'the default bound');
  });

  await t.test('applyOp takes { pendingMax }; a refusal names the bound, the count and the limit', () => {
    const splice = (ts, origin, seq, value) => op('splice', ts, origin, { seq, key: 'body', value });
    const first = applyOp(null, splice(1, 'A', 1, { at: '^', content: 'ab' }));
    const limits = { pendingMax: 1 };
    const one = applyOp(first.entry, splice(2, 'B', 1, { cut: [['1:Z', 0, 1]], content: '' }), limits);
    assert.deepStrictEqual([one.changed, one.rejected], [true, []]);
    const two = applyOp(one.entry, splice(3, 'B', 2, { cut: [['1:Y', 0, 1]], content: '' }), limits);
    const refused = { field: 'body', reason: 'bound', detail: 'pending', count: 1, max: 1 };
    assert.deepStrictEqual([two.changed, two.rejected], [false, [refused]]);
    const loose = applyOp(one.entry, splice(3, 'B', 2, { cut: [['1:Y', 0, 1]], content: '' }));
    assert.strictEqual(loose.changed, true, 'the default bound is PENDING_MAX');
    const off = (ts, seq, id, entry) =>
      applyOp(entry, op('mark', ts, 'B', { seq, key: 'body', value: { off: id } }), limits);
    const held = off(4, 3, '1:Q', first.entry);
    assert.strictEqual(held.changed, true);
    assert.deepStrictEqual(off(5, 4, '1:W', held.entry).rejected, [refused]);
  });
});

test('ops: the kinds’ precedence on the op path', async (t) => {
  await t.test('kinds meeting on one field in any order leave the lowest rank everywhere', () => {
    const splice = (ts, origin, seq, content) =>
      op('splice', ts, origin, { seq, key: 'f', value: { at: '^', content } });
    const ops = {
      register: op('set', 10, 'R', { data: { f: 'reg' } }),
      counter: op('inc', 20, 'C', { seq: 1, key: 'f', value: 7 }),
      set: op('add', 30, 'S', { seq: 1, key: 'f', value: ['x'] }),
      list: splice(40, 'L', 1, [1]),
      text: splice(50, 'T', 1, 'txt'),
      tree: op('tree', 60, 'W', { seq: 1, key: 'f', value: { node: 'n', parent: null, fi: 'V' } }),
    };
    const reads = {
      register: 'reg',
      counter: 7,
      set: ['x'],
      list: [1],
      text: 'txt',
      tree: [{ id: 'n', children: [] }],
    };
    const kinds = Object.keys(ops);
    // Drop the winners one by one: whatever is left, the lowest rank among
    // them wins in every arrival order, data and meta alike.
    for (let i = 0; i < kinds.length; i++) {
      assertCommutes(
        kinds.slice(i).map((kind) => ops[kind]),
        { f: reads[kinds[i]] },
      );
    }
  });
});

test('ops: a keystroke grows the rope in place', async (t) => {
  await t.test('appending to a run leaves a new block that reads one more; nothing is rebuilt, nothing walked', () => {
    const S = require('../src/text/sequence.js');
    const splice = (ts, seq, value) => op('splice', ts, 'A', { seq, key: 'body', value });
    let entry = applyOp(null, splice(1, 1, { at: '^', content: 'ab' })).entry;
    const run = '1:A';
    const rebuilds = S.stats().rebuilds;
    for (let i = 0; i < 5; i++) {
      const before = entry.meta.blocks.body;
      entry = applyOp(entry, splice(2 + i, 2 + i, { run, from: 2 + i, content: 'x' })).entry;
      const after = entry.meta.blocks.body;
      assert.notStrictEqual(after, before, 'a new block');
      assert.strictEqual(S.lengthOf(after), S.lengthOf(before) + 1);
      assert.strictEqual(S.render(after), entry.data.body);
      assert.strictEqual(S.render(before), entry.data.body.slice(0, -1), 'the block before reads as it did');
    }
    assert.strictEqual(entry.data.body, 'abxxxxx');
    assert.deepStrictEqual(entry.meta.blocks.body.runs, { [run]: ['^', ['abxxxxx']] });
    assert.strictEqual(S.stats().rebuilds, rebuilds);
    // After a reset the base changes: the next keystroke lands under it.
    const reset = applyOp(entry, op('write', 20, 'B', { data: { t: 1 } })).entry;
    const typed = applyOp(reset, splice(21, 7, { at: '^', content: 'new' })).entry;
    const more = applyOp(typed, splice(22, 8, { run: '21:A', from: 3, content: '!' })).entry;
    assert.strictEqual(more.data.body, 'new!');
    assert.strictEqual(S.render(more.meta.blocks.body), 'new!');
  });
});

test('ops: unset is a field’s own reset', async (t) => {
  const { applyOp, mergeEntry, isAlive, kindsOf, packOps, unpackOps } = require('../src/ops.js');
  const S = require('../src/text/sequence.js');
  const at = (ts, origin, type, extra) => ({ origin, seq: ts, ts, type, id: 'r', ...extra });
  await t.test('an older set loses to it, a newer one brings the field back; the tombstone persists', () => {
    let entry = applyOp(null, at(1, 'A', 'write', { data: { a: 1, b: 2 } })).entry;
    const unset = applyOp(entry, at(5, 'B', 'unset', { value: ['a', 'nope'] }));
    assert.strictEqual(unset.changed, true);
    assert.deepStrictEqual(unset.delta, { a: undefined, nope: undefined });
    entry = unset.entry;
    assert.deepStrictEqual(entry.data, { b: 2 });
    assert.deepStrictEqual(entry.meta.gone, { a: [5, 'B'], nope: [5, 'B'] }, 'the watermarks, a field never set too');
    assert.strictEqual(entry.meta.clock.a, undefined, 'the register went');
    assert.deepStrictEqual(kindsOf(entry), { b: 'register' });
    const older = applyOp(entry, at(3, 'C', 'set', { data: { a: 3 } }));
    assert.strictEqual(older.changed, false, 'an older set loses');
    const newer = applyOp(entry, at(7, 'C', 'set', { data: { a: 7 } })).entry;
    assert.deepStrictEqual(newer.data, { a: 7, b: 2 });
    // The same unset twice, and the two orders of the older set and the unset, agree.
    assert.strictEqual(applyOp(entry, at(5, 'B', 'unset', { value: ['a'] })).changed, false);
    const other = applyOp(
      applyOp(applyOp(null, at(1, 'A', 'write', { data: { a: 1, b: 2 } })).entry, at(3, 'C', 'set', { data: { a: 3 } }))
        .entry,
      at(5, 'B', 'unset', { value: ['a', 'nope'] }),
    ).entry;
    assert.deepStrictEqual(other.data, entry.data);
    assert.deepStrictEqual(other.meta, entry.meta);
  });

  await t.test('a counter, a set or a list under the field goes with it, and merges agree', () => {
    let entry = applyOp(null, at(1, 'A', 'write', { data: { t: 1 } })).entry;
    entry = applyOp(entry, at(2, 'A', 'inc', { key: 'hits', value: 3 })).entry;
    entry = applyOp(entry, at(3, 'A', 'add', { key: 'tags', value: ['x'] })).entry;
    entry = applyOp(entry, at(4, 'A', 'splice', { key: 'items', value: { at: S.HEAD, content: [1, 2] } })).entry;
    const gone = applyOp(entry, at(6, 'B', 'unset', { value: ['hits', 'tags', 'items'] })).entry;
    assert.deepStrictEqual(gone.data, { t: 1 });
    assert.deepStrictEqual([gone.meta.counters, gone.meta.sets, gone.meta.blocks], [{}, {}, {}]);
    // An increment stamped below the unset is moot; one above it makes the field a counter again.
    const late = applyOp(gone, at(5, 'C', 'inc', { key: 'hits', value: 1 }));
    assert.strictEqual(late.changed, false);
    const again = applyOp(gone, at(7, 'C', 'inc', { key: 'hits', value: 1 })).entry;
    assert.deepStrictEqual(again.data, { t: 1, hits: 1 });
    // The two orders agree: the increments below the unset go, the one above stays.
    let other = applyOp(entry, at(7, 'C', 'inc', { key: 'hits', value: 1 })).entry;
    other = applyOp(other, at(6, 'B', 'unset', { value: ['hits', 'tags', 'items'] })).entry;
    assert.deepStrictEqual(other.data, again.data);
    assert.deepStrictEqual(other.meta, again.meta);
    // A merge of the two pictures is the unset one, either way round.
    const joined = mergeEntry(entry, gone);
    assert.deepStrictEqual(joined.data, { t: 1 });
    assert.deepStrictEqual(mergeEntry(gone, entry).meta, joined.meta);
    assert.deepStrictEqual(joined.meta.gone.hits, [6, 'B']);
    // A record reset above the unset forgets the watermark; one below leaves it.
    const reset = applyOp(gone, at(9, 'A', 'write', { data: { fresh: true } })).entry;
    assert.deepStrictEqual(reset.meta.gone, {});
    const older = applyOp(gone, at(2, 'A', 'write', { data: { fresh: true } })).entry;
    assert.deepStrictEqual(older.meta.gone, gone.meta.gone);
  });

  await t.test('an unset after a delete does not revive the record', () => {
    let entry = applyOp(null, at(1, 'A', 'write', { data: { a: 1 } })).entry;
    entry = applyOp(entry, at(2, 'A', 'delete', {})).entry;
    assert.strictEqual(isAlive(entry), false);
    const unset = applyOp(entry, at(3, 'B', 'unset', { value: ['a'] })).entry;
    assert.strictEqual(isAlive(unset), false, 'a watermark is not a write');
    const revived = applyOp(unset, at(4, 'B', 'set', { data: { a: 4 } })).entry;
    assert.strictEqual(isAlive(revived), true);
  });

  await t.test('a malformed unset is reported, and the wire codes it as u', () => {
    const bad = applyOp(null, at(1, 'A', 'unset', { value: 'a' }));
    assert.deepStrictEqual(bad.rejected, [{ field: null, reason: 'malformed' }]);
    const [row] = packOps([at(1, 'A', 'unset', { value: ['a'] })]);
    assert.strictEqual(row[3], 'u');
    assert.deepStrictEqual(unpackOps([row])[0].type, 'unset');
  });
});

test('ops: a field may be a path; a prefix holds what hangs under it', async (t) => {
  const { applyOp, mergeEntry, normalizeMeta, MAX_PATHS } = require('../src/ops.js');
  const at = (ts, origin, type, extra) => ({ origin, seq: ts, ts, type, id: 'r', ...extra });
  const orders = (ops) => {
    const forward = ops.reduce((entry, op) => applyOp(entry, op).entry, null);
    const backward = [...ops].reverse().reduce((entry, op) => applyOp(entry, op).entry, null);
    assert.deepStrictEqual(backward.data, forward.data, 'the data agrees whatever the order');
    assert.deepStrictEqual(backward.meta, forward.meta, 'and so does the meta');
    return forward;
  };

  await t.test(
    'a register at a prefix resets what hangs under it below its stamp; a later child survives over it',
    () => {
      const base = applyOp(null, at(1, 'A', 'write', { data: { title: 'x' } })).entry;
      const older = at(2, 'B', 'set', { data: { 'profile/city': 'Kyiv' } });
      const parent = at(3, 'A', 'set', { data: { profile: { zip: 1 } } });
      const newer = at(4, 'B', 'set', { data: { 'profile/geo/lat': 50 } });
      const entry = orders([at(1, 'A', 'write', { data: { title: 'x' } }), older, parent, newer]);
      assert.deepStrictEqual(
        entry.data,
        { title: 'x', profile: { zip: 1 }, 'profile/geo/lat': 50 },
        'flat: the older child went',
      );
      assert.strictEqual(base.meta.clock['profile/city'], undefined);
      // An unset of the prefix takes the subtree, below its stamp.
      const unset = applyOp(entry, at(5, 'C', 'unset', { value: ['profile'] })).entry;
      assert.deepStrictEqual(unset.data, { title: 'x' });
      assert.deepStrictEqual(Object.keys(unset.meta.gone), ['profile']);
      const late = applyOp(unset, at(4, 'D', 'set', { data: { 'profile/geo/lng': 30 } }));
      assert.strictEqual(late.changed, false, 'a child stamped below the prefix’s unset is moot');
      const fresh = applyOp(unset, at(6, 'D', 'set', { data: { 'profile/geo/lng': 30 } })).entry;
      assert.deepStrictEqual(fresh.data, { title: 'x', 'profile/geo/lng': 30 });
    },
  );

  await t.test('a counter, a set or a block holds its prefix alone, whatever the order', () => {
    const write = at(1, 'A', 'write', { data: {} });
    const child = at(2, 'B', 'set', { data: { 'stats/views': 1, 'stats/deep/x': 2 } });
    const counter = at(3, 'A', 'inc', { key: 'stats', value: 1 });
    const entry = orders([write, child, counter]);
    assert.deepStrictEqual(entry.data, { stats: 1 }, 'the children went where the counter landed');
    const refused = applyOp(entry, at(4, 'B', 'set', { data: { 'stats/views': 2 } }));
    assert.deepStrictEqual(refused.rejected, [{ field: 'stats/views', reason: 'counter', prefix: 'stats' }]);
    assert.strictEqual(refused.changed, false);
    const underSet = orders([
      write,
      at(2, 'A', 'add', { key: 'tags', value: ['x'] }),
      at(3, 'B', 'inc', { key: 'tags/n', value: 1 }),
    ]);
    assert.deepStrictEqual(underSet.data, { tags: ['x'] });
    // Under a register that holds an object, children are fine and read over it.
    const over = orders([
      write,
      at(2, 'A', 'set', { data: { profile: { a: 1 } } }),
      at(3, 'B', 'inc', { key: 'profile/views', value: 2 }),
    ]);
    assert.deepStrictEqual(over.data, { profile: { a: 1 }, 'profile/views': 2 });
  });

  await t.test('two pictures of a record with paths merge as the ops would', () => {
    const base = applyOp(null, at(1, 'A', 'write', { data: { title: 'x' } })).entry;
    const a = applyOp(base, at(2, 'A', 'set', { data: { 'profile/city': 'Kyiv' } })).entry;
    const b = applyOp(base, at(3, 'B', 'set', { data: { profile: { zip: 1 } } })).entry;
    const joined = mergeEntry(a, b);
    assert.deepStrictEqual(joined.data, { title: 'x', profile: { zip: 1 } });
    assert.deepStrictEqual(mergeEntry(b, a).meta, joined.meta);
    const c = applyOp(base, at(4, 'C', 'inc', { key: 'profile', value: 1 })).entry;
    assert.deepStrictEqual(mergeEntry(a, c).data, { title: 'x', profile: 1 }, 'the counter holds the prefix alone');
  });

  await t.test('a record holds at most MAX_PATHS fields: a new one past it is bound, a peer’s picture is cut', () => {
    const data = {};
    for (let i = 0; i < MAX_PATHS; i++) data[`f/${String(i).padStart(4, '0')}`] = i;
    const entry = applyOp(null, at(1, 'A', 'write', { data })).entry;
    assert.strictEqual(Object.keys(entry.data).length, MAX_PATHS);
    const more = applyOp(entry, at(2, 'B', 'set', { data: { extra: 1 } }));
    assert.deepStrictEqual(more.rejected, [
      { field: 'extra', reason: 'bound', detail: 'paths', count: MAX_PATHS + 1, max: MAX_PATHS },
    ]);
    assert.strictEqual(more.changed, false);
    const again = applyOp(entry, at(2, 'B', 'set', { data: { 'f/0000': 9 } }));
    assert.strictEqual(again.changed, true, 'a field held already is no new path');
    const meta = JSON.parse(JSON.stringify(entry.meta));
    meta.clock.zzz = [1, 'A'];
    meta.clock['bad//path'] = [1, 'A'];
    const normalized = normalizeMeta(meta);
    assert.strictEqual(Object.keys(normalized.clock).length, MAX_PATHS, 'the first in sorted order stay');
    assert.strictEqual(normalized.clock.zzz, undefined);
    assert.strictEqual(normalized.clock['bad//path'], undefined);
  });
});

test('ops: a list’s elements and a tree’s nodes carry fields of their own', async (t) => {
  const { applyOp, mergeEntry } = require('../src/all/all.js');
  const S = require('../src/text/sequence.js');
  const at = (ts, origin, type, extra) => ({ origin, seq: ts, ts, type, id: 'r', ...extra });
  const orders = (ops) => {
    const forward = ops.reduce((entry, op) => applyOp(entry, op).entry, null);
    const backward = [...ops].reverse().reduce((entry, op) => applyOp(entry, op).entry, null);
    assert.deepStrictEqual(backward.data, forward.data, 'the data agrees whatever the order');
    assert.deepStrictEqual(backward.meta, forward.meta, 'and so does the meta');
    return forward;
  };

  await t.test(
    'a path under a list element or a tree node lands, under a text it is refused; a child is kept apart',
    () => {
      const list = at(1, 'A', 'splice', { key: 'items', value: { at: S.HEAD, content: ['a', { n: 1 }] } });
      const [first, second] = ['1:0:A', '1:1:A'];
      const child = at(2, 'B', 'set', { data: { [`items/${first}/body`]: 'hi', [`items/${second}/body`]: 'ho' } });
      const counter = at(3, 'C', 'inc', { key: `items/${second}/hits`, value: 1 });
      const entry = orders([list, child, counter]);
      assert.deepStrictEqual(entry.data, {
        items: ['a', { n: 1 }],
        [`items/${first}/body`]: 'hi',
        [`items/${second}/body`]: 'ho',
        [`items/${second}/hits`]: 1,
      });
      const text = at(1, 'A', 'splice', { key: 'body', value: { at: S.HEAD, content: 'ab' } });
      const under = applyOp(applyOp(null, text).entry, at(2, 'B', 'set', { data: { 'body/1:0:A/x': 1 } }));
      assert.deepStrictEqual(under.rejected, [{ field: 'body/1:0:A/x', reason: 'text', prefix: 'body' }]);
      // A tree node's data, in either order.
      const move = at(1, 'A', 'tree', { key: 'outline', value: { node: 'n1', parent: null, fi: 'a' } });
      const data = at(2, 'B', 'set', { data: { 'outline/n1/title': 'Intro' } });
      const tree = orders([move, data]);
      assert.strictEqual(tree.data['outline/n1/title'], 'Intro');
      // A merge of two pictures agrees with the ops.
      const base = applyOp(null, list).entry;
      const left = applyOp(base, child).entry;
      const right = applyOp(base, counter).entry;
      assert.deepStrictEqual(mergeEntry(left, right).data, entry.data);
      assert.deepStrictEqual(mergeEntry(right, left).meta, mergeEntry(left, right).meta);
    },
  );
});
