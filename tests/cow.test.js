'use strict';

// The v2 engine's copy-on-write structures against plain arrays and Maps: the rope with its two measures
// and its hints (src/text/v2/rope.js), the id index (src/text/v2/ids.js), the hash trie and the chunked
// list (src/text/v2/cow.js) — every operation checked against what it stands for, each op written under
// an owner of its own, versions kept and read back after later edits, untouched.

const test = require('node:test');
const assert = require('node:assert');
const R = require('../src/text/v2/rope.js');
const I = require('../src/text/v2/ids.js');
const C = require('../src/text/v2/cow.js');

const rng = (seed) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const pick = (random, n) => Math.floor(random() * n);

let made = 0;
let owners = 0;
// A span of `len` slots (`vis` shown) or, with len 0, a fence.
const span = (len, vis) => new R.Span(made++, 0, len, vis, len === 0 ? null : 'x'.repeat(len), len === 0 ? 1 : 0, 0);
// What writes a tree: an owner of its own, never frozen until handed on.
const holderOf = (root) => ({ root, owner: ++owners, frozen: false, walked: null });

// Spans by identity: a span points at its leaf and the leaf at its spans.
const same = (seen, spans, where) => {
  assert.strictEqual(seen.length, spans.length, `${where}: count`);
  for (let i = 0; i < spans.length; i++) assert.strictEqual(seen[i], spans[i], `${where}: span ${i}`);
};

// What the tree says read from the root down, against the array it should equal.
const check = (root, spans, where) => {
  same(R.spansOf(root), spans, `${where}: walk`);
  let s = 0;
  let v = 0;
  let text = '';
  for (const it of spans) {
    s += it.len;
    v += it.vis ? it.len : 0;
    if (it.vis) text += it.body;
  }
  assert.deepStrictEqual([root.s, root.v], [s, v], `${where}: measures`);
  assert.strictEqual(R.text(root), text, `${where}: text`);
  let at = 0;
  let before = [0, 0];
  for (const it of spans) {
    for (let k = 0; k < it.len; k++) {
      const cursor = R.locate(root, false, at + k);
      assert.strictEqual(cursor.span, it, `${where}: locate s ${at + k}`);
      assert.deepStrictEqual([cursor.s, cursor.v], before, `${where}: position at s ${at + k}`);
      if (it.vis) assert.strictEqual(R.spanAt(root, true, before[1] + k).span, it, `${where}: find v ${before[1] + k}`);
    }
    at += it.len;
    before = [before[0] + it.len, before[1] + (it.vis ? it.len : 0)];
  }
  assert.strictEqual(R.locate(root, false, s), null, `${where}: past the end`);
  assert.strictEqual(R.spanAt(root, true, v), null, `${where}: past the visible end`);
  // Every node within its bounds, its measures its kids'.
  const walk = (node, top) => {
    assert.ok(node.kids.length <= R.MAX, `${where}: a node within MAX`);
    assert.ok(top || node.kids.length > 0, `${where}: no empty node below the root`);
    let ns = 0;
    let nv = 0;
    for (const kid of node.kids) {
      if (node.leaf) {
        ns += kid.len;
        nv += kid.vis ? kid.len : 0;
      } else {
        walk(kid, false);
        ns += kid.s;
        nv += kid.v;
      }
    }
    assert.deepStrictEqual([node.s, node.v], [ns, nv], `${where}: a node's measures`);
  };
  walk(root, true);
};

// The places and neighbours through the hints (a head) or a walk of its own (frozen).
const checkPlaces = (holder, spans, where, neighbours = true) => {
  let s = 0;
  let v = 0;
  for (let i = 0; i < spans.length; i++) {
    const it = spans[i];
    const at = R.positionOf(holder, it);
    assert.deepStrictEqual([at.s, at.v], [s, v], `${where}: positionOf ${i}`);
    if (neighbours) {
      assert.strictEqual(R.before(holder, it), i > 0 ? spans[i - 1] : null, `${where}: before ${i}`);
      assert.strictEqual(R.after(holder, it), i + 1 < spans.length ? spans[i + 1] : null, `${where}: after ${i}`);
    }
    s += it.len;
    v += it.vis ? it.len : 0;
  }
};

test('the copy-on-write rope with two measures', async (t) => {
  await t.test('fromSpans, locate, find, the walk and the text agree with the array, at every size', () => {
    for (const n of [0, 1, 2, 31, 32, 33, 64, 65, 1000, 1057]) {
      const spans = Array.from({ length: n }, (_, i) => span(i % 3 === 0 ? 0 : 1 + (i % 5), i % 4 !== 1));
      const holder = holderOf(R.fromSpans(spans, owners + 1));
      check(holder.root, spans, `n=${n}`);
      checkPlaces(holder, spans, `n=${n}`);
    }
  });

  await t.test('an op copies the path once, versions stay as they were, the head answers the hints (seeded)', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const random = rng(seed);
      let spans = Array.from({ length: 1 + pick(random, 80) }, (_, i) => span(1 + (i % 4), random() < 0.8));
      let holder = holderOf(R.fromSpans(spans, owners + 1));
      const versions = [[holder, spans]];
      for (let step = 0; step < 120; step++) {
        // The version before is handed on: frozen, the op writes under an owner of its own.
        holder.frozen = true;
        holder = holderOf(holder.root);
        // An op makes one to three edits.
        const edits = 1 + pick(random, 3);
        for (let e = 0; e < edits; e++) {
          const roll = random();
          const fresh = Array.from({ length: 1 + pick(random, roll < 0.1 ? 70 : 3) }, (_, i) =>
            span(i === 0 && random() < 0.3 ? 0 : 1 + pick(random, 6), random() < 0.8),
          );
          if (spans.length === 0) {
            holder.root = R.fromSpans(fresh, holder.owner);
            spans = fresh;
            continue;
          }
          const i = pick(random, spans.length);
          if (roll < 0.35) {
            R.insertBefore(holder, spans[i], fresh);
            spans = [...spans.slice(0, i), ...fresh, ...spans.slice(i)];
          } else if (roll < 0.7) {
            R.insertAfter(holder, spans[i], fresh);
            spans = [...spans.slice(0, i + 1), ...fresh, ...spans.slice(i + 1)];
          } else {
            const replacement = random() < 0.3 ? [] : fresh;
            R.replace(holder, spans[i], replacement);
            spans = [...spans.slice(0, i), ...replacement, ...spans.slice(i + 1)];
          }
        }
        if (step % 5 === 0) check(holder.root, spans, `seed ${seed} step ${step}`);
        checkPlaces(holder, spans, `seed ${seed} step ${step} head`, step % 3 === 0);
        versions.push([holder, spans]);
      }
      // Every older version reads as it was: from the root down, and its places from a walk of its own.
      for (const [i, [old, was]] of versions.entries()) {
        if (i % 4 === 0) check(old.root, was, `seed ${seed} version ${i}`);
        else same(R.spansOf(old.root), was, `seed ${seed} version ${i}: walk`);
        if (old.frozen) checkPlaces(old, was, `seed ${seed} version ${i} frozen`, false);
      }
      // Emptied span by span: no leaf left empty for a walk to land on.
      holder.frozen = true;
      holder = holderOf(holder.root);
      let left = spans;
      while (left.length > 0) {
        const i = pick(random, left.length);
        R.replace(holder, left[i], []);
        left = [...left.slice(0, i), ...left.slice(i + 1)];
        if (left.length % 7 === 0) check(holder.root, left, `seed ${seed} emptied to ${left.length}`);
      }
      assert.strictEqual(R.first(holder.root), null, `seed ${seed} empty`);
      check(versions[versions.length - 1][0].root, spans, `seed ${seed} before emptying`);
    }
  });

  await t.test('the tree stays shallow, every level within MAX', () => {
    const spans = [span(1, true)];
    const holder = holderOf(R.fromSpans(spans, owners + 1));
    for (let i = 1; i < 20_000; i++) {
      const fresh = span(1, i % 7 !== 0);
      R.insertAfter(holder, spans[spans.length - 1], [fresh]);
      spans.push(fresh);
    }
    assert.ok(R.shapeOf(holder.root) <= 4, `depth ${R.shapeOf(holder.root)}`);
    check(holder.root, spans, 'appended');
  });

  await t.test('a write copies a node once per owner; a version handed on never changes', () => {
    const spans = Array.from({ length: 5000 }, () => span(1, true));
    const first = holderOf(R.fromSpans(spans, owners + 1));
    first.frozen = true;
    const second = holderOf(first.root);
    R.insertAfter(second, spans[100], [span(2, true)]);
    const once = second.root;
    // The same owner writes its own nodes in place: the root stays.
    R.insertAfter(second, spans[101], [span(2, true)]);
    assert.strictEqual(second.root, once);
    assert.notStrictEqual(second.root, first.root);
    check(first.root, spans, 'the first version');
    assert.strictEqual(first.root.s, 5000);
    assert.strictEqual(second.root.s, 5004);
  });

  await t.test('a fork of an older version sets its hints once; a frozen one never writes a hint', () => {
    const spans = Array.from({ length: 300 }, (_, i) => span(1 + (i % 3), i % 5 !== 0));
    const older = holderOf(R.fromSpans(spans, owners + 1));
    older.frozen = true;
    const head = holderOf(older.root);
    const added = [span(2, true), span(1, false)];
    R.insertAfter(head, spans[50], added);
    const headSpans = [...spans.slice(0, 51), ...added, ...spans.slice(51)];
    checkPlaces(head, headSpans, 'head');
    // The frozen version asked a place reads it from a walk of its own, once, writing no hint.
    const was = R.stats();
    checkPlaces(older, spans, 'frozen', false);
    assert.strictEqual(R.stats().rehints, was.rehints, 'no hint written');
    assert.strictEqual(R.stats().walks, was.walks + 1, 'one walk');
    checkPlaces(head, headSpans, 'head after the frozen read');
    assert.strictEqual(R.stats().rehints, was.rehints, 'the head trusts its hints');
    // A fork of the older version: its hints are the head's, set again once.
    head.frozen = true;
    const fork = holderOf(older.root);
    const fresh = span(3, true);
    R.insertBefore(fork, spans[10], [fresh]);
    assert.strictEqual(R.stats().rehints, was.rehints + 1, 'one re-hint for the fork');
    check(fork.root, [...spans.slice(0, 10), fresh, ...spans.slice(10)], 'fork');
    check(head.root, headSpans, 'head after the fork');
    checkPlaces(head, headSpans, 'the head, frozen, from a walk', false);
  });
});

test('the id index', async (t) => {
  // The sorted array of [key, value] an index stands for.
  const checkIndex = (root, sorted, where) => {
    assert.strictEqual(I.sizeOf(root), sorted.length, `${where}: size`);
    const cursor = I.seek(root, -Infinity);
    for (let i = 0; i < sorted.length; i++) {
      assert.strictEqual(cursor.key, sorted[i][0], `${where}: walk ${i}`);
      assert.strictEqual(cursor.value, sorted[i][1], `${where}: walk value ${i}`);
      assert.strictEqual(I.next(cursor), i + 1 < sorted.length, `${where}: next ${i}`);
    }
    assert.strictEqual(cursor.value, undefined, `${where}: spent`);
    for (let i = 0; i < sorted.length; i += 1 + (i % 3)) {
      const [key, value] = sorted[i];
      assert.strictEqual(I.get(root, key), value, `${where}: get ${key}`);
      assert.strictEqual(I.get(root, key + 0.5), undefined, `${where}: get ${key + 0.5}`);
      assert.strictEqual(I.floor(root, key), value, `${where}: floor ${key}`);
      assert.strictEqual(I.floor(root, key + 0.5), value, `${where}: floor ${key + 0.5}`);
      const below = I.floor(root, key - 0.5);
      assert.strictEqual(below, i > 0 ? sorted[i - 1][1] : undefined, `${where}: floor below ${key}`);
      const from = I.seek(root, key - 0.5);
      assert.strictEqual(from.value, value, `${where}: seek ${key - 0.5}`);
    }
    if (sorted.length > 0) {
      assert.strictEqual(I.seek(root, sorted[sorted.length - 1][0] + 1).value, undefined, `${where}: seek past`);
    }
  };

  await t.test('set, remove, get, floor and a walk agree with a sorted array; versions keep theirs (seeded)', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const random = rng(seed);
      let root = I.EMPTY;
      const mirror = new Map();
      const versions = [];
      for (let step = 0; step < 2500; step++) {
        const owner = ++owners;
        // An op writes one to four keys under its own owner.
        for (let k = 1 + pick(random, 4); k > 0; k--) {
          const key = pick(random, 3000) * 2;
          if (random() < 0.3 && mirror.size > 0) {
            root = I.remove(root, key, owner);
            mirror.delete(key);
          } else {
            const value = { step };
            root = I.set(root, key, value, owner);
            assert.strictEqual(I.wasAdded(), !mirror.has(key), `seed ${seed} step ${step}: added`);
            mirror.set(key, value);
          }
        }
        if (step % 250 === 0) {
          const sorted = [...mirror].sort((a, b) => a[0] - b[0]);
          checkIndex(root, sorted, `seed ${seed} step ${step}`);
          versions.push([root, sorted]);
        }
      }
      for (const [i, [old, was]] of versions.entries()) checkIndex(old, was, `seed ${seed} version ${i}`);
      // Emptied key by key.
      const owner = ++owners;
      for (const key of [...mirror.keys()]) root = I.remove(root, key, owner);
      checkIndex(root, [], `seed ${seed} emptied`);
    }
  });

  await t.test('built bottom-up from sorted keys, at every size', () => {
    for (const n of [0, 1, 31, 32, 33, 1024, 1025, 40_000]) {
      const sorted = Array.from({ length: n }, (_, i) => [i * 3 + 1, { i }]);
      const root = I.fromSorted(
        sorted.map((p) => p[0]),
        sorted.map((p) => p[1]),
        ++owners,
      );
      checkIndex(root, sorted, `n=${n}`);
      if (n <= 3000) continue;
      assert.strictEqual(I.sizeOf(root), n);
      // A write after the build, under another owner, leaves the built one as it was.
      const later = I.set(root, 2, 'two', ++owners);
      assert.strictEqual(I.get(later, 2), 'two');
      assert.strictEqual(I.get(root, 2), undefined);
      assert.strictEqual(I.floor(root, 2), sorted[0][1]);
    }
  });
});

test('the copy-on-write hash trie', async (t) => {
  await t.test('get, set, remove and pairs agree with a Map; versions keep their keys (seeded)', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const random = rng(seed);
      let map = C.EMPTY;
      const mirror = new Map();
      const versions = [];
      for (let step = 0; step < 3000; step++) {
        const owner = ++owners;
        const key = random() < 0.5 ? `${pick(random, 900)}:${['A', 'B', 'C'][pick(random, 3)]}` : pick(random, 900);
        if (random() < 0.2) {
          map = C.remove(map, key, owner);
          mirror.delete(key);
        } else {
          const value = { step };
          map = C.set(map, key, value, owner);
          if (random() < 0.3) map = C.set(map, key, value, owner);
          mirror.set(key, value);
        }
        if (step % 500 === 0) versions.push([map, new Map(mirror)]);
      }
      assert.strictEqual(map.size, mirror.size);
      for (const [key, value] of mirror) assert.strictEqual(C.get(map, key), value, String(key));
      assert.strictEqual(C.get(map, 'nope'), undefined);
      assert.strictEqual(C.has(map, 'nope'), false);
      const seen = new Map();
      for (const pair of C.pairs(map)) seen.set(pair.key, pair.value);
      assert.deepStrictEqual(seen, mirror);
      for (const [old, was] of versions) {
        assert.strictEqual(old.size, was.size);
        for (const [key, value] of was) assert.strictEqual(C.get(old, key), value, `old ${key}`);
      }
    }
  });

  await t.test('a map of strings walks its keys by their hashes, five bits at a time, the lowest first', () => {
    let map = C.EMPTY;
    const keys = [];
    for (let i = 0; i < 5000; i++) keys.push(`${i * 7}:${['A', 'Bee', 'c:d'][i % 3]}`);
    for (const key of keys) map = C.set(map, key, key.length, ++owners);
    // The order the trie walks: the five-bit chunks of the hash, lowest first, then the key.
    const chunks = (key) => {
      const h = C.fnv(key);
      return [h & 31, C.walkOrderOf(h)];
    };
    const order = [...keys].sort((a, b) => {
      const [x0, x1] = chunks(a);
      const [y0, y1] = chunks(b);
      return x0 - y0 || x1 - y1 || (a < b ? -1 : a > b ? 1 : 0);
    });
    same(
      C.pairs(map).map((p) => p.key),
      order,
      'walk order',
    );
  });

  await t.test('colliding hashes share a bucket and still tell the keys apart', () => {
    const seen = new Map();
    let a = null;
    let b = null;
    for (let i = 0; a === null; i++) {
      const key = `c${i}`;
      const hash = C.hashOf(key);
      const other = seen.get(hash);
      if (other === undefined) seen.set(hash, key);
      else [a, b] = [other, key];
    }
    let map = C.set(C.set(C.EMPTY, a, 1, ++owners), b, 2, ++owners);
    assert.strictEqual(map.size, 2);
    assert.strictEqual(C.get(map, a), 1);
    assert.strictEqual(C.get(map, b), 2);
    assert.deepStrictEqual(
      C.pairs(map).map((p) => p.key),
      [a, b].sort(),
      'a bucket walks by key',
    );
    // A third key in the bucket, set and removed under one owner, in place.
    const third = C.set(map, `${a}\u0000`, 0, ++owners);
    assert.strictEqual(C.get(third, a), 1);
    const older = map;
    map = C.set(map, a, 3, ++owners);
    assert.strictEqual(map.size, 2, 'a key set again is not a new key');
    assert.strictEqual(C.get(older, a), 1, 'the older version keeps its value');
    map = C.remove(map, b, ++owners);
    assert.strictEqual(map.size, 1);
    assert.strictEqual(C.get(map, b), undefined);
    assert.strictEqual(C.get(older, b), 2);
    map = C.remove(map, a, ++owners);
    assert.strictEqual(map.size, 0);
    assert.deepStrictEqual(C.pairs(map), []);
    assert.strictEqual(C.remove(map, a, ++owners), map, 'nothing to remove');
  });

  await t.test('an owner writes its own map in place', () => {
    const owner = ++owners;
    const map = C.set(C.EMPTY, 'a', 1, owner);
    assert.strictEqual(C.set(map, 'b', 2, owner), map);
    assert.strictEqual(C.remove(map, 'a', owner), map);
    assert.strictEqual(map.size, 1);
    const other = C.set(map, 'c', 3, ++owners);
    assert.notStrictEqual(other, map);
    assert.strictEqual(map.size, 1);
    assert.strictEqual(other.size, 2);
  });
});

test('the chunked sorted list', async (t) => {
  const entry = (off) => ({ off, id: made++ });
  const check = (list, entries, where) => {
    assert.strictEqual(list.size, entries.length, `${where}: size`);
    same(C.entriesOf(list), entries, `${where}: entries`);
    assert.strictEqual(C.last(list), entries[entries.length - 1], `${where}: last`);
    for (const chunk of list.chunks) assert.ok(chunk.length > 0 && chunk.length <= C.CHUNK, `${where}: chunk sizes`);
    assert.strictEqual(
      C.floorEntry(list, entries.length === 0 ? 0 : entries[0].off - 1),
      null,
      `${where}: before the first`,
    );
    const predecessor = (key) => {
      let at = null;
      for (const held of entries) if (held.off <= key) at = held;
      return at;
    };
    for (let i = 0; i < entries.length; i++) {
      const { off } = entries[i];
      const found = C.floorEntry(list, off);
      assert.strictEqual(found.entry, entries[i], `${where}: find ${off}`);
      assert.strictEqual(list.chunks[found.c][found.i], found.entry, `${where}: position of ${off}`);
      assert.strictEqual(C.at(list, off), entries[i], `${where}: at ${off}`);
      for (const key of [off + 0.25, off - 0.25]) {
        const expected = predecessor(key);
        assert.strictEqual(C.floorEntry(list, key)?.entry ?? null, expected, `${where}: find ${key}`);
        assert.strictEqual(C.at(list, key), expected?.off === key ? expected : undefined, `${where}: at ${key}`);
      }
    }
  };

  await t.test('listOf, find, at and the entries agree with the array, at every size', () => {
    for (const n of [0, 1, 2, 63, 64, 65, 200, 1000]) {
      const entries = Array.from({ length: n }, (_, i) => entry(i * 3));
      check(C.listOf(entries), entries, `n=${n}`);
    }
  });

  await t.test('splice copies one chunk, splits it when it overflows, drops it when emptied (seeded)', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const random = rng(seed);
      let entries = [];
      let list = C.EMPTY_LIST;
      const versions = [];
      for (let step = 0; step < 240; step++) {
        const roll = random();
        if (roll < 0.6 || entries.length === 0) {
          const i = entries.length === 0 ? -1 : pick(random, entries.length + 1) - 1;
          const low = i < 0 ? (entries[0]?.off ?? 0) - 2 : entries[i].off;
          const high = i + 1 < entries.length ? entries[i + 1].off : low + 2;
          if (high - low < 2 ** -30) continue;
          const fresh = [entry((low + high) / 2)];
          if (random() < 0.1) {
            for (let k = 0; k < 12; k++) fresh.push(entry(fresh[0].off + (high - low) / 2 ** (k + 3)));
          }
          fresh.sort((x, y) => x.off - y.off);
          if (i < 0) list = C.splice(list, 0, 0, 0, fresh);
          else {
            const found = C.floorEntry(list, entries[i].off);
            list = C.splice(list, found.c, found.i + 1, 0, fresh);
          }
          entries = [...entries.slice(0, i + 1), ...fresh, ...entries.slice(i + 1)];
        } else {
          const i = pick(random, entries.length);
          const count = i + 1 < entries.length && random() < 0.5 ? 2 : 1;
          const found = C.floorEntry(list, entries[i].off);
          const pieces = [];
          if (random() < 0.7) pieces.push({ ...entries[i], id: made++ });
          if (count === 2 && random() < 0.5) pieces.push({ ...entries[i + 1], id: made++ });
          list = C.splice(list, found.c, found.i, count, pieces);
          entries = [...entries.slice(0, i), ...pieces, ...entries.slice(i + count)];
        }
        check(list, entries, `seed ${seed} step ${step}`);
        versions.push([list, entries]);
      }
      for (const [i, [old, was]] of versions.entries()) check(old, was, `seed ${seed} version ${i}`);
    }
  });
});
