'use strict';

// The sorted index (src/sorted.js): chunked sorted arrays of (keys, id)
// entries — insert, remove, seek, iterate forward and backward by group,
// build once, ordinal — held against a sorted copy.

const test = require('node:test');
const assert = require('node:assert');
const { SortedIndex, CHUNK, compare, compareEntries } = require('../src/sorted.js');

let seed = 7;
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const entry = (i) => ({
  keys: [`org${Math.floor(random() * 5)}`, Math.floor(random() * 50)],
  id: `r${String(i).padStart(5, '0')}`,
});
const walk = (iterator) => {
  const out = [];
  for (let id = iterator.next(); id !== null; id = iterator.next()) out.push(id);
  return out;
};
const sorted = (entries) => entries.slice().sort(compareEntries);
const ids = (entries) => entries.map((e) => e.id);
// The result's one order, backwards: the groups of equal keys from the last down, the ids of each forward.
const backwards = (entries) => {
  const groups = new Map();
  for (const e of sorted(entries)) {
    const key = e.keys.join('\u0000');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e.id);
  }
  const out = [];
  for (const key of [...groups.keys()].reverse()) out.push(...groups.get(key));
  return out;
};

test('insert keeps keys then id order across chunk splits (3 000 random entries, walked against a sorted copy)', () => {
  seed = 7;
  const index = new SortedIndex(2);
  const entries = [];
  for (let i = 0; i < 3000; i++) {
    const e = entry(i);
    entries.push(e);
    index.insert(e.keys, e.id);
  }
  assert.strictEqual(index.size, 3000);
  assert.ok(index.chunks >= Math.ceil(3000 / CHUNK), `split into chunks (${index.chunks})`);
  assert.deepStrictEqual(walk(index.iterate(index.start, index.end, false)), ids(sorted(entries)));
  assert.strictEqual(index.k, 2);
  assert.throws(() => new SortedIndex(0), TypeError);
});

test('remove by keys and id: a miss is false, an empty chunk goes, two small neighbours merge', () => {
  seed = 11;
  const index = new SortedIndex(2);
  const entries = [];
  for (let i = 0; i < 2000; i++) {
    const e = entry(i);
    entries.push(e);
    index.insert(e.keys, e.id);
  }
  const before = index.chunks;
  assert.strictEqual(index.remove(['nope', 1], 'r00000'), false, 'other keys: a miss');
  assert.strictEqual(index.remove(entries[0].keys, 'zzz'), false, 'another id: a miss');
  let removed = 0;
  for (let i = 0; i < entries.length; i++) {
    if (i % 4 !== 3) removed += index.remove(entries[i].keys, entries[i].id) ? 1 : 0;
  }
  assert.strictEqual(removed, 1500);
  assert.strictEqual(index.size, 500);
  assert.ok(index.chunks < before, `neighbours merged (${index.chunks} < ${before})`);
  const kept = entries.filter((_, i) => i % 4 === 3);
  assert.deepStrictEqual(walk(index.iterate(index.start, index.end, false)), ids(sorted(kept)));
  for (const e of kept) assert.strictEqual(index.remove(e.keys, e.id), true);
  assert.strictEqual(index.size, 0);
  assert.strictEqual(index.chunks, 1, 'the one empty chunk stays');
  assert.deepStrictEqual(walk(index.iterate(index.start, index.end, false)), []);
  index.insert(['a', 1], 'x');
  assert.deepStrictEqual(walk(index.iterate(index.start, index.end, false)), ['x']);
});

test('seek: a prefix of fewer keys, inclusive and exclusive, an id tie-break, before the first and past the last', () => {
  seed = 3;
  const index = new SortedIndex(2);
  const entries = [];
  for (let i = 0; i < 1500; i++) {
    const e = entry(i);
    entries.push(e);
    index.insert(e.keys, e.id);
  }
  const all = sorted(entries);
  // A prefix: every entry of org2, in order.
  const from = index.seek(['org2'], 1, null, true);
  const to = index.seek(['org2'], 1, null, false);
  assert.deepStrictEqual(walk(index.iterate(from, to, false)), ids(all.filter((e) => e.keys[0] === 'org2')));
  // A range on the second key within the prefix: [10, 20) and (10, 20].
  const lower = index.seek(['org2', 10], 2, null, true);
  const upper = index.seek(['org2', 20], 2, null, true);
  assert.deepStrictEqual(
    walk(index.iterate(lower, upper, false)),
    ids(all.filter((e) => e.keys[0] === 'org2' && e.keys[1] >= 10 && e.keys[1] < 20)),
  );
  const above = index.seek(['org2', 10], 2, null, false);
  const through = index.seek(['org2', 20], 2, null, false);
  assert.deepStrictEqual(
    walk(index.iterate(above, through, false)),
    ids(all.filter((e) => e.keys[0] === 'org2' && e.keys[1] > 10 && e.keys[1] <= 20)),
  );
  // An id tie-break: after one entry of a group of equal keys.
  const group = all.filter((e) => e.keys[0] === 'org1' && e.keys[1] === 7);
  assert.ok(group.length > 2, 'a group to page through');
  const after = index.seek(group[1].keys, 2, group[1].id, false);
  assert.strictEqual(index.at(after), group[2].id);
  assert.deepStrictEqual(index.keysAt(after), group[2].keys);
  const at = index.seek(group[1].keys, 2, group[1].id, true);
  assert.strictEqual(index.at(at), group[1].id);
  // Before the first and past the last.
  assert.deepStrictEqual(index.seek(['', -1], 2, null, true), index.start);
  assert.deepStrictEqual(index.seek(['zzz'], 1, null, true), index.end);
  assert.strictEqual(index.at(index.end), null);
  assert.strictEqual(index.keysAt(index.end), null);
  // Nothing and the rest sort below and above the three ordered kinds.
  index.insert([null, 1], 'none');
  index.insert([{ x: 1 }, 1], 'object');
  assert.strictEqual(index.at(index.start), 'none');
  assert.strictEqual(walk(index.iterate(index.start, index.end, false)).at(-1), 'object');
});

test('iterate forward and backward: keys backwards and ids forwards within equal keys, bounded by from and to, from a position inside a group', () => {
  seed = 5;
  const index = new SortedIndex(2);
  const entries = [];
  for (let i = 0; i < 1200; i++) {
    const e = entry(i);
    entries.push(e);
    index.insert(e.keys, e.id);
  }
  const all = sorted(entries);
  assert.deepStrictEqual(walk(index.iterate(index.start, index.end, true)), backwards(entries));
  // Bounded: the entries of org3 alone, both ways.
  const from = index.seek(['org3'], 1, null, true);
  const to = index.seek(['org3'], 1, null, false);
  const org3 = entries.filter((e) => e.keys[0] === 'org3');
  assert.deepStrictEqual(walk(index.iterate(from, to, false)), ids(sorted(org3)));
  assert.deepStrictEqual(walk(index.iterate(from, to, true)), backwards(org3));
  // From a position inside a group: a page's edge — the rest of the edge's group from there, then the groups below.
  const groups = new Map();
  for (const e of all) {
    const key = e.keys.join('\u0000');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const big = [...groups.values()].find((g) => g.length >= 4);
  const edge = big[1];
  const position = index.seek(edge.keys, 2, edge.id, false);
  const expected = [];
  let below = false;
  for (const key of [...groups.keys()].reverse()) {
    const group = groups.get(key);
    if (group === big) {
      below = true;
      for (const e of group) if (e.id > edge.id) expected.push(e.id);
      continue;
    }
    if (below) for (const e of group) expected.push(e.id);
  }
  assert.deepStrictEqual(walk(index.iterate(index.start, index.end, true, position)), expected);
  // An empty range, either way.
  assert.deepStrictEqual(walk(index.iterate(to, to, false)), []);
  assert.deepStrictEqual(walk(index.iterate(to, to, true)), []);
});

test('build sorts once and keeps what was held', () => {
  seed = 9;
  const index = new SortedIndex(2);
  const entries = [];
  for (let i = 0; i < 1300; i++) entries.push(entry(i));
  index.build(entries.slice(0, 700));
  assert.strictEqual(index.size, 700);
  index.build(entries.slice(700));
  assert.strictEqual(index.size, 1300);
  assert.strictEqual(index.chunks, Math.ceil(1300 / CHUNK));
  assert.deepStrictEqual(walk(index.iterate(index.start, index.end, false)), ids(sorted(entries)));
  index.build([]);
  assert.strictEqual(index.size, 1300, 'nothing new: as it was');
  const fresh = new SortedIndex(1);
  fresh.build([]);
  assert.strictEqual(fresh.size, 0);
  assert.deepStrictEqual(walk(fresh.iterate(fresh.start, fresh.end, false)), []);
});

test('ordinal counts the entries before a position', () => {
  seed = 13;
  const index = new SortedIndex(2);
  const entries = [];
  for (let i = 0; i < 1100; i++) {
    const e = entry(i);
    entries.push(e);
    index.insert(e.keys, e.id);
  }
  assert.strictEqual(index.ordinal(index.start), 0);
  assert.strictEqual(index.ordinal(index.end), 1100);
  const from = index.seek(['org1'], 1, null, true);
  const to = index.seek(['org1'], 1, null, false);
  assert.strictEqual(index.ordinal(to) - index.ordinal(from), entries.filter((e) => e.keys[0] === 'org1').length);
});

test('compare: nothing, booleans, numbers, strings, then the rest', () => {
  const order = [undefined, null, false, true, -1, 0, 2.5, '', 'a', 'b', {}, [], { x: 1 }];
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) {
      const expected = Math.sign(i - j);
      const actual = Math.sign(compare(order[i], order[j]));
      // Nothing is equal to nothing, an object to any object or array.
      const both = (a, b) => a === 0 && b === 0 && actual === 0;
      if (both(compare(order[i], undefined), compare(order[j], undefined))) continue;
      if (typeof order[i] === 'object' && order[i] !== null && typeof order[j] === 'object' && order[j] !== null) {
        assert.strictEqual(actual, 0);
        continue;
      }
      assert.strictEqual(actual, expected, `${String(order[i])} vs ${String(order[j])}`);
    }
  }
  assert.strictEqual(compareEntries({ keys: ['a', 1], id: 'x' }, { keys: ['a', 1], id: 'y' }), -1);
  assert.strictEqual(compareEntries({ keys: ['a', 2], id: 'x' }, { keys: ['a', 1], id: 'y' }), 1);
  assert.strictEqual(compareEntries({ keys: ['a', 1], id: 'x' }, { keys: ['a', 1], id: 'x' }), 0);
});
