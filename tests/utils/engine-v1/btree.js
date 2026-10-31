'use strict';

// A frozen copy of the v1 engine: the oracle of tests/sequence.differential.test.js — do not fix.
// Copied from src/text/ at 5ebfb35 as it was; only the requires of modules outside src/text/ point back at
// src/. Removed with the differential test at the end of E2.

// A persistent B+-tree with two measures — the rope under a sequence block
// (./sequence.js). The leaves hold ITEMS in walk order: a run's SEGMENT (a
// piece of one run, `len` slots, `vis` when they show) or a FENCE (the open
// or the close of a run's subtree, no slots). A node's `s` is the slots
// under it, its `v` the visible ones, so a visible index, a slot ordinal
// and the item at either are found in O(log n), and an edit copies the path
// from its leaf to the root (path copying: O(MAX_ITEMS × log n) new objects)
// and shares the rest — an older version reads as it was.
//
// The one thing an older version cannot do is go UP: every item keeps a
// hint to the leaf that holds it, every node a hint to its parent, and a
// copy rewrites the hints of what it copies, so `positionOf` and the edits
// that start from an item are right for the HEAD version of a lineage only.
// Every node carries the TAG of the lineage that last hinted it (the
// lineage object ./sequence.js keeps per block); a hint-based call checks
// the path from the item to the root carries its tag and ends at its root,
// and re-hints the whole tree in place when not (O(n), no allocation —
// `stats().rehints` counts them): a fork of an older version pays once, and
// the version it forked from pays once more when it is edited again.
// Reading top-down — a locate, a cursor, an iteration — is right for every
// version and never reads a hint.
//
// The rule behind the shape is Loro's ordered index (THIRD_PARTY_NOTICES.md),
// as a rule: measures on the way down, hints on the way up. No requires.

const MAX_ITEMS = 32;

const measureOf = (item) => item.len;
const visibleOf = (item) => (item.vis ? item.len : 0);

const counters = { rehints: 0 };

// A leaf of `items`, each told where it lives, tagged for `tag`.
const leafOf = (items, tag) => {
  const node = { leaf: true, items, s: 0, v: 0, parent: null, lineage: tag, text: null };
  let s = 0;
  let v = 0;
  for (const item of items) {
    item.node = node;
    s += measureOf(item);
    v += visibleOf(item);
  }
  node.s = s;
  node.v = v;
  return node;
};

// An internal node of `children`, each told where it lives, tagged for `tag`.
const internalOf = (children, tag) => {
  const node = { leaf: false, children, s: 0, v: 0, parent: null, lineage: tag, text: null };
  let s = 0;
  let v = 0;
  for (const child of children) {
    child.parent = node;
    s += child.s;
    v += child.v;
  }
  node.s = s;
  node.v = v;
  return node;
};

// `list` cut into chunks of at most MAX_ITEMS, as even as they come.
const chunks = (list) => {
  const count = Math.ceil(list.length / MAX_ITEMS);
  const size = Math.ceil(list.length / count);
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

// `list` cut into chunks, each made a leaf (`leaf`) or an internal node.
const nodesOf = (list, leaf, tag) => {
  const pieces = chunks(list);
  for (let i = 0; i < pieces.length; i++) pieces[i] = leaf ? leafOf(pieces[i], tag) : internalOf(pieces[i], tag);
  return pieces;
};

/** The tree of `items`, in order, tagged for `tag`: bottom-up, O(n). An empty list is an empty leaf. */
const fromItems = (items, tag) => {
  if (items.length === 0) return leafOf([], tag);
  let level = nodesOf(items, true, tag);
  while (level.length > 1) level = nodesOf(level, false, tag);
  return level[0];
};

/** The root of a tree built anew around a root that overflowed: the parent of its pieces. */
const rootOf = (nodes, tag) => (nodes.length === 1 ? nodes[0] : internalOf(nodes, tag));

// Where `item` stands in its leaf when the hints from it up carry `tag` and
// reach `root`; -1 when they do not.
const trustedAt = (root, item, tag) => {
  let node = item.node;
  if (node === null || node.lineage !== tag) return -1;
  const i = node.items.indexOf(item);
  if (i === -1) return -1;
  while (node.parent !== null) {
    node = node.parent;
    if (node.lineage !== tag) return -1;
  }
  return node === root ? i : -1;
};

// Every hint of the tree set again for `tag`: the parents, the leaves, the tag.
const rehint = (root, tag) => {
  counters.rehints++;
  const stack = [root];
  root.parent = null;
  while (stack.length > 0) {
    const node = stack.pop();
    node.lineage = tag;
    if (node.leaf) {
      for (const item of node.items) item.node = node;
    } else {
      for (const child of node.children) {
        child.parent = node;
        stack.push(child);
      }
    }
  }
};

// The hints `item` needs, trusted or made anew; where it stands in its leaf.
const ensure = (root, item, tag) => {
  const i = trustedAt(root, item, tag);
  if (i !== -1) return i;
  rehint(root, tag);
  return item.node.items.indexOf(item);
};

// ---- going down ---------------------------------------------------------

// A cursor: the path from the root to an item, and the item's position in
// slots and visible slots. `next` walks it forward one item in amortized
// O(1); nothing here reads a hint, so a cursor is right for any version.
const cursorOf = (path, s, v) => {
  const { node, i } = path[path.length - 1];
  return { path, item: node.items[i], s, v };
};

/**
 * The cursor at the item covering unit `at` of measure `kind` ('s' slots or
 * 'v' visible): the first item whose units reach past `at`. Null past the
 * end. `cursor.s`/`cursor.v` are the measures before the item; the unit's
 * offset inside the item is `at - cursor[kind]`.
 */
const locate = (root, kind, at) => {
  const total = kind === 's' ? root.s : root.v;
  if (at < 0 || at >= total) return null;
  const path = [];
  let node = root;
  let s = 0;
  let v = 0;
  for (;;) {
    if (node.leaf) {
      const { items } = node;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const units = kind === 's' ? measureOf(item) : visibleOf(item);
        if (at < units) {
          path.push({ node, i });
          return cursorOf(path, s, v);
        }
        at -= units;
        s += measureOf(item);
        v += visibleOf(item);
      }
      return null;
    }
    const { children } = node;
    let i = 0;
    for (; i < children.length - 1; i++) {
      const child = children[i];
      const units = kind === 's' ? child.s : child.v;
      if (at < units) break;
      at -= units;
      s += child.s;
      v += child.v;
    }
    path.push({ node, i });
    node = children[i];
  }
};

/**
 * The item covering unit `at` of measure `kind`, with the measures before
 * it (`{ item, s, v }`), or null past the end: `locate` without the path,
 * for a reading that does not walk on.
 */
const find = (root, kind, at) => {
  const total = kind === 's' ? root.s : root.v;
  if (at < 0 || at >= total) return null;
  let node = root;
  let s = 0;
  let v = 0;
  while (!node.leaf) {
    const { children } = node;
    let i = 0;
    for (; i < children.length - 1; i++) {
      const child = children[i];
      const units = kind === 's' ? child.s : child.v;
      if (at < units) break;
      at -= units;
      s += child.s;
      v += child.v;
    }
    node = children[i];
  }
  const { items } = node;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const units = kind === 's' ? measureOf(item) : visibleOf(item);
    if (at < units) return { item, s, v };
    at -= units;
    s += measureOf(item);
    v += visibleOf(item);
  }
  return null;
};

/** The cursor at the first item, or null for an empty tree. */
const first = (root) => {
  const path = [];
  let node = root;
  while (!node.leaf) {
    path.push({ node, i: 0 });
    node = node.children[0];
  }
  if (node.items.length === 0) return null;
  path.push({ node, i: 0 });
  return cursorOf(path, 0, 0);
};

/** Moves the cursor to the next item; null at the end (the cursor is then spent). */
const next = (cursor) => {
  const { path } = cursor;
  const last = path[path.length - 1];
  cursor.s += measureOf(cursor.item);
  cursor.v += visibleOf(cursor.item);
  if (last.i + 1 < last.node.items.length) {
    last.i++;
    cursor.item = last.node.items[last.i];
    return cursor.item;
  }
  // Up to the first ancestor with a sibling to the right, then down its leftmost.
  path.pop();
  while (path.length > 0) {
    const frame = path[path.length - 1];
    if (frame.i + 1 < frame.node.children.length) {
      frame.i++;
      let node = frame.node.children[frame.i];
      while (!node.leaf) {
        path.push({ node, i: 0 });
        node = node.children[0];
      }
      path.push({ node, i: 0 });
      cursor.item = node.items[0];
      return cursor.item;
    }
    path.pop();
  }
  cursor.item = null;
  return null;
};

/** Every item in order, from the first or from a cursor. */
function* iterate(root, cursor = first(root)) {
  if (cursor === null) return;
  for (let item = cursor.item; item !== null; item = next(cursor)) yield item;
}

// The visible bodies under `node` as one string, kept on the node: a node
// never changes, so after an edit only the copied path concatenates again
// and shares the rest — a leaf's bodies and the levels above alike as a
// concatenation, which is a rope in V8 until it is read, so the whole is
// never copied here. (A join would copy: a run typed into grows one body
// a keystroke at a time, and a leaf that holds it with others would copy
// it whole on every keystroke.)
const textOf = (node) => {
  if (node.text !== null) return node.text;
  let out = '';
  if (node.leaf) {
    for (const item of node.items) if (item.vis) out += item.body;
  } else for (const child of node.children) out += textOf(child);
  node.text = out;
  return out;
};

/** The visible bodies of the tree in order, as one string — a text's reading, O(log n) after an edit. */
const text = (root) => textOf(root);

// ---- going up ----------------------------------------------------------

/** The slots and visible slots before `item` of the tree `root` tagged `tag` — through the hints. */
const positionOf = (root, item, tag) => {
  const i = ensure(root, item, tag);
  let s = 0;
  let v = 0;
  let node = item.node;
  const { items } = node;
  for (let k = 0; k < i; k++) {
    s += measureOf(items[k]);
    v += visibleOf(items[k]);
  }
  for (let parent = node.parent; parent !== null; node = parent, parent = node.parent) {
    for (const child of parent.children) {
      if (child === node) break;
      s += child.s;
      v += child.v;
    }
  }
  return { s, v };
};

/** The cursor at `item` of the tree `root` tagged `tag`: its path and position. */
const cursorAt = (root, item, tag) => {
  const { s } = positionOf(root, item, tag);
  const total = measureOf(item);
  // A fence has no slots: locate by the slots before it and step to the fence itself.
  const cursor = total > 0 ? locate(root, 's', s) : locateItem(root, item);
  return cursor;
};

// The cursor at an item of no measure: the path down to it, by identity.
const locateItem = (root, item) => {
  const path = [];
  let node = root;
  let s = 0;
  let v = 0;
  // The leaf's ancestors, by the hints; the position counted on the way down.
  const trail = [];
  for (let n = item.node; n !== null; n = n.parent) trail.push(n);
  trail.reverse();
  for (let d = 0; d < trail.length - 1; d++) {
    const parent = trail[d];
    const i = parent.children.indexOf(trail[d + 1]);
    for (let k = 0; k < i; k++) {
      s += parent.children[k].s;
      v += parent.children[k].v;
    }
    path.push({ node: parent, i });
    node = parent.children[i];
  }
  const i = node.items.indexOf(item);
  for (let k = 0; k < i; k++) {
    s += measureOf(node.items[k]);
    v += visibleOf(node.items[k]);
  }
  path.push({ node, i });
  return cursorOf(path, s, v);
};

// ---- editing (path copying) --------------------------------------------

// `list` as one node — a leaf (`leaf`) or an internal one — or split evenly when it overflows.
const pieced = (list, leaf, tag) => {
  if (list.length > MAX_ITEMS) return nodesOf(list, leaf, tag);
  return [leaf ? leafOf(list, tag) : internalOf(list, tag)];
};

// The leaf `leaf` with its items replaced by `items`, and the path above it
// copied: the new root. An overflowing leaf splits, and so does a parent
// that overflows in turn; the root grows a level when it splits. A leaf
// left with nothing is dropped, and so is a parent left with no children —
// a walk steps leaf to leaf and must never land on an empty one.
const rebuild = (leaf, items, tag) => {
  let replaced = leaf;
  let pieces = items.length === 0 && leaf.parent !== null ? [] : pieced(items, true, tag);
  for (let parent = leaf.parent; parent !== null; parent = replaced.parent) {
    const children = spliced(parent.children, parent.children.indexOf(replaced), 1, pieces);
    if (children.length > 0) pieces = pieced(children, false, tag);
    else pieces = parent.parent !== null ? [] : [leafOf([], tag)];
    replaced = parent;
  }
  return rootOf(pieces, tag);
};

// `held` with `remove` items at `i` replaced by `items`, as one new array.
const spliced = (held, i, remove, items) => {
  const out = new Array(held.length - remove + items.length);
  let k = 0;
  for (let j = 0; j < i; j++) out[k++] = held[j];
  for (const item of items) out[k++] = item;
  for (let j = i + remove; j < held.length; j++) out[k++] = held[j];
  return out;
};

/** The new root of `root` (tagged `tag`) with `items` inserted before `item`. */
const insertBefore = (root, item, items, tag) => {
  const i = ensure(root, item, tag);
  return rebuild(item.node, spliced(item.node.items, i, 0, items), tag);
};

/** The new root of `root` (tagged `tag`) with `items` inserted after `item`. */
const insertAfter = (root, item, items, tag) => {
  const i = ensure(root, item, tag);
  return rebuild(item.node, spliced(item.node.items, i + 1, 0, items), tag);
};

/** The new root of `root` (tagged `tag`) with `item` replaced by `items` — none to remove it. */
const replace = (root, item, items, tag) => {
  const i = ensure(root, item, tag);
  return rebuild(item.node, spliced(item.node.items, i, 1, items), tag);
};

/** The new root of `root` (tagged `tag`) with `items` appended at the end. */
const append = (root, items, tag) => {
  if (root.s === 0 && root.leaf && root.items.length === 0) return fromItems(items, tag);
  let node = root;
  while (!node.leaf) node = node.children[node.children.length - 1];
  if (trustedAt(root, node.items[node.items.length - 1], tag) === -1) rehint(root, tag);
  return rebuild(node, spliced(node.items, node.items.length, 0, items), tag);
};

/** The item before `item` in order, or null. */
const before = (root, item, tag) => {
  const i = ensure(root, item, tag);
  const held = item.node.items;
  if (i > 0) return held[i - 1];
  let node = item.node;
  for (let parent = node.parent; parent !== null; node = parent, parent = node.parent) {
    const k = parent.children.indexOf(node);
    if (k > 0) {
      let prev = parent.children[k - 1];
      while (!prev.leaf) prev = prev.children[prev.children.length - 1];
      return prev.items[prev.items.length - 1];
    }
  }
  return null;
};

/** The item after `item` in order, or null. */
const after = (root, item, tag) => {
  const i = ensure(root, item, tag);
  const held = item.node.items;
  if (i + 1 < held.length) return held[i + 1];
  let node = item.node;
  for (let parent = node.parent; parent !== null; node = parent, parent = node.parent) {
    const k = parent.children.indexOf(node);
    if (k + 1 < parent.children.length) {
      let following = parent.children[k + 1];
      while (!following.leaf) following = following.children[0];
      return following.items[0];
    }
  }
  return null;
};

/** What the tree counted: `rehints`, the trees re-hinted after a fork. */
const stats = () => ({ ...counters });

module.exports = {
  MAX_ITEMS,
  fromItems,
  rehint,
  stats,
  locate,
  find,
  first,
  next,
  iterate,
  text,
  positionOf,
  cursorAt,
  insertBefore,
  insertAfter,
  replace,
  append,
  before,
  after,
};
