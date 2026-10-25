'use strict';

// A persistent map from string keys to values — the run records of a
// sequence block (./sequence.js), one of which changes per keystroke while
// thousands stay. A hash array mapped trie: 32-way bitmap nodes over the
// bits of a 32-bit hash, path-copied on write, so a `set` allocates O(1)
// nodes and every older version reads as it was. Keys that share a hash
// sit in one bucket at the bottom. No requires.

const BITS = 5;
const MASK = 31;
// 32 bits of hash, 5 at a time: beyond the sixth level the keys collide.
const DEPTH = 6;

// FNV-1a over the UTF-16 units: cheap, and the keys here are short.
const hashOf = (key) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

const popcount = (x) => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
};

// A node: `{ bitmap, slots, owner }` — a slot is `[key, value]` or a node; a
// bucket at the bottom is `{ pairs: [[key, value]...] }` (a node with all
// 32 children has a bitmap of -1, so the bucket is told by its shape).
// `owner` names the build a node was made in (null once shared): a build
// writes its own nodes in place and copies every other, so `fromEntries`
// allocates each node once instead of a path per key.
const EMPTY_NODE = Object.freeze({ bitmap: 0, slots: Object.freeze([]), owner: null });

const isNode = (slot) => !Array.isArray(slot);

const get = (node, key, hash, depth) => {
  for (;;) {
    if (node.pairs !== undefined) {
      for (const pair of node.pairs) if (pair[0] === key) return pair[1];
      return undefined;
    }
    const bit = 1 << ((hash >>> (depth * BITS)) & MASK);
    if ((node.bitmap & bit) === 0) return undefined;
    const slot = node.slots[popcount(node.bitmap & (bit - 1))];
    if (!isNode(slot)) return slot[0] === key ? slot[1] : undefined;
    node = slot;
    depth++;
  }
};

// Two pairs under one node at `depth`: split until their hashes part.
const merge = (a, hashA, b, hashB, depth, owner) => {
  if (depth >= DEPTH) return { pairs: [a, b], owner };
  const ia = (hashA >>> (depth * BITS)) & MASK;
  const ib = (hashB >>> (depth * BITS)) & MASK;
  if (ia === ib) return { bitmap: 1 << ia, slots: [merge(a, hashA, b, hashB, depth + 1, owner)], owner };
  const bitmap = (1 << ia) | (1 << ib);
  return { bitmap, slots: ia < ib ? [a, b] : [b, a], owner };
};

// The node with the `pair` (`[key, value]`, kept as given) set; `added.n`
// tells a new key from a replaced one. A node of `owner` (a build's own)
// changes in place.
const set = (node, pair, hash, depth, added, owner) => {
  const key = pair[0];
  const own = owner !== null && node.owner === owner;
  if (node.pairs !== undefined) {
    const pairs = own ? node.pairs : node.pairs.slice();
    const i = pairs.findIndex((held) => held[0] === key);
    if (i === -1) {
      pairs.push(pair);
      added.n = 1;
    } else pairs[i] = pair;
    return own ? node : { pairs, owner };
  }
  const bit = 1 << ((hash >>> (depth * BITS)) & MASK);
  const index = popcount(node.bitmap & (bit - 1));
  const slots = own ? node.slots : node.slots.slice();
  if ((node.bitmap & bit) === 0) {
    slots.splice(index, 0, pair);
    added.n = 1;
    if (own) {
      node.bitmap |= bit;
      return node;
    }
    return { bitmap: node.bitmap | bit, slots, owner };
  }
  const slot = slots[index];
  if (isNode(slot)) slots[index] = set(slot, pair, hash, depth + 1, added, owner);
  else if (slot[0] === key) slots[index] = pair;
  else {
    slots[index] = merge(slot, hashOf(slot[0]), pair, hash, depth + 1, owner);
    added.n = 1;
  }
  return own ? node : { bitmap: node.bitmap, slots, owner };
};

function* pairsOf(node) {
  if (node.pairs !== undefined) {
    yield* node.pairs;
    return;
  }
  for (const slot of node.slots) {
    if (isNode(slot)) yield* pairsOf(slot);
    else yield slot;
  }
}

/** The empty map. */
const EMPTY = Object.freeze({ root: EMPTY_NODE, size: 0 });

/** The value under `key`, or undefined. */
const getOf = (map, key) => get(map.root, key, hashOf(key), 0);

// Whether the last `set` added a key (a set never re-enters).
const added = { n: 0 };

/** The map with `key` set to `value`: a new map, the old one untouched. */
const setOf = (map, key, value) => {
  added.n = 0;
  const root = set(map.root, [key, value], hashOf(key), 0, added, null);
  return { root, size: map.size + added.n };
};

/** Every `[key, value]`, in no order. */
const entriesOf = (map) => pairsOf(map.root);

/** A map of `entries` (`[key, value]` pairs, kept as given — a Map's entries are fresh). */
const fromEntries = (entries) => {
  const owner = {};
  let root = EMPTY_NODE;
  let size = 0;
  for (const pair of entries) {
    added.n = 0;
    root = set(root, pair, hashOf(pair[0]), 0, added, owner);
    size += added.n;
  }
  return { root, size };
};

module.exports = { EMPTY, hashOf, get: getOf, set: setOf, entries: entriesOf, fromEntries };
