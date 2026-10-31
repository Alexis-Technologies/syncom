'use strict';

// The id index of the v2 sequence engine: a copy-on-write B+-tree from a
// number to a value, ordered by the number — a run's record and its spans keyed by (run, offset) as one
// number, so the span holding an offset is a floor search and a run's spans read in offset order (the
// idea of json-joy's second tree, by id beside the one by position; no code of it). Every node carries
// the OWNER that made it, as in ./cow.js: a write changes the owner's nodes in place and copies any
// other on the way down, so a version handed out never changes and an op copies each node once.
// Searched from the root down, never up: no node knows its parent. No requires.

const MAX = 32;

// A node: `keys` ascending; a leaf's `kids` the values under them, an inner node's its children, each
// under the least key it holds.
class IdNode {
  constructor(leaf, keys, kids, owner) {
    this.leaf = leaf;
    this.keys = keys;
    this.kids = kids;
    this.owner = owner;
  }
}

/** The empty index. */
const EMPTY = new IdNode(true, [], [], 0);

// The last position whose key is at or below `key`, -1 when none is.
const floorAt = (keys, key) => {
  let lo = 0;
  let hi = keys.length - 1;
  if (hi < 0 || keys[0] > key) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (keys[mid] <= key) lo = mid;
    else hi = mid - 1;
  }
  return lo;
};

/** The value under `key`, or undefined. */
const get = (root, key) => {
  let node = root;
  for (;;) {
    const i = floorAt(node.keys, key);
    if (i === -1) return undefined;
    if (node.leaf) return node.keys[i] === key ? node.kids[i] : undefined;
    node = node.kids[i];
  }
};

/** The value under the greatest key at or below `key`, or undefined. */
const floor = (root, key) => {
  let node = root;
  for (;;) {
    const i = floorAt(node.keys, key);
    if (i === -1) return undefined;
    if (node.leaf) return node.kids[i];
    node = node.kids[i];
  }
};

const writable = (node, owner) =>
  node.owner === owner && owner !== 0 ? node : new IdNode(node.leaf, node.keys.slice(), node.kids.slice(), owner);

const insertAt = (list, at, item) => {
  list.push(item);
  for (let i = list.length - 1; i > at; i--) list[i] = list[i - 1];
  list[at] = item;
};
const removeAt = (list, at) => {
  for (let i = at; i < list.length - 1; i++) list[i] = list[i + 1];
  list.pop();
};

// Whether the last `set` added a key.
let added = false;

// The upper half of an overflowing node, the lower half left in it.
const splitOff = (node, owner) => {
  const half = node.keys.length >> 1;
  const right = new IdNode(node.leaf, node.keys.slice(half), node.kids.slice(half), owner);
  node.keys.length = half;
  node.kids.length = half;
  return right;
};

const setIn = (node, key, value, owner) => {
  const own = writable(node, owner);
  const i = floorAt(own.keys, key);
  if (own.leaf) {
    if (i !== -1 && own.keys[i] === key) own.kids[i] = value;
    else {
      insertAt(own.keys, i + 1, key);
      insertAt(own.kids, i + 1, value);
      added = true;
    }
    return own;
  }
  // Under the child whose least key is at or below `key` — the first, for a key below them all.
  const c = i === -1 ? 0 : i;
  const child = setIn(own.kids[c], key, value, owner);
  own.kids[c] = child;
  if (key < own.keys[c]) own.keys[c] = key;
  if (child.keys.length > MAX) {
    const right = splitOff(child, owner);
    insertAt(own.keys, c + 1, right.keys[0]);
    insertAt(own.kids, c + 1, right);
  }
  return own;
};

/**
 * The index with `key` set to `value`: the root itself, changed, where it is `owner`'s; a new root
 * otherwise, the one given untouched. `added()` says whether the key is new.
 */
const set = (root, key, value, owner) => {
  added = false;
  const own = setIn(root, key, value, owner);
  if (own.keys.length <= MAX) return own;
  const right = splitOff(own, owner);
  return new IdNode(false, [own.keys[0], right.keys[0]], [own, right], owner);
};
const wasAdded = () => added;

// The node without `key`; an inner node drops a child left empty.
const removeIn = (node, key, owner) => {
  const i = floorAt(node.keys, key);
  if (i === -1) return node;
  if (node.leaf) {
    if (node.keys[i] !== key) return node;
    const own = writable(node, owner);
    removeAt(own.keys, i);
    removeAt(own.kids, i);
    return own;
  }
  const child = removeIn(node.kids[i], key, owner);
  if (child === node.kids[i] && child.owner !== owner) return node;
  const own = writable(node, owner);
  if (child.keys.length === 0) {
    removeAt(own.keys, i);
    removeAt(own.kids, i);
  } else {
    own.kids[i] = child;
    own.keys[i] = child.keys[0];
  }
  return own;
};

/** The index without `key` (as `set`, the root itself where it is `owner`'s). */
const remove = (root, key, owner) => {
  const own = removeIn(root, key, owner);
  if (own.keys.length === 0 && !own.leaf) return EMPTY;
  return own;
};

/** An index of `keys` (ascending) and their `values`, bottom-up, O(n). */
const fromSorted = (keys, values, owner) => {
  if (keys.length === 0) return EMPTY;
  let level = [];
  let mins = [];
  for (let i = 0; i < keys.length; i += MAX) {
    level.push(new IdNode(true, keys.slice(i, i + MAX), values.slice(i, i + MAX), owner));
    mins.push(keys[i]);
  }
  while (level.length > 1) {
    const up = [];
    const upMins = [];
    for (let i = 0; i < level.length; i += MAX) {
      up.push(new IdNode(false, mins.slice(i, i + MAX), level.slice(i, i + MAX), owner));
      upMins.push(mins[i]);
    }
    level = up;
    mins = upMins;
  }
  return level[0];
};

// A walk from a key on: the path down, the place in each node.
class Cursor {
  constructor() {
    this.nodes = [];
    this.at = [];
    this.key = 0;
    this.value = undefined;
  }
}

/** A cursor at the first entry whose key is at or above `key` (its `value` undefined past the end). */
const seek = (root, key) => {
  const cursor = new Cursor();
  let node = root;
  for (;;) {
    const i = floorAt(node.keys, key);
    if (node.leaf) {
      cursor.nodes.push(node);
      cursor.at.push(i !== -1 && node.keys[i] === key ? i : i + 1);
      break;
    }
    cursor.nodes.push(node);
    // A child entered is the parent's place; `settle` moves past it once the child is done.
    cursor.at.push((i === -1 ? 0 : i) + 1);
    node = node.kids[i === -1 ? 0 : i];
  }
  settleFrom(cursor);
  return cursor;
};

// The places of a cursor's path, kept as "the next to read": a leaf's the entry, an inner node's the
// child after the one entered.
const settleFrom = (cursor) => {
  for (;;) {
    const top = cursor.nodes.length - 1;
    if (top < 0) {
      cursor.value = undefined;
      return;
    }
    const node = cursor.nodes[top];
    const i = cursor.at[top];
    if (i < node.keys.length) {
      if (node.leaf) {
        cursor.key = node.keys[i];
        cursor.value = node.kids[i];
        return;
      }
      cursor.at[top] = i + 1;
      let child = node.kids[i];
      while (!child.leaf) {
        cursor.nodes.push(child);
        cursor.at.push(1);
        child = child.kids[0];
      }
      cursor.nodes.push(child);
      cursor.at.push(0);
      continue;
    }
    cursor.nodes.pop();
    cursor.at.pop();
  }
};

/** Moves the cursor to the next entry: false at the end (its value then undefined). */
const next = (cursor) => {
  const top = cursor.nodes.length - 1;
  if (top < 0) return false;
  cursor.at[top]++;
  settleFrom(cursor);
  return cursor.value !== undefined;
};

/** The number of entries, walked: for a test. */
const sizeOf = (root) => {
  if (root.leaf) return root.keys.length;
  let n = 0;
  for (let i = 0; i < root.kids.length; i++) n += sizeOf(root.kids[i]);
  return n;
};

module.exports = { MAX, EMPTY, get, floor, set, wasAdded, remove, fromSorted, seek, next, sizeOf };
