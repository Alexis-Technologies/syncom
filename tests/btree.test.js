'use strict';

// The rope's data structures against plain arrays: the persistent B+-tree
// with its two measures (src/text/btree.js) and the persistent map
// (src/text/pmap.js) — every operation checked against the array or the
// Map it stands for, versions kept and read back after later edits.

const test = require('node:test');
const assert = require('node:assert');
const T = require('../src/text/btree.js');
const P = require('../src/text/pmap.js');

const rng = (seed) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const pick = (random, n) => Math.floor(random() * n);

let made = 0;
// A segment of `len` slots (`vis` shown) or, with len 0, a fence.
const item = (len, vis) => ({ id: made++, len, vis, node: null });
// The lineage the trees of these tests are hinted for.
const TAG = { head: null };

// Items by identity: an item points at its leaf and the leaf at its items,
// so a structural comparison would walk the whole tree for every item.
const same = (seen, items, where) => {
  assert.strictEqual(seen.length, items.length, `${where}: count`);
  for (let i = 0; i < items.length; i++) assert.strictEqual(seen[i], items[i], `${where}: item ${i}`);
};

// What the tree says, read every way, against the array it should equal.
const check = (root, items, where) => {
  same([...T.iterate(root)], items, `${where}: iterate`);
  let s = 0;
  let v = 0;
  for (const it of items) {
    s += it.len;
    v += it.vis ? it.len : 0;
  }
  assert.deepStrictEqual([root.s, root.v], [s, v], `${where}: measures`);
  // Every unit locates the item holding it, with the measures before it.
  let at = 0;
  let before = { s: 0, v: 0 };
  for (const it of items) {
    for (let k = 0; k < it.len; k++) {
      const cursor = T.locate(root, 's', at + k);
      assert.strictEqual(cursor.item, it, `${where}: locate s ${at + k}`);
      assert.deepStrictEqual([cursor.s, cursor.v], [before.s, before.v], `${where}: position at s ${at + k}`);
      if (it.vis) {
        const seen = T.locate(root, 'v', before.v + k);
        assert.strictEqual(seen.item, it, `${where}: locate v ${before.v + k}`);
      }
    }
    at += it.len;
    before = { s: before.s + it.len, v: before.v + (it.vis ? it.len : 0) };
  }
  assert.strictEqual(T.locate(root, 's', s), null, `${where}: past the end`);
  assert.strictEqual(T.locate(root, 'v', v), null, `${where}: past the visible end`);
};

// The head version: positions and neighbours by the hints.
const checkHead = (root, items, where) => {
  let s = 0;
  let v = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    assert.deepStrictEqual(T.positionOf(root, it, TAG), { s, v }, `${where}: positionOf ${i}`);
    assert.strictEqual(T.before(root, it, TAG), i > 0 ? items[i - 1] : null, `${where}: before ${i}`);
    assert.strictEqual(T.after(root, it, TAG), i + 1 < items.length ? items[i + 1] : null, `${where}: after ${i}`);
    const cursor = T.cursorAt(root, it, TAG);
    assert.strictEqual(cursor.item, it, `${where}: cursorAt ${i}`);
    assert.deepStrictEqual([cursor.s, cursor.v], [s, v], `${where}: cursorAt position ${i}`);
    s += it.len;
    v += it.vis ? it.len : 0;
  }
};

test('the persistent B+-tree with two measures', async (t) => {
  await t.test('fromItems, locate and iterate agree with the array, at every size', () => {
    for (const n of [0, 1, 2, 31, 32, 33, 64, 65, 1000, 1057]) {
      const items = Array.from({ length: n }, (_, i) => item(i % 3 === 0 ? 0 : 1 + (i % 5), i % 4 !== 1));
      const root = T.fromItems(items, TAG);
      check(root, items, `n=${n}`);
      checkHead(root, items, `n=${n}`);
    }
  });

  await t.test('edits copy the path, versions stay readable, the head answers the hints (seeded)', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const random = rng(seed);
      let items = Array.from({ length: pick(random, 80) }, (_, i) => item(1 + (i % 4), random() < 0.8));
      let root = T.fromItems(items, TAG);
      const versions = [[root, items]];
      for (let step = 0; step < 120; step++) {
        const roll = random();
        const fresh = Array.from({ length: 1 + pick(random, 3) }, (_, i) =>
          item(i === 0 && random() < 0.3 ? 0 : 1 + pick(random, 6), random() < 0.8),
        );
        if (items.length === 0) {
          root = T.append(root, fresh, TAG);
          items = [...items, ...fresh];
        } else if (roll < 0.3) {
          const i = pick(random, items.length);
          root = T.insertBefore(root, items[i], fresh, TAG);
          items = [...items.slice(0, i), ...fresh, ...items.slice(i)];
        } else if (roll < 0.6) {
          const i = pick(random, items.length);
          root = T.insertAfter(root, items[i], fresh, TAG);
          items = [...items.slice(0, i + 1), ...fresh, ...items.slice(i + 1)];
        } else if (roll < 0.9) {
          const i = pick(random, items.length);
          const replacement = random() < 0.2 ? [] : fresh;
          root = T.replace(root, items[i], replacement, TAG);
          items = [...items.slice(0, i), ...replacement, ...items.slice(i + 1)];
        } else {
          root = T.append(root, fresh, TAG);
          items = [...items, ...fresh];
        }
        check(root, items, `seed ${seed} step ${step}`);
        checkHead(root, items, `seed ${seed} step ${step} head`);
        versions.push([root, items]);
      }
      // Every older version still reads top-down as it was.
      for (const [i, [old, was]] of versions.entries()) check(old, was, `seed ${seed} version ${i}`);
      // Emptied item by item: no leaf left empty for a walk to land on.
      let bare = root;
      let left = items;
      while (left.length > 0) {
        const i = pick(random, left.length);
        bare = T.replace(bare, left[i], [], TAG);
        left = [...left.slice(0, i), ...left.slice(i + 1)];
        check(bare, left, `seed ${seed} emptied to ${left.length}`);
        checkHead(bare, left, `seed ${seed} emptied to ${left.length} head`);
      }
      assert.strictEqual(T.first(bare), null, `seed ${seed} empty`);
      check(root, items, `seed ${seed} before emptying`);
      // A cursor walks any version from any point.
      const [old, was] = versions[pick(random, versions.length)];
      if (was.length > 0) {
        const from = pick(random, was.length);
        let s = 0;
        for (let i = 0; i < from; i++) s += was[i].len;
        const cursor = T.locate(old, 's', s) ?? T.first(old);
        // The cursor is spent by the walk: its item is read first.
        const startIndex = was.indexOf(cursor.item);
        const seen = [...T.iterate(old, cursor)];
        same(seen, was.slice(startIndex), `seed ${seed} cursor walk`);
      }
    }
  });

  await t.test('the tree stays shallow: a leaf holds at most MAX_ITEMS, every level splits evenly', () => {
    const items = Array.from({ length: 10_000 }, (_, i) => item(1, i % 7 !== 0));
    let root = T.fromItems(items.slice(0, 1), TAG);
    for (let i = 1; i < items.length; i++) root = T.append(root, [items[i]], TAG);
    let depth = 0;
    let node = root;
    while (!node.leaf) {
      depth++;
      node = node.children[0];
    }
    assert.ok(depth <= 4, `depth ${depth}`);
    const widths = [];
    const walk = (n) => {
      if (n.leaf) widths.push(n.items.length);
      else {
        widths.push(n.children.length);
        for (const child of n.children) walk(child);
      }
    };
    walk(root);
    assert.ok(widths.every((w) => w <= T.MAX_ITEMS));
    check(root, items, 'appended');
    checkHead(root, items, 'appended');
  });
});

test('a fork of an older version re-hints once, and so does the head it forked from', () => {
  const items = Array.from({ length: 200 }, (_, i) => item(1 + (i % 3), i % 5 !== 0));
  let root = T.fromItems(items, TAG);
  const older = root;
  // The head moves on.
  const added = [item(2, true), item(1, false)];
  root = T.insertAfter(root, items[50], added, TAG);
  const headItems = [...items.slice(0, 51), ...added, ...items.slice(51)];
  checkHead(root, headItems, 'head');
  // A fork of the older version, under a tag of its own: its hints are
  // stale (the head rewrote the shared ones) and come back in one pass.
  const fork = { head: null };
  const before = T.stats().rehints;
  const fresh = item(3, true);
  const forked = T.insertBefore(older, items[10], [fresh], fork);
  assert.strictEqual(T.stats().rehints, before + 1, 'one re-hint for the fork');
  check(forked, [...items.slice(0, 10), fresh, ...items.slice(10)], 'fork');
  // The head it forked from reads top-down as it was, and re-hints once
  // when its hints are next needed — then trusts them.
  check(root, headItems, 'head after the fork');
  const again = T.stats().rehints;
  root = T.replace(root, headItems[0], [], TAG);
  assert.strictEqual(T.stats().rehints, again + 1, 'the head re-hints once');
  const more = T.stats().rehints;
  checkHead(root, headItems.slice(1), 'head edited again');
  root = T.replace(root, headItems[1], [], TAG);
  checkHead(root, headItems.slice(2), 'head once more');
  assert.strictEqual(T.stats().rehints, more, 'and trusts its hints from then on');
});

test('the persistent map', async (t) => {
  await t.test('get, set and entries agree with a Map; older versions keep their keys (seeded)', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const random = rng(seed);
      let map = P.EMPTY;
      const mirror = new Map();
      const versions = [];
      for (let step = 0; step < 3000; step++) {
        const key = `${pick(random, 900)}:${['A', 'B', 'C'][pick(random, 3)]}`;
        const value = { step };
        map = P.set(map, key, value);
        mirror.set(key, value);
        if (step % 500 === 0) versions.push([map, new Map(mirror)]);
      }
      assert.strictEqual(map.size, mirror.size);
      for (const [key, value] of mirror) assert.strictEqual(P.get(map, key), value, key);
      assert.strictEqual(P.get(map, 'nope'), undefined);
      assert.deepStrictEqual(new Map(P.entries(map)), mirror);
      for (const [old, was] of versions) {
        assert.strictEqual(old.size, was.size);
        for (const [key, value] of was) assert.strictEqual(P.get(old, key), value, `old ${key}`);
      }
    }
  });

  await t.test('colliding hashes share a bucket and still tell the keys apart', () => {
    // Two keys with one 32-bit hash, found by brute force (some tens of
    // thousands of keys): they meet in a bucket at the bottom of the trie.
    const seen = new Map();
    let a = null;
    let b = null;
    for (let i = 0; a === null; i++) {
      const key = `c${i}`;
      const hash = P.hashOf(key);
      const other = seen.get(hash);
      if (other === undefined) seen.set(hash, key);
      else [a, b] = [other, key];
    }
    assert.strictEqual(P.hashOf(a), P.hashOf(b));
    let map = P.fromEntries([
      [a, 1],
      [b, 2],
    ]);
    assert.strictEqual(map.size, 2);
    assert.strictEqual(P.get(map, a), 1);
    assert.strictEqual(P.get(map, b), 2);
    assert.strictEqual(P.get(map, 'c'), undefined);
    const older = map;
    map = P.set(map, a, 3);
    assert.strictEqual(map.size, 2, 'a key set again is not a new key');
    assert.strictEqual(P.get(map, a), 3);
    assert.strictEqual(P.get(map, b), 2);
    assert.strictEqual(P.get(older, a), 1, 'the older version keeps its value');
    assert.deepStrictEqual(
      new Map(P.entries(map)),
      new Map([
        [a, 3],
        [b, 2],
      ]),
    );
    // And a map of many keys, built in bulk, answers every one.
    const many = P.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`k${i}`, i]));
    assert.strictEqual(many.size, 20_000);
    for (let i = 0; i < 20_000; i += 997) assert.strictEqual(P.get(many, `k${i}`), i);
  });
});

test('the chunked sorted list', async (t) => {
  const L = require('../src/text/plist.js');
  const entry = (off) => ({ off, id: made++ });
  // What the list says against the sorted array it stands for: the walk,
  // the chunk sizes, and a find at every entry's key, just below it and
  // just above it — the predecessor, exact or not.
  const check = (list, entries, where) => {
    assert.strictEqual(list.size, entries.length, `${where}: size`);
    same([...L.iterate(list)], entries, `${where}: iterate`);
    assert.strictEqual(L.last(list), entries[entries.length - 1], `${where}: last`);
    for (const chunk of list.chunks) assert.ok(chunk.length > 0 && chunk.length <= L.CHUNK, `${where}: chunk sizes`);
    assert.strictEqual(L.find(list, entries.length === 0 ? 0 : entries[0].off - 1), null, `${where}: before the first`);
    // The last entry at or before `key`, by a scan.
    const predecessor = (key) => {
      let at = null;
      for (const held of entries) if (held.off <= key) at = held;
      return at;
    };
    for (let i = 0; i < entries.length; i++) {
      const { off } = entries[i];
      const found = L.find(list, off);
      assert.strictEqual(found.entry, entries[i], `${where}: find ${off}`);
      assert.strictEqual(list.chunks[found.c][found.i], found.entry, `${where}: position of ${off}`);
      assert.strictEqual(L.get(list, off), entries[i], `${where}: get ${off}`);
      for (const key of [off + 0.25, off - 0.25]) {
        const expected = predecessor(key);
        assert.strictEqual(L.find(list, key)?.entry ?? null, expected, `${where}: find ${key}`);
        assert.strictEqual(L.get(list, key), expected?.off === key ? expected : undefined, `${where}: get ${key}`);
      }
    }
    if (entries.length > 0) {
      const at = pick(rng(entries.length), entries.length);
      const found = L.find(list, entries[at].off);
      same([...L.backward(list, found.c, found.i)], entries.slice(0, at + 1).reverse(), `${where}: backward`);
    }
  };

  await t.test('fromArray, find, get and the walks agree with the array, at every size', () => {
    for (const n of [0, 1, 2, 63, 64, 65, 200, 1000]) {
      const entries = Array.from({ length: n }, (_, i) => entry(i * 3));
      check(L.fromArray(entries), entries, `n=${n}`);
    }
  });

  await t.test('splice and append copy one chunk, split it when it overflows, drop it when emptied (seeded)', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const random = rng(seed);
      let entries = [];
      let list = L.EMPTY;
      const versions = [];
      for (let step = 0; step < 240; step++) {
        const roll = random();
        if (roll < 0.5 || entries.length === 0) {
          // An insert between two entries, keyed between them (or past the last, or before the first).
          const i = entries.length === 0 ? -1 : pick(random, entries.length + 1) - 1;
          const low = i < 0 ? (entries[0]?.off ?? 0) - 2 : entries[i].off;
          const high = i + 1 < entries.length ? entries[i + 1].off : low + 2;
          if (high - low < 2 ** -20) continue;
          const fresh = entry((low + high) / 2);
          if (i < 0) list = L.splice(list, 0, 0, 0, [fresh]);
          else {
            const found = L.find(list, entries[i].off);
            list = L.splice(list, found.c, found.i + 1, 0, [fresh]);
          }
          entries = [...entries.slice(0, i + 1), fresh, ...entries.slice(i + 1)];
        } else if (roll < 0.8) {
          // One or two entries replaced by one, two or none, keyed as they were.
          const i = pick(random, entries.length);
          const count = i + 1 < entries.length && random() < 0.5 ? 2 : 1;
          const found = L.find(list, entries[i].off);
          const pieces = [];
          if (random() < 0.7) pieces.push({ ...entries[i], id: made++ });
          if (count === 2 && random() < 0.5) pieces.push({ ...entries[i + 1], id: made++ });
          list = L.splice(list, found.c, found.i, count, pieces);
          entries = [...entries.slice(0, i), ...pieces, ...entries.slice(i + count)];
        } else {
          const base = entries.length === 0 ? 0 : entries[entries.length - 1].off;
          const fresh = Array.from({ length: 1 + pick(random, 4) }, (_, k) => entry(base + k + 1));
          list = L.append(list, fresh);
          entries = [...entries, ...fresh];
        }
        check(list, entries, `seed ${seed} step ${step}`);
        versions.push([list, entries]);
      }
      for (const [i, [old, was]] of versions.entries()) check(old, was, `seed ${seed} version ${i}`);
    }
  });
});
