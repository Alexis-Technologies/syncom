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
// it. Siblings order by a fractional index (`@alexify/syncom/order`), then by
// stamp. A removal is a move under `$trash`; what hangs there is not read.
// Pure functions over plain JSON; no requires beyond ./vector.js.

const { compareClock } = require('./vector.js');

const TRASH = '$trash';

const hasControl = (value) => {
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) < 32) return true;
  return false;
};
const isNodeId = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 128 &&
  value !== '__proto__' &&
  value !== TRASH &&
  !hasControl(value);
const isParent = (value) => value === null || value === TRASH || isNodeId(value);
const isStamp = (value) => Number.isSafeInteger(value) && value > 0;
const isOrigin = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128 && !hasControl(value);
const isFi = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;
const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
const byStamp = (a, b) => compareClock([a[0], a[1]], [b[0], b[1]]);

const createTree = () => ({ ts: 0, moves: {} });

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
    const unique = list.filter((move, i) => i === 0 || byStamp(move, list[i - 1]) !== 0);
    if (unique.length > 0) tree.moves[node] = unique;
  }
  if (Object.keys(tree.moves).length === 0) return null;
  tree.ts = stampsMax(tree);
  return tree;
};

const cloneTree = (tree) => ({ ts: tree.ts, moves: { ...tree.moves } });

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
  if (held.some((m) => byStamp(m, move) === 0)) return { tree, changed: false, reason: null };
  const next = cloneTree(tree);
  next.moves[node] = [...held, move].sort(byStamp);
  next.ts = Math.max(next.ts, stamp[0]);
  return { tree: next, changed: true, reason: null };
};

// The reset rule: moves stamped below the base are gone. Null when nothing is left.
const pruneTree = (tree, base) => {
  if (base === null) return tree;
  let next = null;
  for (const node of Object.keys(tree.moves)) {
    const kept = tree.moves[node].filter((move) => compareClock([move[0], move[1]], base) >= 0);
    if (kept.length === tree.moves[node].length) continue;
    next ??= cloneTree(tree);
    if (kept.length === 0) delete next.moves[node];
    else next.moves[node] = kept;
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
    const all = [...mine, ...b.moves[node]].sort(byStamp);
    out.moves[node] = all.filter((move, i) => i === 0 || byStamp(move, all[i - 1]) !== 0);
  }
  out.ts = stampsMax(out);
  return out;
};

// The fold: every move in stamp order, a move that would put a node under
// itself skipped. Gives each node's parent and place, and whether each
// move took.
const resolve = (tree) => {
  const all = [];
  for (const node of Object.keys(tree.moves)) for (const move of tree.moves[node]) all.push([node, move]);
  all.sort((x, y) => byStamp(x[1], y[1]));
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

// The children of each parent, in order; roots under null.
const childrenOf = (tree) => {
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
  return { children, parentOf, placeOf };
};

// What the field reads as: the roots and their children, nested —
// `[{ id, children }]`. What hangs under `$trash` or an unknown parent is
// not there.
const renderTree = (tree) => {
  const { children } = childrenOf(tree);
  const build = (parent) => (children.get(parent) ?? []).map((id) => ({ id, children: build(id) }));
  return build(null);
};

// The nodes under `node`, itself included — what a move may not target.
const subtree = (tree, node) => {
  const { children } = childrenOf(tree);
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
const siblings = (tree, parent) => {
  const { children, placeOf } = childrenOf(tree);
  return (children.get(parent ?? null) ?? []).map((id) => ({ id, fi: placeOf.get(id)[0] }));
};

module.exports = {
  TRASH,
  isNodeId,
  createTree,
  normalizeTree,
  cloneTree,
  applyTreeMove,
  pruneTree,
  joinTrees,
  resolve,
  renderTree,
  subtree,
  siblings,
};
