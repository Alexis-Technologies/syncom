'use strict';

// The tree behind the `tree` field kind: nodes with a parent and a place
// among their siblings, moved without ever forming a cycle (Kleppmann,
// Mulligan, Beresford & Gomes, "A highly-available move operation for
// replicated trees", 2021; Loro's movable tree). A block keeps, per node, the
// moves made of it — `[ts, origin, parent, fi]`, stamped — and the tree is
// the fold of every move in stamp order: a move whose target is the node
// itself or a descendant of it, at that point of the fold, does nothing. Two
// nodes that apply the same moves hold the same fold, so they agree on which
// move lost, and the loser is kept: a later move can make it moot or revive
// it. Two moves under one stamp (forged — honest clocks never repeat) tie by
// node id, in the fold, the dedupe and the join alike, so every node agrees
// which lost. Siblings order by a fractional index (`@alexify/syncom/order`,
// at most MAX_FI characters), then by stamp. A removal is a move under
// `$trash`; what hangs there is not read.
// A tree reads MAX_DEPTH levels: what hangs deeper is folded but not shown,
// the same on every node (a 4 000-deep chain would throw in the render and
// in JSON.stringify, and a throw on the apply path stops a stream). Pure
// functions over plain JSON; requires ./vector.js, ./order.js (a place
// among siblings must be a fractional index: anything else would throw in
// `between()` on every local move landing next to it) and ./args.js (the
// node-id rule, the one the write API checks with).

const { compareClock } = require('../vector.js');
const { isKey } = require('../order/order.js');
const { isNodeId } = require('../args.js');

const TRASH = '$trash';
const MAX_DEPTH = 512;
const MAX_FI = 1024;

const hasControl = (value) => {
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) < 32) return true;
  return false;
};
const isParent = (value) => value === null || value === TRASH || isNodeId(value);
const isStamp = (value) => Number.isSafeInteger(value) && value > 0;
const isOrigin = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('@') && !hasControl(value);
const isFi = (value) => typeof value === 'string' && value.length <= MAX_FI && isKey(value);
const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
const byStamp = (a, b) => compareClock([a[0], a[1]], [b[0], b[1]]);
const byNode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const createTree = () => ({ k: 'tree', ts: 0, moves: {} });

const stampsMax = (tree) => {
  let ts = 0;
  for (const node of Object.keys(tree.moves)) for (const move of tree.moves[node]) ts = Math.max(ts, move[0]);
  return ts;
};

// A peer's block rebuilt into the trusted shape: node ids and parents of
// the right form, moves sorted by stamp with duplicates dropped. Null when
// nothing is left.
const normalizeTree = (raw) => {
  if (!raw || typeof raw !== 'object' || !raw.moves || typeof raw.moves !== 'object') return null;
  const tree = createTree();
  for (const node of Object.keys(raw.moves)) {
    if (!isNodeId(node) || !Array.isArray(raw.moves[node])) continue;
    const list = [];
    for (const move of raw.moves[node]) {
      if (!Array.isArray(move) || move.length !== 4) continue;
      const [ts, origin, parent, fi] = move;
      if (!isStamp(ts) || !isOrigin(origin) || !isParent(parent) || !isFi(fi)) continue;
      list.push([ts, origin, parent, fi]);
    }
    list.sort(byStamp);
    // A stamp seen twice is one move: the list compacted in place.
    let kept = 0;
    for (let i = 0; i < list.length; i++) {
      if (i === 0 || byStamp(list[i], list[i - 1]) !== 0) list[kept++] = list[i];
    }
    list.length = kept;
    if (kept > 0) tree.moves[node] = list;
  }
  if (Object.keys(tree.moves).length === 0) return null;
  tree.ts = stampsMax(tree);
  return tree;
};

const cloneTree = (tree) => ({ k: 'tree', ts: tree.ts, moves: { ...tree.moves } });

// The first of a node's moves (in stamp order, as every list is kept) not
// older than the stamp `[ts, origin]`: a binary search.
const firstFrom = (moves, ts, origin) => {
  let lo = 0;
  let hi = moves.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const m = moves[mid];
    if (m[0] < ts || (m[0] === ts && m[1] < origin)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

// A `tree` op: one more move of the node, kept in stamp order; the same
// stamp twice changes nothing.
const applyTreeMove = (tree, stamp, payload) => {
  if (!payload || typeof payload !== 'object') return { tree, changed: false, reason: 'malformed' };
  const { node, parent, fi } = payload;
  if (!isNodeId(node) || !isParent(parent) || !isFi(fi) || parent === node) {
    return { tree, changed: false, reason: 'malformed' };
  }
  const move = [stamp[0], stamp[1], parent, fi];
  const held = own(tree.moves, node) ?? [];
  const at = firstFrom(held, move[0], move[1]);
  if (at < held.length && byStamp(held[at], move) === 0) return { tree, changed: false, reason: null };
  const moves = [];
  for (let i = 0; i < at; i++) moves.push(held[i]);
  moves.push(move);
  for (let i = at; i < held.length; i++) moves.push(held[i]);
  const next = cloneTree(tree);
  next.moves[node] = moves;
  next.ts = Math.max(next.ts, stamp[0]);
  return { tree: next, changed: true, reason: null };
};

// The reset rule: moves stamped below the base are gone. Null when nothing is left.
const pruneTree = (tree, base) => {
  if (base === null) return tree;
  let next = null;
  for (const node of Object.keys(tree.moves)) {
    const moves = tree.moves[node];
    const first = firstFrom(moves, base[0], base[1]);
    if (first === 0) continue;
    next ??= cloneTree(tree);
    if (first === moves.length) delete next.moves[node];
    else next.moves[node] = moves.slice(first);
  }
  const out = next ?? tree;
  if (Object.keys(out.moves).length === 0) return null;
  if (next !== null) next.ts = stampsMax(next);
  return out;
};

// Two nodes' pictures of one tree: the union of moves.
const joinTrees = (a, b) => {
  const out = createTree();
  for (const node of Object.keys(a.moves)) out.moves[node] = a.moves[node];
  for (const node of Object.keys(b.moves)) {
    const mine = own(out.moves, node);
    if (mine === undefined) {
      out.moves[node] = b.moves[node];
      continue;
    }
    // Both lists in stamp order, merged; a stamp both hold is kept once, as mine.
    const theirs = b.moves[node];
    const all = [];
    let i = 0;
    let j = 0;
    while (i < mine.length || j < theirs.length) {
      let move;
      if (j >= theirs.length) move = mine[i++];
      else if (i >= mine.length) move = theirs[j++];
      else {
        const order = byStamp(mine[i], theirs[j]);
        move = order <= 0 ? mine[i++] : theirs[j++];
      }
      if (all.length === 0 || byStamp(move, all[all.length - 1]) !== 0) all.push(move);
    }
    out.moves[node] = all;
  }
  out.ts = stampsMax(out);
  return out;
};

// The fold: every move in stamp order — two moves of different nodes with
// one stamp (forged: a clock never repeats) by node id, so the order is a
// function of the moves alone — a move that would put a node under itself
// skipped. Gives each node's parent and place, and whether each move took.
const resolve = (tree) => {
  const all = [];
  for (const node of Object.keys(tree.moves)) for (const move of tree.moves[node]) all.push([node, move]);
  all.sort((x, y) => byStamp(x[1], y[1]) || byNode(x[0], y[0]));
  const parentOf = new Map();
  const placeOf = new Map();
  const isUnder = (ancestor, node) => {
    let at = node;
    const seen = new Set();
    while (at !== null && at !== TRASH && at !== undefined && !seen.has(at)) {
      if (at === ancestor) return true;
      seen.add(at);
      at = parentOf.get(at) ?? null;
    }
    return false;
  };
  for (const [node, [ts, origin, parent, fi]] of all) {
    if (parent !== null && parent !== TRASH && isUnder(node, parent)) continue;
    parentOf.set(node, parent);
    placeOf.set(node, [fi, ts, origin]);
  }
  return { parentOf, placeOf };
};

const byPlace = (placeOf) => (x, y) => {
  const a = placeOf.get(x);
  const b = placeOf.get(y);
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  return compareClock([a[1], a[2]], [b[1], b[2]]);
};

// The children of each parent, in order; roots under null. Kept by the
// block: a block is never mutated (every change is a new one), so a tree
// is folded once however many times it is read — a local move reads it
// several times, a page of a peer's moves renders it once per op.
const FOLDED = new WeakMap();
const childrenOf = (tree) => {
  const hit = FOLDED.get(tree);
  if (hit !== undefined) return hit;
  const { parentOf, placeOf } = resolve(tree);
  const children = new Map();
  for (const [node, parent] of parentOf) {
    const key = parent ?? null;
    const list = children.get(key);
    if (list) list.push(node);
    else children.set(key, [node]);
  }
  const order = byPlace(placeOf);
  for (const list of children.values()) list.sort(order);
  const folded = { children, parentOf, placeOf };
  FOLDED.set(tree, folded);
  return folded;
};

// What the field reads as: the roots and their children, nested —
// `[{ id, children }]`, MAX_DEPTH levels at most. What hangs under `$trash`,
// an unknown parent or below the last level is not there.
const renderTree = (tree) => {
  const { children } = childrenOf(tree);
  const ids = children.get(null) ?? [];
  const roots = [];
  const stack = [];
  for (let i = 0; i < ids.length; i++) {
    roots.push({ id: ids[i], children: [] });
    stack.push([roots[i], 1]);
  }
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (depth >= MAX_DEPTH) continue;
    for (const id of children.get(node.id) ?? []) {
      const child = { id, children: [] };
      node.children.push(child);
      stack.push([child, depth + 1]);
    }
  }
  return roots;
};

// The readers below take the fold (`childrenOf`) when the caller has it, so
// a local move that needs several readings of one tree folds it once.

// The nodes under `node`, itself included — what a move may not target.
const subtree = (tree, node, folded = childrenOf(tree)) => {
  const { children } = folded;
  const out = new Set([node]);
  const stack = [node];
  while (stack.length > 0) {
    const at = stack.pop();
    for (const child of children.get(at) ?? []) {
      if (!out.has(child)) {
        out.add(child);
        stack.push(child);
      }
    }
  }
  return out;
};

// The ordered children of `parent` with their places — for a local move
// that names a sibling to land after or before.
const siblings = (tree, parent, folded = childrenOf(tree)) => {
  const { children, placeOf } = folded;
  const ids = children.get(parent ?? null) ?? [];
  const out = [];
  for (let i = 0; i < ids.length; i++) out.push({ id: ids[i], fi: placeOf.get(ids[i])[0] });
  return out;
};

// The level `node` sits at in the fold — a root is 1, a node under a parent
// the fold does not know counts up to it — and how tall the subtree under
// `node` is, itself included (1 for a node not in the tree yet).
const depthOf = (folded, node) => {
  let depth = 0;
  let at = node;
  while (at !== null && at !== TRASH && folded.parentOf.has(at)) {
    depth++;
    at = folded.parentOf.get(at);
  }
  return depth;
};
const heightOf = (folded, node) => {
  let height = 0;
  const stack = [[node, 1]];
  while (stack.length > 0) {
    const [at, level] = stack.pop();
    if (level > height) height = level;
    for (const child of folded.children.get(at) ?? []) stack.push([child, level + 1]);
  }
  return height;
};

module.exports = {
  TRASH,
  MAX_DEPTH,
  MAX_FI,
  isNodeId,
  createTree,
  normalizeTree,
  cloneTree,
  applyTreeMove,
  pruneTree,
  joinTrees,
  resolve,
  childrenOf,
  renderTree,
  subtree,
  siblings,
  depthOf,
  heightOf,
};
