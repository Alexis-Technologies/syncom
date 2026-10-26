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
// at most MAX_FI characters), then by stamp, then by the node's first move
// that took (the fold's order). A removal is a move under `$trash`; what
// hangs there is not read.
// A tree reads MAX_DEPTH levels: what hangs deeper is folded but not shown,
// the same on every node (a 4 000-deep chain would throw in the render and
// in JSON.stringify, and a throw on the apply path stops a stream). The
// fold's cycle check walks up from a move's parent MAX_WALK ancestors at
// most: a move whose parent sits deeper than that, at that point of the
// fold, is moot like one that would make a cycle — a function of the moves
// alone, so every node folds it the same. A field holds MAX_MOVES moves,
// every node's together: a move past it is a `bound` refusal, a peer's
// block holding more is not taken, and a join keeps the oldest MAX_MOVES in
// the fold's order.
//
// THE FOLD IS KEPT, not redone. A block reads as plain JSON — `{ k, ts,
// moves }`, `moves` made from the engine's state when read, once per version
// — and its fold lives in a module-private WeakMap: every node's parent and
// place, every parent's children in order, every move in the fold's order
// with what it found (the node's parent and place before it), the reading
// with every shown node's object in it. An op hands that state on to the
// block it makes, the HEAD of the lineage; the block before keeps what makes
// its JSON again from the next one's (the node and its moves before the op)
// and is folded again from that JSON if it is ever read as a tree
// (`walks.folds`). A move newest in the fold's order — every local move, a
// peer's arriving in stamp order — is one step: the walk, the node out of its
// siblings and among the new ones, O(MAX_WALK + siblings + log moves). A move
// older than some is the paper's undo–do–redo: the newer moves undone,
// newest first, the move done, the newer ones done again (`walks.undone`) —
// O(newer · (MAX_WALK + siblings)); past half the log, or when a node's
// first move places a name a walk exactly MAX_WALK long ended on (that walk
// is one step longer now: its move is moot), the fold from scratch. What the
// op changed is read from the nodes it moved, as they were (kept while it
// runs, with the lists it changed): their siblings next to them before and
// after, and what hangs under them at the levels that cross a cut — in the
// order the two readings diffed would list it. The reading is path-copied:
// a new object for every node from a changed list up to the roots, the rest
// shared with the reading before, nothing changed in place. A JSON block (a
// file, a peer's, a join, a prune) is folded once, from scratch:
// O(moves · log moves + moves · MAX_WALK). Requires ../vector.js,
// ../order/order.js (a place among siblings must be a fractional index:
// anything else would throw in `between()` on every local move landing next
// to it) and ../args.js (the node-id rule, the one the write API checks with).

const { compareClock } = require('../vector.js');
const { isKey } = require('../order/order.js');
const { isNodeId } = require('../args.js');

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
// The moves a field holds. A fold from scratch — a block read from JSON —
// sorts them, then walks at worst (a chain MAX_WALK deep, every other move
// under its last node) MAX_WALK steps each: at 2¹⁶ some 25 ms under one
// root, 50 ms in a random tree and 100 ms at worst (bench/tree.js); an op
// folds one move, or the moves newer than it. An outline of thousands of nodes moved
// about a few times each fits; a field at the bound takes nothing more
// until a reset — `compact(id)` makes one move per node.
const MAX_MOVES = 1 << 16;
// The level of a node no reading shows.
const HIDDEN = MAX_DEPTH + 1;
const NONE = Object.freeze([]);

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

const createTree = () => ({ k: 'tree', ts: 0, moves: {} });

const stampsMax = (tree) => {
  let ts = 0;
  for (const node of Object.keys(tree.moves)) for (const move of tree.moves[node]) ts = Math.max(ts, move[0]);
  return ts;
};

// What the folds did, for the tests and the bench: the steps the walks
// took, the folds from scratch, the moves undone to land an older one.
const walks = { steps: 0, folds: 0, undone: 0 };

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

// The oldest MAX_MOVES of a tree's moves in the fold's order — by stamp,
// then (two moves of different nodes with one stamp, forged: a clock never
// repeats) by node id, so the order is a function of the moves alone.
const oldest = (tree) => {
  const all = [];
  for (const node of Object.keys(tree.moves)) for (const move of tree.moves[node]) all.push([node, move]);
  all.sort((x, y) => byStamp(x[1], y[1]) || (x[0] < y[0] ? -1 : 1));
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
  let count = 0;
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
  for (const node of Object.keys(out.moves)) count += out.moves[node].length;
  if (count > MAX_MOVES) out = oldest(out);
  out.ts = stampsMax(out);
  return out;
};

// ---- the fold ---------------------------------------------------------------

// A block's state: the head of its lineage (the block an op hands it to),
// the nodes by id in the order the block's JSON lists them, every parent's
// children in order (keyed by the parent's name: null, the trash, a node, a
// name no move places), every move in the fold's order, how many, the names
// a walk exactly MAX_WALK long ended on (`frag`), the reading of the head
// (null until read), and — while an op runs — every node and list it touched
// as they were before it (`was`, `wasKids`).
// A node: its moves (stamp order, a new array per change), its parent
// (undefined: not placed) and the parent's node when the parent is one
// (`up`: what a walk follows — a step through the map by name took 35 ns,
// a second and more a fold at MAX_MOVES, at worst), the move that put it
// there (`place`), its first move that took in the fold's order (`first`),
// its height when known (`h`, 0 when not: valid while nothing under it
// changes) and its object in the reading (`r`). A move of the log: the node, the move, and — when it
// took — what it found (`w`: the node's parent, place and first before it).
const STATE = new WeakMap();

const nodeOf = (id, moves) => ({
  id,
  moves,
  parent: undefined,
  up: undefined,
  place: null,
  first: null,
  h: 0,
  r: null,
});
const entryOf = (n, m) => ({ n, m, w: null });
const stateNow = (n) => [n.parent, n.place, n.first];

// Whether node `a` reads before node `b` among their siblings: by place,
// then by stamp, then — ties only a forged stamp makes — by the first move
// of each that took, in the fold's order.
const sooner = (a, b) => {
  const x = a.place;
  const y = b.place;
  if (x[3] !== y[3]) return x[3] < y[3];
  if (x[0] !== y[0]) return x[0] < y[0];
  if (x[1] !== y[1]) return x[1] < y[1];
  const f = a.first;
  const g = b.first;
  if (f[0] !== g[0]) return f[0] < g[0];
  return f[1] !== g[1] ? f[1] < g[1] : a.id < b.id;
};
// Whether move `e` of the log comes after `f` in the fold's order.
const later = (e, f) => {
  const a = e.m;
  const b = f.m;
  if (a[0] !== b[0]) return a[0] > b[0];
  return a[1] !== b[1] ? a[1] > b[1] : e.n.id > f.n.id;
};
// The first index of a sorted list whose item `after` says comes after.
const bisect = (list, after) => {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (after(list[mid])) hi = mid;
    else lo = mid + 1;
  }
  return lo;
};

// A list about to change, as it was before the op; a height known above it
// is no longer — up from its parent to the first node not known, whose
// ancestors are not either.
const listOf = (s, key) => {
  let list = s.kids.get(key);
  if (list === undefined) s.kids.set(key, (list = []));
  if (s.wasKids !== null && !s.wasKids.has(key)) s.wasKids.set(key, list.slice());
  for (let at = s.nodes.get(key); at !== undefined && at.h !== 0; at = at.up) at.h = 0;
  return list;
};
// The node out of its siblings, at what `w` says (as it was before the
// op, the first time), and among its new siblings.
const put = (s, n, w) => {
  if (s.was !== null && !s.was.has(n)) s.was.set(n, stateNow(n));
  if (n.parent !== undefined) {
    const list = listOf(s, n.parent);
    list.splice(list.indexOf(n), 1);
  }
  [n.parent, n.place, n.first] = w;
  n.up = s.nodes.get(n.parent);
  if (n.parent !== undefined) {
    const list = listOf(s, n.parent);
    list.splice(
      bisect(list, (m) => sooner(n, m)),
      0,
      n,
    );
  }
};

// One move of the fold: up from its parent MAX_WALK ancestors at most —
// `at` ends undefined at the top (a root, the trash, a name no move places,
// a node not placed yet), or on the node itself (a cycle), or on the first
// ancestor past the walk (moot). The walk needs no set of the names it has
// seen: the parents are a forest — a node's parent is set only when the walk
// up from the new one ended without meeting the node, so no move closes a
// loop, and every walk ends. `live` keeps the lists and what the op changed;
// a fold from scratch sorts the lists once at the end.
const step = (s, e, live) => {
  const n = e.n;
  const m = e.m;
  let at = s.nodes.get(m[2]);
  let last = null;
  let walked = 0;
  while (at !== undefined && at !== n && walked < MAX_WALK) {
    walked++;
    last = at;
    at = at.up;
  }
  walks.steps += walked;
  e.w = null;
  if (at !== undefined) return;
  // A walk that took all its steps and ended on a name no move places: a
  // move that places the name makes it one step longer — past MAX_WALK.
  if (walked === MAX_WALK && typeof last.parent === 'string') s.frag.add(last.parent);
  e.w = stateNow(n);
  const w = [m[2], m, n.first ?? m];
  if (live) put(s, n, w);
  else {
    [n.parent, n.place, n.first] = w;
    n.up = s.nodes.get(n.parent);
  }
};

// The fold from scratch, over the log as it is ordered.
const fold = (s) => {
  walks.folds++;
  for (const n of s.nodes.values()) {
    n.parent = n.up = undefined;
    n.place = n.first = null;
    n.h = 0;
  }
  s.frag = new Set();
  s.kids = new Map();
  const log = s.log;
  for (let i = 0; i < log.length; i++) step(s, log[i], false);
  for (const n of s.nodes.values()) {
    if (n.parent === undefined) continue;
    const list = s.kids.get(n.parent);
    if (list === undefined) s.kids.set(n.parent, [n]);
    else list.push(n);
  }
  for (const list of s.kids.values()) list.sort((a, b) => (sooner(a, b) ? -1 : 1));
};

// A block's JSON folded into a state the block heads.
const hydrate = (block) => {
  const moves = block.moves;
  const s = { head: block, nodes: new Map(), kids: null, log: [], count: 0, frag: null, reading: null, was: null };
  s.wasKids = null;
  for (const id of Object.keys(moves)) {
    const n = nodeOf(id, moves[id]);
    s.nodes.set(id, n);
    for (let i = 0; i < n.moves.length; i++) s.log.push(entryOf(n, n.moves[i]));
  }
  s.count = s.log.length;
  s.log.sort((e, f) => (later(e, f) ? 1 : -1));
  fold(s);
  STATE.set(block, { s, json: moves, next: null, id: null, list: undefined });
  return s;
};

/** The fold of a block, its head: kept while the block is the newest of its lineage, made again from its JSON otherwise. */
const stateOf = (block) => {
  const rec = STATE.get(block);
  return rec !== undefined && rec.s.head === block ? rec.s : hydrate(block);
};

// A block's JSON: the head's made from its nodes; an older block's from the
// next block's JSON with the node the op moved set back — the chain walked
// to a block whose JSON is made, the JSON copied once — and kept.
const movesOf = (block) => {
  const rec = STATE.get(block);
  const chain = [];
  let r = rec;
  for (let at = block; r.json === null && r.s.head !== at; r = STATE.get(at)) {
    chain.push(r);
    at = r.next;
  }
  if (r.json === null) {
    r.json = {};
    for (const n of r.s.nodes.values()) r.json[n.id] = n.moves;
  }
  if (chain.length > 0) {
    const out = { ...r.json };
    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i].list === undefined) delete out[chain[i].id];
      else out[chain[i].id] = chain[i].list;
    }
    rec.json = out;
    rec.next = null;
  }
  return rec.json;
};

// A move into the log at its place in the fold's order: one step when it is
// the newest, else the moves after it undone, newest first, and done again
// — or, past half the log or when its node's first move lengthens a walk,
// the fold from scratch (then the reading is made again whole).
const land = (s, e, fresh) => {
  const log = s.log;
  const i = log.length > 0 && later(e, log[log.length - 1]) ? log.length : bisect(log, (f) => later(f, e));
  if ((fresh && s.frag.has(e.n.id)) || (log.length - i) * 2 > log.length) {
    for (const n of s.nodes.values()) s.was.set(n, stateNow(n));
    for (const [key, list] of s.kids) s.wasKids.set(key, list);
    log.splice(i, 0, e);
    fold(s);
    for (const key of s.kids.keys()) if (!s.wasKids.has(key)) s.wasKids.set(key, NONE);
    s.reading = null;
    return;
  }
  for (let j = log.length - 1; j >= i; j--) if (log[j].w !== null) put(s, log[j].n, log[j].w);
  walks.undone += log.length - i;
  log.splice(i, 0, e);
  for (let j = i; j < log.length; j++) step(s, log[j], true);
};

// ---- what a reading shows ----------------------------------------------------

// A node's parent now, or (`before`) before the op.
const parentIn = (s, n, before) => (before && s.was.has(n) ? s.was.get(n)[0] : n.parent);
// A parent's children now, or before the op.
const kidsIn = (s, key, before) => (before ? s.wasKids.get(key) : undefined) ?? s.kids.get(key) ?? NONE;

// The level `n` reads at — a root is 1 — or HIDDEN: under the trash, a name
// no move places, a node not placed, or deeper than MAX_DEPTH.
const levelOf = (s, n, before = false) => {
  let level = 0;
  for (let at = n; at !== undefined && level < MAX_DEPTH;) {
    const p = parentIn(s, at, before);
    if (p === undefined) break;
    level++;
    if (p === null) return level;
    at = s.nodes.get(p);
  }
  return HIDDEN;
};

// The objects of the reading for `n` at `level` and what hangs under it.
const build = (s, n, level) => {
  n.r = { id: n.id, children: [] };
  const stack = [[n, level]];
  while (stack.length > 0) {
    const [node, at] = stack.pop();
    const list = at < MAX_DEPTH ? (s.kids.get(node.id) ?? NONE) : NONE;
    for (let i = 0; i < list.length; i++) {
      list[i].r = { id: list[i].id, children: [] };
      node.r.children.push(list[i].r);
      stack.push([list[i], at + 1]);
    }
  }
  return n.r;
};
// A changed list's parent made anew, and every node above it: the path
// from the list to the roots, the rest of the reading shared.
const refresh = (s, key) => {
  for (let at = key; ;) {
    const list = kidsIn(s, at, false);
    const children = [];
    for (let i = 0; i < list.length; i++) children.push(list[i].r);
    if (at === null) return void (s.reading = children);
    const n = s.nodes.get(at);
    n.r = { id: at, children };
    at = n.parent;
  }
};

/**
 * What the field reads as: the roots and their children, nested —
 * `[{ id, children }]`, MAX_DEPTH levels at most. What hangs under `$trash`,
 * an unknown parent or below the last level is not there. Never change it:
 * the next reading shares what an op did not touch.
 */
const renderTree = (tree) => {
  const s = stateOf(tree);
  if (s.reading === null) {
    const roots = kidsIn(s, null, false);
    s.reading = [];
    for (let i = 0; i < roots.length; i++) s.reading.push(build(s, roots[i], 1));
  }
  return s.reading;
};

// ---- what an op changed -------------------------------------------------------

// Two changes in a reading's order, by their keys — a node's index and its
// ancestors', the root's first: the roots, then the children of the last
// root, of its last child…: every parent's children together, the parents in
// a walk down the reading that takes the last child first.
const byKey = (x, y) => {
  const a = x[0];
  const b = y[0];
  const m = a.length - 1;
  const n = b.length - 1;
  for (let t = 0; t < m && t < n; t++) if (a[t] !== b[t]) return b[t] - a[t];
  return m !== n ? m - n : a[m] - b[n];
};

// What the reading shows of the op, as the two readings diffed would say
// it — the nodes whose place changed (`treeMove`, with the parent and the
// sibling before), in the later reading's order, then the nodes gone whose
// parent is still there, or that were roots (`treeRemove`), in the earlier
// one's — and the reading path-copied. A node's place changes when its
// parent does (a node the op moved) or the sibling before it does (the node
// after a moved one, before the op and after it); a node shows or goes when
// the level of a moved node above it changes — the levels between the two
// cuts, read down from it, past nothing else that moved.
const changesOf = (s) => {
  const moved = new Set();
  for (const [n, w] of s.was) if (w[0] !== n.parent || w[1] !== n.place || w[2] !== n.first) moved.add(n);
  if (moved.size === 0) return [];
  // A node's siblings in a view and its index among them: found by halves
  // in a list as it is (sorted by `sooner`), by a scan in one as it was.
  const spot = (n, before) => {
    const list = kidsIn(s, parentIn(s, n, before), before);
    return [list, before ? list.indexOf(n) : bisect(list, (m) => m === n || sooner(n, m))];
  };
  const candidates = new Set();
  const whole = [];
  for (const n of moved) {
    candidates.add(n);
    const [was, i] = spot(n, true);
    if (i >= 0 && i + 1 < was.length) candidates.add(was[i + 1]);
    const [is, j] = spot(n, false);
    if (j + 1 < is.length) candidates.add(is[j + 1]);
    const from = levelOf(s, n, true);
    const to = levelOf(s, n);
    if (to === HIDDEN || from === to) continue;
    // Shown from nowhere: all of it; lifted: what was below the cut; lowered: the level now below it.
    const lo = from === HIDDEN ? 1 : MAX_DEPTH - Math.max(from, to) + 1;
    const hi = to < from ? MAX_DEPTH - to : lo;
    if (from !== HIDDEN && heightOf(s, n.id) <= lo) continue;
    whole.push([n, to]);
    const stack = [[n, 0]];
    while (stack.length > 0) {
      const [at, rel] = stack.pop();
      if (rel >= lo) candidates.add(at);
      const list = rel < hi ? kidsIn(s, at.id, false) : NONE;
      for (let i = 0; i < list.length; i++) if (!moved.has(list[i])) stack.push([list[i], rel + 1]);
    }
  }
  // A node's key in a reading's order (`byKey`).
  const keyOf = (n, before) => {
    const key = [];
    for (let at = n; at !== undefined; at = s.nodes.get(parentIn(s, at, before))) key.push(spot(at, before)[1]);
    return key.reverse();
  };
  const shown = [];
  const gone = [];
  for (const n of candidates) {
    const from = levelOf(s, n, true);
    if (levelOf(s, n) !== HIDDEN) {
      const [list, i] = spot(n, false);
      const is = [parentIn(s, n, false), i === 0 ? null : list[i - 1].id];
      let was = null;
      if (from !== HIDDEN) {
        const [old, j] = spot(n, true);
        was = [parentIn(s, n, true), j === 0 ? null : old[j - 1].id];
      }
      if (was === null || was[0] !== is[0] || was[1] !== is[1]) {
        shown.push([keyOf(n, false), { action: 'treeMove', node: n.id, parent: is[0], after: is[1] }]);
      }
    } else if (from !== HIDDEN) {
      const p = parentIn(s, n, true);
      if (p === null || levelOf(s, s.nodes.get(p)) !== HIDDEN) {
        gone.push([keyOf(n, true), { action: 'treeRemove', node: n.id }]);
      }
    }
  }
  shown.sort(byKey);
  gone.sort(byKey);
  const out = [];
  for (let i = 0; i < shown.length; i++) out.push(shown[i][1]);
  for (let i = 0; i < gone.length; i++) out.push(gone[i][1]);
  // The reading: what came into it or crossed a cut made whole, then every
  // changed list that shows, up to the roots.
  if (s.reading !== null) {
    for (let i = 0; i < whole.length; i++) build(s, whole[i][0], whole[i][1]);
    for (const key of s.wasKids.keys()) {
      const n = s.nodes.get(key);
      if (key === null || (n !== undefined && levelOf(s, n) < MAX_DEPTH)) refresh(s, key);
    }
  }
  return out;
};

/**
 * A `tree` op: one more move of the node, kept in stamp order and folded —
 * `{ tree, changed, reason, change }`, `change` what the reading shows of it.
 * The same stamp twice changes nothing, and a move past MAX_MOVES is refused
 * (`bound`, with the count and the limit). The block given hands its fold
 * to the block made.
 */
const applyTreeMove = (tree, stamp, payload) => {
  if (!payload || typeof payload !== 'object') return { tree, changed: false, reason: 'malformed' };
  const { node, parent, fi } = payload;
  if (!isNodeId(node) || !isParent(parent) || !isFi(fi) || parent === node) {
    return { tree, changed: false, reason: 'malformed' };
  }
  const s = stateOf(tree);
  const move = [stamp[0], stamp[1], parent, fi];
  let n = s.nodes.get(node);
  const moves = n === undefined ? [] : n.moves.slice();
  const at = firstFrom(moves, move[0], move[1]);
  if (at < moves.length && byStamp(moves[at], move) === 0) return { tree, changed: false, reason: null };
  const count = s.count + 1;
  if (count > MAX_MOVES) return { tree, changed: false, reason: 'bound', detail: 'moves', count, max: MAX_MOVES };
  moves.splice(at, 0, move);
  const next = {
    k: 'tree',
    ts: Math.max(tree.ts, stamp[0]),
    get moves() {
      return movesOf(this);
    },
  };
  STATE.set(next, { s, json: null, next: null, id: null, list: undefined });
  // The block given keeps what makes its JSON again from the next one's.
  const rec = STATE.get(tree);
  if (rec.json === null) {
    rec.next = next;
    rec.id = node;
    rec.list = n?.moves;
  }
  s.head = next;
  s.count = count;
  s.was = new Map();
  s.wasKids = new Map();
  const fresh = n === undefined;
  if (fresh) {
    s.nodes.set(node, (n = nodeOf(node, moves)));
    // What waited under the name hangs under the node now.
    const waiting = kidsIn(s, node, false);
    for (let i = 0; i < waiting.length; i++) waiting[i].up = n;
  } else n.moves = moves;
  land(s, entryOf(n, move), fresh);
  const change = changesOf(s);
  s.was = s.wasKids = null;
  return { tree: next, changed: true, reason: null, change };
};

// The readers below take the fold (`stateOf`) the block keeps.

// Whether `name` is `node` or hangs under it — what a move of `node` may not target.
const under = (s, node, name) => {
  for (let at = name; typeof at === 'string';) {
    if (at === node) return true;
    const n = s.nodes.get(at);
    if (n === undefined || n.parent === undefined) return false;
    at = n.parent;
  }
  return false;
};

// The children of `parent` in order — nodes, each with its `id` and its
// place (`place[3]` the fractional index). Never change them.
const kidsOf = (s, parent) => s.kids.get(parent) ?? NONE;

// Whether node `id` shows in the reading.
const shows = (tree, id) => {
  const s = stateOf(tree);
  const n = s.nodes.get(id);
  return n !== undefined && levelOf(s, n) !== HIDDEN;
};

// The level `name` sits at in the fold — a root is 1, a node under a parent
// the fold does not know counts up to it — and how tall the subtree under
// `name` is, itself included (1 for a node not in the tree yet), kept per
// node until something under it changes.
const depthOf = (s, name) => {
  let depth = 0;
  for (let at = s.nodes.get(name); at !== undefined && at.parent !== undefined; at = at.up) depth++;
  return depth;
};
const heightOf = (s, name) => {
  const top = s.nodes.get(name);
  if (top !== undefined && top.h > 0) return top.h;
  // A walk down to what is known, then back up: every node after what hangs under it.
  const order = [name];
  for (let i = 0; i < order.length; i++) {
    const list = kidsIn(s, order[i], false);
    for (let j = 0; j < list.length; j++) if (list[j].h === 0) order.push(list[j].id);
  }
  let height = 1;
  for (let i = order.length - 1; i >= 0; i--) {
    const list = kidsIn(s, order[i], false);
    height = 1;
    for (let j = 0; j < list.length; j++) height = Math.max(height, list[j].h + 1);
    const n = s.nodes.get(order[i]);
    if (n !== undefined) n.h = height;
  }
  return height;
};

module.exports = {
  TRASH,
  MAX_DEPTH,
  MAX_FI,
  MAX_WALK,
  MAX_MOVES,
  walks,
  isNodeId,
  createTree,
  normalizeTree,
  applyTreeMove,
  pruneTree,
  joinTrees,
  stateOf,
  renderTree,
  under,
  kidsOf,
  shows,
  depthOf,
  heightOf,
};
