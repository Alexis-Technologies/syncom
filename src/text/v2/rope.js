'use strict';

// The rope of the v2 sequence engine: a copy-on-write B+-tree with two
// measures over the walk of a block. Its leaves hold SPANS in walk order — a stretch of one run's slots
// that read alike (`len` slots, `vis` when they show, `body` the items or null for a gap) or a FENCE,
// the open (1) or the close (2) of a run's subtree, no slots. A node's `s` is the slots under it, its `v`
// the visible ones, so a visible index, a slot ordinal and the span at either are found from the root
// in O(log n), and a span's place is read from below through the HINTS — a span's leaf, a node's parent.
//
// A node carries the OWNER that made it (./cow.js): a tree is written through a holder — `{ root,
// owner, frozen, walked }`, the state of a block — and a write makes the path from the
// span to the root the holder's first, copying each node of it that is not (the copy rewrites the hints
// of what it holds), then edits the leaf in place and hands the change of the measures up the parents
// as a delta. So a version handed out never changes, and an op copies each node it touches once.
//
// The hints are right for the version written last. A reading from below checks them as it climbs —
// each node one of its parent's children, the top the holder's root — and where they do not hold, a
// version still written to (a head) sets them again for its tree, once (`rehints`); a frozen version
// reads its places from one walk of its own, kept (`walked`), and never writes a hint. A reading from
// the root down — a locate, a cursor, an iteration, the text — reads no hint. The rule behind the shape
// is Loro's ordered index (THIRD_PARTY_NOTICES.md), as a rule: measures on the way down, hints on the
// way up. No requires.

const MAX = 32;

class Span {
  constructor(run, off, len, vis, body, fence, owner) {
    this.run = run;
    this.off = off;
    this.len = len;
    this.vis = vis;
    this.body = body;
    this.fence = fence;
    this.node = null;
    this.owner = owner;
  }
}

// A node of the tree: a leaf's `kids` are spans, an inner node's are nodes.
class Node {
  constructor(leaf, kids, owner) {
    this.leaf = leaf;
    this.kids = kids;
    this.s = 0;
    this.v = 0;
    this.parent = null;
    this.owner = owner;
    this.text = null;
  }
}

const visibleOf = (span) => (span.vis ? span.len : 0);

const counters = { rehints: 0, walks: 0 };

// The measures of a node from what it holds, and the hints of what it holds set to it.
const adopt = (node) => {
  let s = 0;
  let v = 0;
  const { kids } = node;
  if (node.leaf) {
    for (let i = 0; i < kids.length; i++) {
      const span = kids[i];
      span.node = node;
      s += span.len;
      v += span.vis ? span.len : 0;
    }
  } else {
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      child.parent = node;
      s += child.s;
      v += child.v;
    }
  }
  node.s = s;
  node.v = v;
  node.text = null;
  return node;
};

// `list` cut into nodes of at most MAX, as even as they come.
const nodesOf = (list, leaf, owner) => {
  const count = Math.ceil(list.length / MAX);
  const size = Math.ceil(list.length / count);
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(adopt(new Node(leaf, list.slice(i, i + size), owner)));
  return out;
};

/** The tree of `spans`, in order, made `owner`'s: bottom-up, O(n). No spans is an empty leaf. */
const fromSpans = (spans, owner) => {
  if (spans.length === 0) return adopt(new Node(true, [], owner));
  let level = nodesOf(spans, true, owner);
  while (level.length > 1) level = nodesOf(level, false, owner);
  return level[0];
};

// ---- going down -----------------------------------------------------------------------------------

// A cursor: the path from the root to a span, and the span's place in slots and visible slots. `next`
// walks it on one span in amortized O(1); nothing here reads a hint.
class Cursor {
  constructor() {
    this.nodes = [];
    this.at = [];
    this.span = null;
    this.s = 0;
    this.v = 0;
  }
}

/**
 * The cursor at the span covering unit `at` of the visible slots (`visible`) or of every slot: the first
 * whose units reach past `at`, with the measures before it. Null past the end.
 */
const locate = (root, visible, at) => {
  if (at < 0 || at >= (visible ? root.v : root.s)) return null;
  const cursor = new Cursor();
  let node = root;
  let s = 0;
  let v = 0;
  while (!node.leaf) {
    const { kids } = node;
    let i = 0;
    for (; i < kids.length - 1; i++) {
      const units = visible ? kids[i].v : kids[i].s;
      if (at < units) break;
      at -= units;
      s += kids[i].s;
      v += kids[i].v;
    }
    cursor.nodes.push(node);
    cursor.at.push(i);
    node = kids[i];
  }
  const { kids } = node;
  for (let i = 0; i < kids.length; i++) {
    const span = kids[i];
    const units = visible ? visibleOf(span) : span.len;
    if (at < units) {
      cursor.nodes.push(node);
      cursor.at.push(i);
      cursor.span = span;
      cursor.s = s;
      cursor.v = v;
      return cursor;
    }
    at -= units;
    s += span.len;
    v += visibleOf(span);
  }
  return null;
};

// What `find` found: the span and the measures before it (one per call: read at once).
class Place {
  constructor() {
    this.span = null;
    this.s = 0;
    this.v = 0;
  }
}
const PLACE = new Place();

/** The span covering unit `at` with the measures before it — `PLACE`, read before the next call — or null. */
const find = (root, visible, at) => {
  if (at < 0 || at >= (visible ? root.v : root.s)) return null;
  let node = root;
  let s = 0;
  let v = 0;
  while (!node.leaf) {
    const { kids } = node;
    let i = 0;
    for (; i < kids.length - 1; i++) {
      const units = visible ? kids[i].v : kids[i].s;
      if (at < units) break;
      at -= units;
      s += kids[i].s;
      v += kids[i].v;
    }
    node = kids[i];
  }
  const { kids } = node;
  for (let i = 0; i < kids.length; i++) {
    const span = kids[i];
    const units = visible ? visibleOf(span) : span.len;
    if (at < units) {
      PLACE.span = span;
      PLACE.s = s;
      PLACE.v = v;
      return PLACE;
    }
    at -= units;
    s += span.len;
    v += visibleOf(span);
  }
  return null;
};

/** The cursor at the first span, or null for an empty tree. */
const first = (root) => {
  const cursor = new Cursor();
  let node = root;
  while (!node.leaf) {
    cursor.nodes.push(node);
    cursor.at.push(0);
    node = node.kids[0];
  }
  if (node.kids.length === 0) return null;
  cursor.nodes.push(node);
  cursor.at.push(0);
  cursor.span = node.kids[0];
  return cursor;
};

/** Moves the cursor to the next span; null at the end (the cursor is then spent). */
const next = (cursor) => {
  const { nodes, at } = cursor;
  const span = cursor.span;
  cursor.s += span.len;
  cursor.v += visibleOf(span);
  let top = nodes.length - 1;
  if (at[top] + 1 < nodes[top].kids.length) {
    at[top]++;
    cursor.span = nodes[top].kids[at[top]];
    return cursor.span;
  }
  nodes.pop();
  at.pop();
  top--;
  while (top >= 0) {
    if (at[top] + 1 < nodes[top].kids.length) {
      at[top]++;
      let node = nodes[top].kids[at[top]];
      while (!node.leaf) {
        nodes.push(node);
        at.push(0);
        node = node.kids[0];
      }
      nodes.push(node);
      at.push(0);
      cursor.span = node.kids[0];
      return cursor.span;
    }
    nodes.pop();
    at.pop();
    top--;
  }
  cursor.span = null;
  return null;
};

/** Every span in order, as one array. */
const spansOf = (root) => {
  const out = [];
  const cursor = first(root);
  if (cursor === null) return out;
  for (let span = cursor.span; span !== null; span = next(cursor)) out.push(span);
  return out;
};

// The visible bodies under `node` as one string, kept on the node: after an edit only the path written
// concatenates again — a leaf's bodies and the levels above alike, a rope in V8 until it is read, so
// the whole is never copied here (a join would copy).
const textOf = (node) => {
  if (node.text !== null) return node.text;
  let out = '';
  const { kids } = node;
  if (node.leaf) {
    for (let i = 0; i < kids.length; i++) if (kids[i].vis) out += kids[i].body;
  } else for (let i = 0; i < kids.length; i++) out += textOf(kids[i]);
  node.text = out;
  return out;
};

/** The visible bodies of the tree in order, as one string — a text's reading, O(log n) after an edit. */
const text = (root) => textOf(root);

// ---- going up -------------------------------------------------------------------------------------

// The path a climb found, leaf first: PATH[k] a node, AT[k] where the one below it (the span, for the
// leaf) stands among its kids. Read at once, before the next climb.
const PATH = [];
const AT = [];

// The levels from `span` to `root` through the hints, filled into PATH/AT; -1 where they do not lead
// there.
const climb = (root, span) => {
  let node = span.node;
  if (node === null) return -1;
  let i = node.kids.indexOf(span);
  if (i === -1) return -1;
  let depth = 0;
  PATH[0] = node;
  AT[0] = i;
  while (node.parent !== null) {
    const parent = node.parent;
    i = parent.kids.indexOf(node);
    if (i === -1) return -1;
    depth++;
    PATH[depth] = parent;
    AT[depth] = i;
    node = parent;
  }
  return node === root ? depth + 1 : -1;
};

// Every hint of the tree set again: the parents, the leaves of the spans.
const rehint = (root) => {
  counters.rehints++;
  root.parent = null;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    const { kids } = node;
    if (node.leaf) for (let i = 0; i < kids.length; i++) kids[i].node = node;
    else {
      for (let i = 0; i < kids.length; i++) {
        kids[i].parent = node;
        stack.push(kids[i]);
      }
    }
  }
};

// The levels of `span` in the tree of `holder`, the hints set again when they do not lead there.
const levelsOf = (holder, span) => {
  const levels = climb(holder.root, span);
  if (levels !== -1) return levels;
  rehint(holder.root);
  return climb(holder.root, span);
};

// The place of every span of a frozen version, from one walk: slots and visible slots before it.
const walkedOf = (holder) => {
  if (holder.walked !== null) return holder.walked;
  counters.walks++;
  const out = new Map();
  const cursor = first(holder.root);
  if (cursor !== null) {
    for (let span = cursor.span; span !== null; span = next(cursor)) out.set(span, [cursor.s, cursor.v]);
  }
  holder.walked = out;
  return out;
};

/**
 * The slots and visible slots before `span` in the tree of `holder` (`PLACE`, read at once): through the
 * hints where they hold; else by setting them again (a head) or from the version's own walk (frozen).
 */
const positionOf = (holder, span) => {
  let levels = climb(holder.root, span);
  if (levels === -1) {
    if (holder.frozen) {
      const at = walkedOf(holder).get(span);
      PLACE.span = span;
      PLACE.s = at[0];
      PLACE.v = at[1];
      return PLACE;
    }
    rehint(holder.root);
    levels = climb(holder.root, span);
  }
  let s = 0;
  let v = 0;
  for (let k = 0; k < levels; k++) {
    const { kids } = PATH[k];
    const leaf = k === 0;
    for (let i = 0; i < AT[k]; i++) {
      if (leaf) {
        s += kids[i].len;
        v += visibleOf(kids[i]);
      } else {
        s += kids[i].s;
        v += kids[i].v;
      }
    }
  }
  PLACE.span = span;
  PLACE.s = s;
  PLACE.v = v;
  return PLACE;
};

// The last span under `node`, or its first.
const lastUnder = (node) => {
  while (!node.leaf) node = node.kids[node.kids.length - 1];
  return node.kids[node.kids.length - 1];
};
const firstUnder = (node) => {
  while (!node.leaf) node = node.kids[0];
  return node.kids[0];
};

/** The span before `span` in the tree of `holder` (a head), or null. */
const before = (holder, span) => {
  const levels = levelsOf(holder, span);
  if (AT[0] > 0) return PATH[0].kids[AT[0] - 1];
  for (let k = 1; k < levels; k++) if (AT[k] > 0) return lastUnder(PATH[k].kids[AT[k] - 1]);
  return null;
};

/** The span after `span` in the tree of `holder` (a head), or null. */
const after = (holder, span) => {
  const levels = levelsOf(holder, span);
  if (AT[0] + 1 < PATH[0].kids.length) return PATH[0].kids[AT[0] + 1];
  for (let k = 1; k < levels; k++) if (AT[k] + 1 < PATH[k].kids.length) return firstUnder(PATH[k].kids[AT[k] + 1]);
  return null;
};

// ---- writing --------------------------------------------------------------------------------------

// A node made `owner`'s: itself when it is, else a copy holding what it holds, the hints of that told.
const copyOf = (node, owner) => {
  const copy = new Node(node.leaf, node.kids.slice(), owner);
  copy.s = node.s;
  copy.v = node.v;
  copy.parent = node.parent;
  const { kids } = copy;
  if (copy.leaf) for (let i = 0; i < kids.length; i++) kids[i].node = copy;
  else for (let i = 0; i < kids.length; i++) kids[i].parent = copy;
  return copy;
};

// The path PATH[0..levels) made the holder's, top down: each node copied unless it is the holder's.
const own = (holder, levels) => {
  const { owner } = holder;
  let top = PATH[levels - 1];
  if (top.owner !== owner) {
    top = copyOf(top, owner);
    top.parent = null;
    holder.root = top;
    PATH[levels - 1] = top;
  }
  for (let k = levels - 2; k >= 0; k--) {
    const node = PATH[k];
    if (node.owner === owner) continue;
    const copy = copyOf(node, owner);
    const parent = PATH[k + 1];
    parent.kids[AT[k + 1]] = copy;
    copy.parent = parent;
    PATH[k] = copy;
  }
};

// `items` in place of `remove` kids of `list` from `at`.
const spliceIn = (list, at, remove, items) => {
  const n = list.length;
  const delta = items.length - remove;
  if (delta > 0) {
    for (let k = 0; k < delta; k++) list.push(null);
    for (let j = n - 1; j >= at + remove; j--) list[j + delta] = list[j];
  } else if (delta < 0) {
    for (let j = at + remove; j < n; j++) list[j + delta] = list[j];
    list.length = n + delta;
  }
  for (let k = 0; k < items.length; k++) list[at + k] = items[k];
};

// After the leaf PATH[0] changed: a node past MAX split, its pieces beside it in its parent; a node left
// with nothing dropped from its parent; the root grown a level, or an empty leaf.
const fix = (holder, levels) => {
  const { owner } = holder;
  for (let k = 0; k < levels; k++) {
    const node = PATH[k];
    const n = node.kids.length;
    if (n > MAX) {
      const pieces = nodesOf(node.kids, node.leaf, owner);
      // The first piece's kids go back into the node, so its parent's slot keeps it.
      node.kids = pieces[0].kids;
      adopt(node);
      pieces[0] = node;
      if (k === levels - 1) {
        holder.root = adopt(new Node(false, pieces, owner));
        holder.root.parent = null;
        return;
      }
      const parent = PATH[k + 1];
      const rest = pieces.slice(1);
      spliceIn(parent.kids, AT[k + 1] + 1, 0, rest);
      for (let i = 0; i < rest.length; i++) rest[i].parent = parent;
      continue;
    }
    if (n === 0 && k < levels - 1) {
      spliceIn(PATH[k + 1].kids, AT[k + 1], 1, []);
      continue;
    }
    if (n === 0 && !node.leaf) holder.root = adopt(new Node(true, [], owner));
    return;
  }
};

// `items` in place of `remove` spans of the leaf of `span` from `span`'s place + `shift`.
const edit = (holder, span, shift, remove, items) => {
  const levels = levelsOf(holder, span);
  own(holder, levels);
  const leaf = PATH[0];
  const at = AT[0] + shift;
  let ds = 0;
  let dv = 0;
  for (let i = at; i < at + remove; i++) {
    ds -= leaf.kids[i].len;
    dv -= visibleOf(leaf.kids[i]);
  }
  for (let i = 0; i < items.length; i++) {
    items[i].node = leaf;
    ds += items[i].len;
    dv += visibleOf(items[i]);
  }
  spliceIn(leaf.kids, at, remove, items);
  for (let k = 0; k < levels; k++) {
    const node = PATH[k];
    node.s += ds;
    node.v += dv;
    node.text = null;
  }
  fix(holder, levels);
};

/** `items` inserted before `span` in the tree of `holder`. */
const insertBefore = (holder, span, items) => edit(holder, span, 0, 0, items);
/** `items` inserted after `span`. */
const insertAfter = (holder, span, items) => edit(holder, span, 1, 0, items);
/** `span` replaced by `items` — none to remove it. */
const replace = (holder, span, items) => edit(holder, span, 0, 1, items);

/** What the trees counted: `rehints` (hints set again for a head), `walks` (a frozen version's places). */
const stats = () => ({ rehints: counters.rehints, walks: counters.walks });

/** The depth of a tree and whether every node within MAX: for a test. */
const shapeOf = (root) => {
  let depth = 1;
  for (let node = root; !node.leaf; node = node.kids[0]) depth++;
  return depth;
};

module.exports = {
  MAX,
  Span,
  fromSpans,
  locate,
  find,
  first,
  next,
  spansOf,
  text,
  positionOf,
  before,
  after,
  insertBefore,
  insertAfter,
  replace,
  rehint,
  stats,
  shapeOf,
};
