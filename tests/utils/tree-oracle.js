'use strict';

// THE FULL FOLD, KEPT AS AN ORACLE. This is src/tree/moves.js as of commit
// 005e4a5 (every op folds every move from scratch: the sort, the walks, the
// children sorted, the reading rendered whole) and the change report of
// src/tree/tree.js of the same commit (`placements`, `treeChanges`: two
// readings diffed), copied verbatim with only the requires rewired.
// tests/tree.fold.test.js applies the SAME moves to this fold and to the
// live engine and asserts the blocks, the readings, the parents and the
// change reports agree, order included — the proof behind the incremental
// fold (INVARIANTS TREE-4). Do not fix or improve anything here: an oracle
// that moves is no oracle.

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
// in JSON.stringify, and a throw on the apply path stops a stream). The
// fold's cycle check walks up from a move's parent MAX_WALK ancestors at
// most: a move whose parent sits deeper than that, at that point of the
// fold, is moot like one that would make a cycle — a function of the moves
// alone, so every node folds it the same. A field holds MAX_MOVES moves,
// every node's together: a move past it is a `bound` refusal, a peer's
// block holding more is not taken, and a join keeps the oldest MAX_MOVES in
// the fold's order. The two bound what every op that changes the field
// pays — the fold, O(moves · log moves + moves · MAX_WALK). Pure
// functions over plain JSON; requires ./vector.js, ./order.js (a place
// among siblings must be a fractional index: anything else would throw in
// `between()` on every local move landing next to it) and ./args.js (the
// node-id rule, the one the write API checks with).

const { compareClock } = require('../../src/vector.js');
const { isKey } = require('../../src/order/order.js');
const { isNodeId } = require('../../src/args.js');

const TRASH = '$trash';
const MAX_DEPTH = 512;
const MAX_FI = 1024;
// The ancestors the cycle check walks: a parent the tree reads (MAX_DEPTH
// levels) is never past it, and a local move under one deeper is refused
// anyway (OUT_OF_RANGE), so only a peer's move under a node no reading
// shows is moot by it. Unbounded, a chain of n nodes cost the fold n²/2
// steps — 10 000 nodes, one snapshot block of 330 KB, four seconds of the
// mutation queue on every later op of the field.
const MAX_WALK = MAX_DEPTH;
// The moves a field holds. Every op that changes the field folds all of
// them — sorted, then at worst (a chain MAX_WALK deep, every other move
// under its last node) MAX_WALK steps each. At 2¹⁶ a fold takes some
// 25 ms under a root or a random tree and 100 ms at worst, an op through
// applyOp 30 to 130 ms (bench/tree.js); at 2¹⁷ twice that. An outline of
// thousands of nodes moved about a few times each fits; a field at the
// bound takes nothing more until a reset — `compact(id)` makes one move
// per node.
const MAX_MOVES = 1 << 16;

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
// A move is `[ts, origin, …]`: a stamp as compareClock reads one.
const byStamp = (a, b) => compareClock(a, b);
const byNode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const createTree = () => ({ k: 'tree', ts: 0, moves: {} });

const stampsMax = (tree) => {
  let ts = 0;
  for (const node of Object.keys(tree.moves)) for (const move of tree.moves[node]) ts = Math.max(ts, move[0]);
  return ts;
};

// How many moves a block holds: a walk of its nodes, like the copy every
// move makes of them.
const movesOf = (tree) => {
  let count = 0;
  for (const node of Object.keys(tree.moves)) count += tree.moves[node].length;
  return count;
};

// The steps the folds' walks took, for the tests and the bench.
const walks = { steps: 0 };

// A peer's block rebuilt into the trusted shape: node ids and parents of
// the right form, moves sorted by stamp with duplicates dropped. Null when
// nothing is left, or more than MAX_MOVES moves are.
const normalizeTree = (raw) => {
  if (!raw || typeof raw !== 'object' || !raw.moves || typeof raw.moves !== 'object') return null;
  const tree = createTree();
  let total = 0;
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
    total += kept;
    if (total > MAX_MOVES) return null;
    if (kept > 0) tree.moves[node] = list;
  }
  if (total === 0) return null;
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
// stamp twice changes nothing, and a move past MAX_MOVES is refused
// (`bound`, with the count and the limit).
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
  const count = movesOf(tree) + 1;
  if (count > MAX_MOVES) return { tree, changed: false, reason: 'bound', detail: 'moves', count, max: MAX_MOVES };
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

// Every move as `[node, move, i]` in the fold's order — by stamp, then
// (two moves of different nodes with one stamp, forged: a clock never
// repeats) by node id, so the order is a function of the moves alone —
// and the index `i` of every node.
const folding = (tree) => {
  const index = new Map();
  const all = [];
  for (const node of Object.keys(tree.moves)) {
    const i = index.size;
    index.set(node, i);
    for (const move of tree.moves[node]) all.push([node, move, i]);
  }
  all.sort((x, y) => byStamp(x[1], y[1]) || byNode(x[0], y[0]));
  return [all, index];
};

// The oldest MAX_MOVES of a tree's moves, in the fold's order.
const oldest = (tree) => {
  const [all] = folding(tree);
  const out = createTree();
  for (let i = 0; i < MAX_MOVES; i++) {
    const [node, move] = all[i];
    (own(out.moves, node) ?? (out.moves[node] = [])).push(move);
  }
  return out;
};

// Two nodes' pictures of one tree: the union of moves — past MAX_MOVES,
// the oldest of it in the fold's order (the same whichever side holds
// which: the newest is what the op path would have refused).
const joinTrees = (a, b) => {
  let out = createTree();
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
  if (movesOf(out) > MAX_MOVES) out = oldest(out);
  out.ts = stampsMax(out);
  return out;
};

// The fold: every move in the fold's order (`folding`), a move skipped that
// would put a node under itself or under a parent more than MAX_WALK
// ancestors deep at that point. Gives each node's parent and place.
// The walk needs no set of the names it has seen: the parent map is a
// forest — a node's parent is set only when the walk up from the new
// parent ended (at a root, the trash or a name no move places) without
// meeting the node, so no move closes a loop, and every walk ends. A node
// is an index and the walk reads an Int32Array: a step of it through a
// Map took 35 ns — a second and more a fold at MAX_MOVES, at worst.
const resolve = (tree) => {
  const [all, index] = folding(tree);
  // Each node's parent as an index; -1 where a walk ends: a root, the
  // trash, a name no move places, a node not placed yet.
  const up = new Int32Array(index.size).fill(-1);
  const parentOf = new Map();
  const placeOf = new Map();
  for (let i = 0; i < all.length; i++) {
    const [node, [ts, origin, parent, fi], self] = all[i];
    // Null and the trash are no node's id: no index, like a name no move places.
    const to = index.get(parent) ?? -1;
    // Up from the parent: `at` turns -1 at the top, or stays on the node
    // itself (a cycle) or on the first ancestor past the walk (moot).
    let at = to;
    let walked = 0;
    while (at >= 0 && at !== self && walked < MAX_WALK) {
      walked++;
      at = up[at];
    }
    walks.steps += walked;
    if (at >= 0) continue;
    up[self] = to;
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

// src/tree/tree.js, the change report.

// Every node's place: its parent and the sibling before it.
const placements = (nodes) => {
  const out = new Map();
  const stack = [[nodes, null]];
  while (stack.length > 0) {
    const [children, parent] = stack.pop();
    for (let i = 0; i < children.length; i++) {
      const node = children[i];
      out.set(node.id, { parent, after: i === 0 ? null : children[i - 1].id });
      stack.push([node.children, node.id]);
    }
  }
  return out;
};

// The nodes whose place changed between two readings — a moved node, and
// the ones that followed it where it was and where it is — as `treeMove`
// changes (`parent`, `after`); a node gone as `treeRemove`, the root of a
// subtree alone.
const treeChanges = (before, after) => {
  const was = placements(before);
  const is = placements(after);
  const out = [];
  for (const [node, place] of is) {
    const prev = was.get(node);
    if (prev === undefined || prev.parent !== place.parent || prev.after !== place.after) {
      out.push({ action: 'treeMove', node, parent: place.parent, after: place.after });
    }
  }
  for (const [node, place] of was) {
    if (!is.has(node) && (place.parent === null || is.has(place.parent))) out.push({ action: 'treeRemove', node });
  }
  return out;
};

module.exports = {
  TRASH,
  MAX_DEPTH,
  MAX_WALK,
  MAX_MOVES,
  createTree,
  normalizeTree,
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
  treeChanges,
};
