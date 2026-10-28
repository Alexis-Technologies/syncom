'use strict';

// The `tree` kind as a plugin (@alexify/syncom/tree): the movable tree
// (./moves.js — per node its stamped moves, the fold in stamp order with
// the cycle check, kept by the block and handed on to the block an op makes)
// behind a record's tree fields — what the core calls to apply a move and
// say what the reading shows of it, to normalize and join a peer's block, to
// read the field, to resolve a local call's parent and sibling into a place
// inside the queue, to diff two readings into moves — and the storage
// methods the plugin adds (treeMove, treeRemove). Registered per instance
// with `open({ plugins: [tree] })`; src/plugin.js names the contract.

const T = require('./moves.js');
const { between } = require('../order/order.js');
const { treeArgs } = require('../args.js');
const { SyncomError } = require('../errors.js');

const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);

const KINDS = Object.freeze({ tree: 5 });
const CODES = Object.freeze({ tree: 'tree' });
const HINTS = Object.freeze({ tree: 'a tree; use treeMove() or treeRemove()' });

const blockOf = (entry, field) => {
  const block = own(entry.meta.blocks, field);
  return block !== undefined && block.k === 'tree' ? block : undefined;
};

// ---------------------------------------------------------------------------
// The kind module.

const takes = () => ['tree'];
const kindOfOp = () => 'tree';
const normalize = (raw) => T.normalizeTree(raw);

// One more move in the field's log; a move that did not take is news to
// persist: a later move can make it count. A move past MAX_MOVES is a
// `bound` refusal, with the count and the limit. What the move says comes
// as it is: changed, a refusal's reason (for a bound, its detail, count and
// limit) and what the reading shows of it (`change`: the nodes whose place
// changed — the moved node, the ones that followed it where it was and
// where it is — as `treeMove` changes, `parent` and `after`; a node gone as
// `treeRemove`, the root of a subtree alone), read from the fold the block
// hands on (./moves.js).
const apply = (entry, field, held, op, stamp) => {
  const result = T.applyTreeMove(held ?? T.createTree(), stamp, op.value);
  return { ...result, block: result.changed ? result.tree : (held ?? null) };
};

const render = (entry, field, block) => T.renderTree(block);

// Who moved what: every move's origin, the newest as `last`.
const editors = (entry, field) => {
  const block = entry.meta.blocks[field];
  const all = new Set();
  let last = null;
  for (const node of Object.keys(block?.moves ?? {})) {
    for (const [ts, origin] of block.moves[node]) {
      all.add(origin);
      if (last === null || ts > last.ts) last = { origin, ts };
    }
  }
  return { last, all: [...all] };
};

// A node may hold fields of its own — `outline/<node>/title` — read as the
// node's `data` (src/compose.js); `members` are the nodes the tree shows,
// `holds` whether one is there, `pick` a node's composed data, `nest` the
// tree read with `data` on every node that has some.
const NESTS = Object.freeze({ tree: true });
// The nodes a block shows, in the order of a walk down the reading (the
// last root first); whether one shows is read from the fold, up from it.
const members = (entry, field) => {
  const block = own(entry.meta.blocks, field);
  const list = [];
  if (block === undefined) return list;
  const stack = T.renderTree(block).slice();
  while (stack.length > 0) {
    const node = stack.pop();
    list.push(node.id);
    for (const child of node.children) stack.push(child);
  }
  return list;
};
const holds = (entry, field, member) => {
  const block = own(entry.meta.blocks, field);
  return block !== undefined && T.shows(block, member);
};
const pick = (entry, field, rendered, member) => {
  let found;
  const stack = [...rendered];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.id === member) found = node.data;
    for (const child of node.children) stack.push(child);
  }
  return found;
};
const nest = (entry, field, rendered, childrenOf) => {
  const copy = (node) => {
    const kids = node.children;
    const children = [];
    for (let i = 0; i < kids.length; i++) children.push(copy(kids[i]));
    const out = { id: node.id, children };
    const data = childrenOf(node.id);
    if (data !== undefined) out.data = data;
    return out;
  };
  const out = [];
  for (let i = 0; i < rendered.length; i++) out.push(copy(rendered[i]));
  return out;
};
const prune = (block, base) => T.pruneTree(block, base);
const join = (a, b) => T.joinTrees(a, b);

// A tree move names a parent and a sibling to land after or before; what
// travels is the place among the siblings as a fractional index
// (@alexify/syncom/order) between its neighbours — decided inside the
// queue, against the fold the block keeps. A parent in the node's own
// subtree is CYCLE (up from the parent), a sibling not under the parent
// NOT_FOUND; a move to where the node already is makes no op (null). A move
// that would reach below the level a tree reads (MAX_DEPTH), or a place with
// no room left between its neighbours (an index past MAX_FI), is
// OUT_OF_RANGE. Siblings that share an index order by stamp, and a node put
// after one of them lands after all of them.
const resolve = (core, id, type, payload, current) => {
  const { key, node, parent, after, before } = payload;
  const held = current ? blockOf(current, key) : undefined;
  const s = T.stateOf(held ?? T.createTree());
  if (T.under(s, node, parent)) {
    const where = parent === node ? 'itself' : `${parent}, a node under it`;
    const message = `Node ${node} of field ${key} of record ${id} cannot go under ${where}`;
    throw new SyncomError('CYCLE', message, { id, field: key, node, parent });
  }
  // The siblings without the node in one pass: where it was, and where the
  // sibling it lands after or before is among the others.
  const all = T.kidsOf(s, parent);
  const next = after ?? before;
  const sibs = [];
  let was = -1;
  let i = -1;
  for (let k = 0; k < all.length; k++) {
    const sibling = all[k].id;
    if (sibling === node) {
      if (was < 0) was = k;
      continue;
    }
    if (i < 0 && sibling === next) i = sibs.length;
    sibs.push(all[k].place[3]);
  }
  let at = sibs.length;
  if (next !== undefined) {
    if (i < 0) {
      const message = `Node ${next} is not under ${parent ?? 'the root'} of field ${key} of record ${id}`;
      throw new SyncomError('NOT_FOUND', message, { id, field: key, node: next });
    }
    at = after !== undefined ? i + 1 : i;
  }
  if (was >= 0 && (at === was || parent === T.TRASH)) return null;
  if (parent !== T.TRASH) {
    const depth = (parent === null ? 0 : T.depthOf(s, parent)) + T.heightOf(s, node);
    if (depth > T.MAX_DEPTH) {
      const message = `Node ${node} of field ${key} of record ${id} would reach level ${depth}; a tree reads ${T.MAX_DEPTH}`;
      throw new SyncomError('OUT_OF_RANGE', message, { id, field: key, node, depth, max: T.MAX_DEPTH });
    }
  }
  const lower = at > 0 ? sibs[at - 1] : null;
  let upper = at < sibs.length ? sibs[at] : null;
  if (lower !== null && upper !== null && upper <= lower) {
    upper = null;
    for (let i = at + 1; i < sibs.length; i++) {
      if (sibs[i] > lower) {
        upper = sibs[i];
        break;
      }
    }
  }
  const fi = between(lower, upper);
  if (fi.length > T.MAX_FI) {
    const message = `No room left between the neighbours of node ${node} in field ${key} of record ${id}; move a sibling away or reset the field`;
    throw new SyncomError('OUT_OF_RANGE', message, {
      id,
      field: key,
      node,
      reason: 'fi',
      length: fi.length,
      max: T.MAX_FI,
    });
  }
  return { node, parent, fi };
};

// ---------------------------------------------------------------------------
// Patches: a tree's nodes in reading order with their parent and the
// sibling before; the moves that make `from` read as `to` — every child of
// a parent whose children changed, in order (the first to the end, each
// next after the one before, so the emitted order is the final one), then
// the nodes gone.

const walk = (nodes, into = new Map(), parent = null) => {
  let prev = null;
  for (const { id, children } of nodes) {
    into.set(id, { parent, prev });
    walk(children, into, id);
    prev = id;
  }
  return into;
};

const treePatches = (field, from, to) => {
  const before = walk(from);
  const after = walk(to);
  const patches = [];
  const changed = new Set();
  for (const [node, place] of after) {
    const was = before.get(node);
    if (was === undefined || was.parent !== place.parent || was.prev !== place.prev) changed.add(place.parent);
  }
  for (const [node, { parent, prev }] of after) {
    if (!changed.has(parent)) continue;
    const patch = { action: 'treeMove', field, node, parent };
    if (prev !== null) patch.after = prev;
    patches.push(patch);
  }
  for (const node of before.keys()) if (!after.has(node)) patches.push({ action: 'treeRemove', field, node });
  return patches;
};

const diff = (field, kind, from, to) => treePatches(field, from ?? [], to ?? []);
const recreate = (field, kind, value) => treePatches(field, [], value);

const realize = (action, patch, method) => {
  const { field } = patch;
  if (action === 'treeMove') {
    const parent = patch.parent ?? null;
    treeArgs(method, field, patch.node, parent, { after: patch.after, before: patch.before });
    const payload = { key: field, node: patch.node, parent };
    if (patch.after !== undefined) payload.after = patch.after;
    if (patch.before !== undefined) payload.before = patch.before;
    return ['tree', payload];
  }
  treeArgs(method, field, patch.node, null);
  return ['tree', { key: field, node: patch.node, parent: T.TRASH }];
};

// A tree comes back as one move per node it reads with, parents first, in
// order; what hangs in the trash is dropped, and so is a tree with nothing
// to read.
const migrate = (kind, key, value) => {
  const ops = [];
  const stack = [];
  for (let i = value.length - 1; i >= 0; i--) stack.push([value[i], null]);
  while (stack.length > 0) {
    const [{ id: node, children }, parent] = stack.pop();
    ops.push(['tree', { key, node, parent }]);
    for (let i = children.length - 1; i >= 0; i--) stack.push([children[i], node]);
  }
  return ops;
};

const compact = () => [];

// ---------------------------------------------------------------------------
// The storage methods, over the `core` Storage lends.

/**
 * Puts node `node` of tree field `key` under `parent` (`null`: a root) —
 * after sibling `after`, before sibling `before`, or last (a `tree` op).
 * A node the tree has not is created there; the field, and the record,
 * when absent. Two nodes moving concurrently so that each would hang
 * under the other: the newer move loses, on every node, and a later move
 * can revive it. Rejects with `CYCLE` for a parent under the node itself
 * and with `NOT_FOUND` for a sibling not under `parent`; a move to where
 * the node already is makes no op.
 */
const treeMove = async (core, id, key, node, parent = null, { after, before, actor } = {}) => {
  treeArgs('treeMove', key, node, parent, { after, before });
  const payload = { key, node, parent };
  if (after !== undefined) payload.after = after;
  if (before !== undefined) payload.before = before;
  await core.commit('tree', id, payload, { actor });
};

/**
 * Removes node `node` of tree field `key` with everything under it — a
 * move under the trash, which no reading shows. A node not yet known here
 * is created there, so a creation of it elsewhere lands removed.
 */
const treeRemove = async (core, id, key, node, { actor } = {}) => {
  treeArgs('treeRemove', key, node, null);
  await core.commit('tree', id, { key, node, parent: T.TRASH }, { actor });
};

/** The tree kind: register with `open({ plugins: [tree] })`. */
const tree = Object.freeze({
  name: 'tree',
  kinds: KINDS,
  codes: CODES,
  types: Object.freeze(['tree']),
  actions: Object.freeze(['treeMove', 'treeRemove']),
  hints: HINTS,
  takes,
  kindOfOp,
  normalize,
  apply,
  join,
  prune,
  render,
  resolve,
  diff,
  recreate,
  realize,
  migrate,
  compact,
  editors,
  nests: NESTS,
  members,
  holds,
  pick,
  nest,
  methods: Object.freeze({ treeMove, treeRemove }),
});

module.exports = { tree };
