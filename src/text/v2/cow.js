'use strict';

// Copy-on-write maps and lists of the v2 sequence engine. Every node carries
// the OWNER that made it — an integer, the op writing: a writer changes a node of
// its own in place and copies any other first, so a version handed out never changes and an op copies
// each node it touches once, however often it writes there. Owner 0 is nobody's: what it marks is
// copied by every writer. No requires.
//
// - A hash array mapped trie (`get`, `set`, `remove`, `pairs`) over string or integer keys: 32-way
//   bitmap nodes over 5 bits of a 32-bit hash at a time, keys that share 30 bits in a bucket at the
//   bottom sorted by key. A string's hash is FNV-1a over its UTF-16 units and the shape the same as the
//   v1 engine's map — so `pairs` walks a map of strings in the order that map walked its keys, the order
//   a block's registers and marks serialize in. An integer is its own hash. A removal leaves the nodes
//   above as they are: a map that took keys away walks in an order of its history (what waits only).
// - A sorted list in chunks (`List`): entries with a numeric `off`, ascending, in chunks of at most
//   CHUNK; a change copies the chunk it lands in and the list of chunks, O(√n), the rest shared.

const BITS = 5;
const MASK = 31;
// 32 bits of hash, 5 at a time: past the sixth level the keys collide.
const DEPTH = 6;

/** FNV-1a over the UTF-16 units of a string: cheap, and the keys here are short. */
const fnv = (key) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};
const hashOf = (key) => (typeof key === 'string' ? fnv(key) : key >>> 0);

const popcount = (x) => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
};

// A key and its value, never changed once made: a set makes another.
class Pair {
  constructor(key, value, hash) {
    this.key = key;
    this.value = value;
    this.hash = hash;
  }
}
// A node: a slot per set bit of `bitmap`, each a Pair or a node below.
class Branch {
  constructor(bitmap, slots, owner) {
    this.bitmap = bitmap;
    this.slots = slots;
    this.owner = owner;
  }
}
// The keys that share every bit the trie reads, sorted by key.
class Bucket {
  constructor(pairs, owner) {
    this.pairs = pairs;
    this.owner = owner;
  }
}
class HMap {
  constructor(root, size, owner) {
    this.root = root;
    this.size = size;
    this.owner = owner;
  }
}

const EMPTY_BRANCH = new Branch(0, [], 0);
/** The empty map. */
const EMPTY = new HMap(EMPTY_BRANCH, 0, 0);

/** The value under `key`, or undefined. */
const get = (map, key) => {
  const hash = hashOf(key);
  let node = map.root;
  for (let depth = 0; ; depth++) {
    if (node instanceof Bucket) {
      const { pairs } = node;
      for (let i = 0; i < pairs.length; i++) if (pairs[i].key === key) return pairs[i].value;
      return undefined;
    }
    const bit = 1 << ((hash >>> (depth * BITS)) & MASK);
    if ((node.bitmap & bit) === 0) return undefined;
    const slot = node.slots[popcount(node.bitmap & (bit - 1))];
    if (slot instanceof Pair) return slot.key === key ? slot.value : undefined;
    node = slot;
  }
};

/** Whether the map holds `key`. */
const has = (map, key) => get(map, key) !== undefined;

// Two pairs under one node at `depth`: split until their hashes part.
const merge = (a, b, depth, owner) => {
  if (depth >= DEPTH) return new Bucket(a.key < b.key ? [a, b] : [b, a], owner);
  const ia = (a.hash >>> (depth * BITS)) & MASK;
  const ib = (b.hash >>> (depth * BITS)) & MASK;
  if (ia === ib) return new Branch(1 << ia, [merge(a, b, depth + 1, owner)], owner);
  return new Branch((1 << ia) | (1 << ib), ia < ib ? [a, b] : [b, a], owner);
};

// Whether the last write added a key, or took one (a write never re-enters).
let grown = 0;

const insertAt = (list, at, item) => {
  list.push(item);
  for (let i = list.length - 1; i > at; i--) list[i] = list[i - 1];
  list[at] = item;
};
const removeAt = (list, at) => {
  for (let i = at; i < list.length - 1; i++) list[i] = list[i + 1];
  list.pop();
};

const setIn = (node, pair, depth, owner) => {
  const mine = owner !== 0 && node.owner === owner;
  if (node instanceof Bucket) {
    const pairs = mine ? node.pairs : node.pairs.slice();
    let i = 0;
    while (i < pairs.length && pairs[i].key < pair.key) i++;
    if (i < pairs.length && pairs[i].key === pair.key) pairs[i] = pair;
    else {
      insertAt(pairs, i, pair);
      grown = 1;
    }
    return mine ? node : new Bucket(pairs, owner);
  }
  const bit = 1 << ((pair.hash >>> (depth * BITS)) & MASK);
  const index = popcount(node.bitmap & (bit - 1));
  const slots = mine ? node.slots : node.slots.slice();
  let { bitmap } = node;
  if ((bitmap & bit) === 0) {
    insertAt(slots, index, pair);
    bitmap |= bit;
    grown = 1;
  } else {
    const slot = slots[index];
    if (!(slot instanceof Pair)) slots[index] = setIn(slot, pair, depth + 1, owner);
    else if (slot.key === pair.key) slots[index] = pair;
    else {
      slots[index] = merge(slot, pair, depth + 1, owner);
      grown = 1;
    }
  }
  if (!mine) return new Branch(bitmap, slots, owner);
  node.bitmap = bitmap;
  return node;
};

/**
 * The map with `key` set to `value`: the map itself, changed, when it is `owner`'s; else a new map, the
 * one given untouched.
 */
const set = (map, key, value, owner) => {
  grown = 0;
  const root = setIn(map.root, new Pair(key, value, hashOf(key)), 0, owner);
  if (owner !== 0 && map.owner === owner) {
    map.root = root;
    map.size += grown;
    return map;
  }
  return new HMap(root, map.size + grown, owner);
};

// A node without `key` (`hash`), or null when nothing is left in it.
const removeIn = (node, key, hash, depth, owner) => {
  const mine = owner !== 0 && node.owner === owner;
  if (node instanceof Bucket) {
    let i = 0;
    while (i < node.pairs.length && node.pairs[i].key !== key) i++;
    if (i === node.pairs.length) return node;
    grown = -1;
    if (node.pairs.length === 1) return null;
    const pairs = mine ? node.pairs : node.pairs.slice();
    removeAt(pairs, i);
    return mine ? node : new Bucket(pairs, owner);
  }
  const bit = 1 << ((hash >>> (depth * BITS)) & MASK);
  if ((node.bitmap & bit) === 0) return node;
  const index = popcount(node.bitmap & (bit - 1));
  const slot = node.slots[index];
  let next;
  if (slot instanceof Pair) {
    if (slot.key !== key) return node;
    grown = -1;
    next = null;
  } else {
    next = removeIn(slot, key, hash, depth + 1, owner);
    if (next === slot) return node;
  }
  const slots = mine ? node.slots : node.slots.slice();
  let { bitmap } = node;
  if (next === null) {
    removeAt(slots, index);
    bitmap &= ~bit;
    if (slots.length === 0 && depth > 0) return null;
  } else slots[index] = next;
  if (!mine) return new Branch(bitmap, slots, owner);
  node.bitmap = bitmap;
  return node;
};

/** The map without `key` — the map itself when it holds no such key, or when it is `owner`'s. */
const remove = (map, key, owner) => {
  grown = 0;
  const root = removeIn(map.root, key, hashOf(key), 0, owner);
  if (grown === 0) return map;
  if (owner !== 0 && map.owner === owner) {
    map.root = root;
    map.size--;
    return map;
  }
  return new HMap(root, map.size - 1, owner);
};

/** Every Pair (`key`, `value`) of the map, in the order its trie walks them. */
const pairs = (map) => {
  const out = [];
  if (map.size === 0) return out;
  const stack = [map.root];
  const at = [0];
  while (stack.length > 0) {
    const top = stack.length - 1;
    const node = stack[top];
    if (node instanceof Bucket) {
      for (let i = 0; i < node.pairs.length; i++) out.push(node.pairs[i]);
      stack.pop();
      at.pop();
      continue;
    }
    const i = at[top];
    if (i >= node.slots.length) {
      stack.pop();
      at.pop();
      continue;
    }
    at[top] = i + 1;
    const slot = node.slots[i];
    if (slot instanceof Pair) out.push(slot);
    else {
      stack.push(slot);
      at.push(0);
    }
  }
  return out;
};

/**
 * Where a string key falls in the walk of a trie of strings below its first five bits: the next 25
 * bits of its hash, five at a time, the first the highest — the order the keys of one child of the root
 * walk in (keys equal there walk by key). What a block's pieces are serialized in (src/entries.js).
 */
const walkOrderOf = (hash) => {
  let out = 0;
  for (let depth = 1; depth < DEPTH; depth++) out = out * 32 + ((hash >>> (depth * BITS)) & MASK);
  return out;
};

// ---- the sorted list in chunks ---------------------------------------------------------------------

const CHUNK = 64;

class List {
  constructor(chunks, size) {
    this.chunks = chunks;
    this.size = size;
  }
}
/** The empty list. */
const EMPTY_LIST = new List([], 0);

/** A list of `entries`, already ascending by `off`. */
const listOf = (entries) => {
  if (entries.length === 0) return EMPTY_LIST;
  const chunks = [];
  for (let i = 0; i < entries.length; i += CHUNK) chunks.push(entries.slice(i, i + CHUNK));
  return new List(chunks, entries.length);
};

/** The entries in order, as one array. */
const entriesOf = (list) => {
  const out = [];
  for (let c = 0; c < list.chunks.length; c++) {
    const chunk = list.chunks[c];
    for (let i = 0; i < chunk.length; i++) out.push(chunk[i]);
  }
  return out;
};

/** The last entry, or undefined. */
const last = (list) => {
  if (list.size === 0) return undefined;
  const chunk = list.chunks[list.chunks.length - 1];
  return chunk[chunk.length - 1];
};

// Where `floorEntry` found an entry: its chunk and its place in it (one per call: read at once).
class Found {
  constructor() {
    this.c = 0;
    this.i = 0;
    this.entry = null;
  }
}
const FOUND = new Found();

/**
 * The last entry whose `off` is at or before `key` — `FOUND` with its chunk and place — or null when
 * every entry is past `key`, or none is held. The answer is read before the next call.
 */
const floorEntry = (list, key) => {
  const { chunks } = list;
  if (chunks.length === 0 || chunks[0][0].off > key) return null;
  let lo = 0;
  let hi = chunks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (chunks[mid][0].off <= key) lo = mid;
    else hi = mid - 1;
  }
  const chunk = chunks[lo];
  let a = 0;
  let b = chunk.length - 1;
  while (a < b) {
    const mid = (a + b + 1) >> 1;
    if (chunk[mid].off <= key) a = mid;
    else b = mid - 1;
  }
  FOUND.c = lo;
  FOUND.i = a;
  FOUND.entry = chunk[a];
  return FOUND;
};

/** The entry whose `off` is `key`, or undefined. */
const at = (list, key) => {
  const found = floorEntry(list, key);
  return found !== null && found.entry.off === key ? found.entry : undefined;
};

// `held` as chunks of at most CHUNK, as even as they come.
const chunked = (held, out) => {
  if (held.length === 0) return;
  if (held.length <= CHUNK) {
    out.push(held);
    return;
  }
  const count = Math.ceil(held.length / CHUNK);
  const size = Math.ceil(held.length / count);
  for (let k = 0; k < held.length; k += size) out.push(held.slice(k, k + size));
};

/**
 * The list with `remove` entries from position (`c`, `i`) replaced by `entries` (keeping it ascending):
 * the chunks touched copied into one — split when it overflows, dropped when nothing is left — the rest
 * shared. An empty list takes (0, 0).
 */
const splice = (list, c, i, remove, entries) => {
  const { chunks } = list;
  if (chunks.length === 0) {
    const out = [];
    chunked(entries.slice(), out);
    return new List(out, entries.length);
  }
  let k = c;
  let j = i;
  let left = remove;
  while (left > 0 && k < chunks.length) {
    const available = chunks[k].length - j;
    if (left < available) {
      j += left;
      left = 0;
    } else {
      left -= available;
      k++;
      j = 0;
    }
  }
  const held = chunks[c].slice(0, i);
  for (let e = 0; e < entries.length; e++) held.push(entries[e]);
  const end = Math.min(k, chunks.length - 1);
  if (k < chunks.length) for (let m = j; m < chunks[k].length; m++) held.push(chunks[k][m]);
  const out = chunks.slice(0, c);
  chunked(held, out);
  for (let m = end + 1; m < chunks.length; m++) out.push(chunks[m]);
  return new List(out, list.size - (remove - left) + entries.length);
};

module.exports = {
  fnv,
  hashOf,
  Pair,
  EMPTY,
  get,
  has,
  set,
  remove,
  pairs,
  walkOrderOf,
  CHUNK,
  List,
  EMPTY_LIST,
  listOf,
  entriesOf,
  last,
  floorEntry,
  at,
  splice,
};
