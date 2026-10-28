'use strict';

// Marks over a text (src/text/sequence.js holds its design): the anchors of a
// range, a mark applied or switched off, and the index of the marks in force
// that a keystroke reads — the style at one character in O(log n).

const { compareClock } = require('../vector.js');
const { PENDING_MAX } = require('../plugin.js');
const T = require('./btree.js');
const P = require('./pmap.js');
const {
  END,
  HEAD,
  isJson,
  isPlaceholder,
  minStamp,
  parseAnchor,
  parseRun,
  malformed,
  refused,
  runKey,
  unchanged,
  MANY,
  OFF,
  PLACEHOLDER,
} = require('./keys.js');
const {
  STATE,
  asBlock,
  belowBase,
  ensureHead,
  pendingCount,
  runOf,
  counters,
  elemAt,
  lengthOf,
  positionOfSlot,
  sameBase,
  shownAt,
} = require('./state.js');
const { draft, finish } = require('./splice.js');

// ---- marks -----------------------------------------------------------

const EXPANDS = { before: [true, false], after: [false, true], both: [true, true], none: [false, false] };
// Removing a style grows where the style would not and the other way round
// (Loro): both ↔ none, before and after stay.
const REVERSED = { before: 'before', after: 'after', both: 'none', none: 'both' };

// The anchors of a mark over visible [start, end) under an expand rule.
const markAnchors = (block, start, end, expand) => {
  const [before, after] = EXPANDS[expand];
  const length = lengthOf(block);
  const at = (i) => elemAt(block, i);
  const from = before ? (start === 0 ? HEAD : `>${at(start - 1)}`) : start === length ? END : `<${at(start)}`;
  const to = after ? (end === length ? END : `<${at(end)}`) : end === 0 ? HEAD : `>${at(end - 1)}`;
  return [from, to];
};

// A `mark`: a new mark keyed by the op's stamp — first wins on a key — or
// `{ off }`, which flags an existing mark (or a placeholder for one not here
// yet) as removed by id. A mark that lands on its placeholder fills it in and
// stays off; the block's `ts` counts a placeholder by the id it names, so the
// two orders leave one block.
const applyMark = (given, stamp, payload, base = null, pendingMax = PENDING_MAX) => {
  const [ts, origin] = stamp;
  const seq = asBlock(given, base);
  if (seq.k !== 't' || !payload || typeof payload !== 'object') return malformed(seq);
  const st = STATE.get(seq);
  if (payload.off !== undefined) {
    const named = parseRun(payload.off);
    if (named === null) return malformed(seq);
    const held = P.get(st.marks, payload.off);
    if (held !== undefined && (held[4] & OFF) !== 0) return unchanged(seq);
    if (held === undefined) {
      if (belowBase(named.ts, named.origin, base)) return unchanged(seq);
      const n = pendingCount(seq);
      if (n >= pendingMax) return refused(seq, 'pending', n, pendingMax);
    }
    const d = draft(seq);
    const flagged = held === undefined ? [...PLACEHOLDER] : [held[0], held[1], held[2], held[3], held[4] | OFF];
    d.marks = P.set(d.marks, payload.off, flagged);
    // A mark in force switched off leaves the index; a placeholder was never in it.
    if (held !== undefined) d.marksIndex = withoutMark(d.marksIndex, payload.off);
    d.ts = Math.max(d.ts, named.ts);
    d.oldest = minStamp(d.oldest, [named.ts, named.origin]);
    return { seq: finish(d), changed: true, reason: null };
  }
  const { start, end, key, value, many } = payload;
  const a = parseAnchor(start);
  const b = parseAnchor(end);
  const okAnchor = (x) => x !== null && (x.elem === null || x.elem.ts < ts);
  if (!okAnchor(a) || !okAnchor(b) || typeof key !== 'string' || !isJson(value) || value === undefined) {
    return malformed(seq);
  }
  if (many !== undefined && many !== true) return malformed(seq);
  const id = runKey(ts, origin);
  const held = P.get(st.marks, id);
  if (held !== undefined && !isPlaceholder(held)) return unchanged(seq);
  const d = draft(seq);
  const mark = [start, end, key, value, (many ? MANY : 0) | (held === undefined ? 0 : OFF)];
  d.marks = P.set(d.marks, id, mark);
  // A mark that lands on its placeholder stays off: the index holds the marks in force.
  if (held === undefined) d.marksIndex = withMark(d, d.marksIndex, id, mark, base);
  d.ts = Math.max(d.ts, ts);
  d.oldest = minStamp(d.oldest, [ts, origin]);
  return { seq: finish(d), changed: true, reason: null };
};

/** The mark `id` of a text's block — `[from, to, key, value, flags]` — or undefined. */
const markOf = (block, id) => (typeof id === 'string' ? P.get(STATE.get(block).marks, id) : undefined);

// ---- the index of the marks ------------------------------------------------
//
// What a keystroke into a marked text asks — the style at one character
// (`styleAt`, an insert's change report), the marks of a key newer than an
// arriving one (`newerRanges`) — answered without reading every mark. The
// index keeps the anchors of the marks in force sorted in walk order. An
// anchor is a boundary beside a slot — `>e` right after `e`, `<e` right
// before it, the head, the end — and the slots never change order: an op
// adds slots between them and a cut leaves its slots as gaps. So an order
// made once holds for every version after it, whatever is typed, and an op
// that leaves the marks hands the index on as it is (`draft`). As a number,
// an anchor at ordinal o is 2o + 1 before a slot and 2o after one (the head
// 0, the end 2·total + 1): two anchors of one number name one boundary for
// good, and a slot inserted at o goes between the two kinds.
//
// A mark changes it by one insertion or removal (`withMark`, `withoutMark`:
// O(anchors) copied as flat arrays, O(log anchors × log n) read from the
// rope); the run an anchor waited for arriving, a reset or another base drop
// it, and the next query makes it again (O(anchors × log n)). A query reads
// the ordinals of O(log anchors) anchors from the rope to count those at or
// before a character — `p` — and the marks in force there are those that
// open below `p` and close at or past it: a max segment tree over the
// opening anchors in order, each node the latest close under it, gives them
// in O(k log m). Per key, the marks in stamp order, the newest last.

// An anchor as the index keeps it: the slot it is beside (`run`, `offset`)
// and on which side (`after`), or `run` null for the head (after) and the end
// (before) — an anchor below the base reads as the head; null while its slot
// is not placed here (`waits` names the run).
const anchorEnd = (st, token, base, m, open, waits) => {
  if (token === HEAD) return { m, open, run: null, offset: 0, after: true };
  if (token === END) return { m, open, run: null, offset: 0, after: false };
  const { side, elem } = parseAnchor(token);
  if (belowBase(elem.ts, elem.origin, base)) return { m, open, run: null, offset: 0, after: true };
  const run = runOf(st, elem.run);
  if (run === undefined || !run.placed || elem.offset >= run.len) {
    waits.add(elem.run);
    return null;
  }
  return { m, open, run: elem.run, offset: elem.offset, after: side === 'R' };
};

// An anchor's place in the current version, as a number (the head's hints).
const endKey = (st, end) => {
  counters.anchorReads++;
  if (end.run === null) return end.after ? 0 : 2 * st.root.s + 1;
  return 2 * positionOfSlot(st, runOf(st, end.run), end.offset).s + (end.after ? 2 : 1);
};

// A mark as the index holds it; `n` numbers it within the index (below
// `next`), so a pass over the anchors finds a mark's close without a map.
const markEntry = (id, mark, n) => {
  const { ts, origin } = parseRun(id);
  const many = (mark[4] & MANY) !== 0;
  return { id, n, ts, origin, from: mark[0], to: mark[1], key: mark[2], value: mark[3], many };
};

// The search part of an index over its sorted anchors: the opening anchors
// in order (`opens`, with where each opens, `A`) and a max segment tree over
// where each closes (`tree`, its leaves from `size` on, -1 past the last).
const searchOf = (ends, next) => {
  const closeAt = new Int32Array(next);
  for (let i = 0; i < ends.length; i++) if (!ends[i].open) closeAt[ends[i].m.n] = i;
  const count = ends.length >> 1;
  let size = 1;
  while (size < count) size <<= 1;
  const tree = new Int32Array(2 * size).fill(-1);
  const opens = [];
  const A = new Int32Array(count);
  for (let i = 0; i < ends.length; i++) {
    if (!ends[i].open) continue;
    A[opens.length] = i;
    tree[size + opens.length] = closeAt[ends[i].m.n];
    opens.push(ends[i].m);
  }
  for (let i = size - 1; i >= 1; i--) tree[i] = Math.max(tree[2 * i], tree[2 * i + 1]);
  return { opens, A, tree, size };
};

// The marks of a key in stamp order, `entry` among them.
const byStamp = (x, y) => compareClock([x.ts, x.origin], [y.ts, y.origin]);
const keyedWith = (byKey, entry) => {
  const out = new Map(byKey);
  const held = byKey.get(entry.key);
  const list = held === undefined ? [] : held.slice();
  let i = list.length;
  while (i > 0 && byStamp(list[i - 1], entry) > 0) i--;
  list.splice(i, 0, entry);
  out.set(entry.key, list);
  return out;
};

// The index of the marks in force of a version, made whole: every anchor
// placed, sorted by its number.
const buildMarks = (st, base) => {
  counters.markIndexes++;
  const waits = new Set();
  const ends = [];
  const keys = [];
  const byKey = new Map();
  let next = 0;
  for (const [id, mark] of P.entries(st.marks)) {
    if ((mark[4] & OFF) !== 0) continue;
    const m = markEntry(id, mark, next);
    const from = anchorEnd(st, m.from, base, m, true, waits);
    const to = anchorEnd(st, m.to, base, m, false, waits);
    if (from === null || to === null) continue;
    next++;
    ends.push(from, to);
    keys.push(endKey(st, from), endKey(st, to));
    const list = byKey.get(m.key);
    if (list === undefined) byKey.set(m.key, [m]);
    else list.push(m);
  }
  const order = [];
  for (let i = 0; i < ends.length; i++) order.push(i);
  order.sort((x, y) => keys[x] - keys[y]);
  const sorted = [];
  for (let i = 0; i < order.length; i++) sorted.push(ends[order[i]]);
  for (const list of byKey.values()) list.sort(byStamp);
  return { base, ends: sorted, byKey, waits, next, ...searchOf(sorted, next) };
};

// Where an anchor of number `key` goes among the sorted anchors: after
// every one at or below it.
const insertionOf = (st, ends, key) => {
  let lo = 0;
  let hi = ends.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (endKey(st, ends[mid]) <= key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

// The index with mark `id` in force added — over the draft of the op that
// makes it, whose rope is the version's; null when there was none to add to.
const withMark = (d, index, id, mark, base) => {
  if (index === null || !sameBase(index.base, base)) return null;
  const m = markEntry(id, mark, index.next);
  const waits = new Set();
  const from = anchorEnd(d, m.from, base, m, true, waits);
  const to = anchorEnd(d, m.to, base, m, false, waits);
  if (from === null || to === null) {
    // Waiting for an anchor: in the index once its run is here.
    for (const run of index.waits) waits.add(run);
    return { ...index, waits };
  }
  const ends = index.ends.slice();
  const a = endKey(d, from);
  const b = endKey(d, to);
  ends.splice(insertionOf(d, ends, a), 0, from);
  ends.splice(insertionOf(d, ends, b), 0, to);
  const next = index.next + 1;
  return { base, ends, byKey: keyedWith(index.byKey, m), waits: index.waits, next, ...searchOf(ends, next) };
};

// The index with mark `id` switched off.
const withoutMark = (index, id) => {
  if (index === null) return null;
  const ends = [];
  let entry = null;
  for (const end of index.ends) {
    if (end.m.id === id) entry = end.m;
    else ends.push(end);
  }
  if (entry === null) return index;
  const byKey = new Map(index.byKey);
  const list = [];
  for (const m of byKey.get(entry.key)) if (m !== entry) list.push(m);
  if (list.length > 0) byKey.set(entry.key, list);
  else byKey.delete(entry.key);
  const { base, waits, next } = index;
  return { base, ends, byKey, waits, next, ...searchOf(ends, next) };
};

// The head version's index for `base`, made when it has none.
const marksIndexOf = (st, base) => {
  if (st.marksIndex === null || !sameBase(st.marksIndex.base, base)) st.marksIndex = buildMarks(st, base);
  return st.marksIndex;
};

// The marks in force at the slot of ordinal `ordinal`: opened at or below
// it, closed past it.
const marksOver = (st, index, ordinal) => {
  const { ends, opens, A, tree, size } = index;
  // How many anchors lie at or before the slot: numbers up to 2·ordinal + 1.
  const p = insertionOf(st, ends, 2 * ordinal + 1);
  // How many marks open below `p`: a prefix of `opens`.
  let count = 0;
  let top = opens.length;
  while (count < top) {
    const mid = (count + top) >> 1;
    if (A[mid] < p) count = mid + 1;
    else top = mid;
  }
  // Of those, the ones that close at or past `p`: down the tree where the
  // latest close under a node reaches it, within the prefix.
  const out = [];
  const stack = [1, 0, size];
  while (stack.length > 0) {
    const width = stack.pop();
    const from = stack.pop();
    const node = stack.pop();
    if (from >= count || tree[node] < p) continue;
    if (width === 1) {
      out.push(opens[from]);
      continue;
    }
    const half = width >> 1;
    stack.push(2 * node + 1, from + half, half, 2 * node, from, half);
  }
  return out;
};

// Marks by key, then by stamp: the order their values are laid over one
// another in, so the newest of a key wins.
const byKeyThenStamp = (x, y) =>
  x.key < y.key ? -1 : x.key > y.key ? 1 : compareClock([x.ts, x.origin], [y.ts, y.origin]);

// The style of the marks in force at one point: per key the newest value,
// none when null; MANY marks list as `{ id, value }`, the ones newer than
// the key's newest plain mark. `stacked` tells a stack from a plain value
// that is an array — never pushed into, it is the block's own.
const styleOf = (active) => {
  let marks = null;
  const stacked = new Set();
  for (const m of [...active].sort(byKeyThenStamp)) {
    marks ??= {};
    if (m.many) {
      if (!stacked.has(m.key)) {
        stacked.add(m.key);
        marks[m.key] = [];
      }
      marks[m.key].push({ id: m.id, value: m.value });
      continue;
    }
    stacked.delete(m.key);
    if (m.value === null) delete marks[m.key];
    else marks[m.key] = m.value;
  }
  return marks && Object.keys(marks).length > 0 ? marks : null;
};

/**
 * The style of the visible element at `index` — what `spans()` reads there:
 * per key the newest value, a stack listed — or null with none. O(log m ×
 * log n + k) over the index of the marks (made once, kept across the ops
 * that leave the marks): what a change report reads an insert's marks
 * with, never a walk and never every mark.
 */
const styleAt = (block, index, base = null) => {
  if (STATE.get(block).marks.size === 0) return null;
  const st = ensureHead(block);
  if (!Number.isInteger(index) || index < 0 || index >= st.root.v) return null;
  const found = shownAt(st, index);
  const offset = found.item.off + (index - found.v);
  const ordinal = positionOfSlot(st, runOf(st, found.item.run), offset).s;
  const active = marksOver(st, marksIndexOf(st, base), ordinal);
  return active.length === 0 ? null : styleOf(active);
};

// Where an anchor of the index stands in the reading: the visible slots
// before it — as a cursor there reads (`indexOfCursor`).
const visibleOfEnd = (st, end) => {
  if (end.run === null) return end.after ? 0 : st.root.v;
  const at = positionOfSlot(st, runOf(st, end.run), end.offset);
  return at.v + (end.after && at.vis ? 1 : 0);
};

// Where a mark of `key` stamped `stamp` does not decide the reading: the
// visible ranges `[start, end)` of the marks of the key in force that are
// newer — any newer one replaces a plain mark, a newer plain one a stacked
// mark (styleOf) — sorted by start. O(newer × log n) over the index's marks
// of the key in stamp order: a change report reads it, so a peer's older
// mark is never reported over text a newer one holds — and a mark made
// here, the newest, reads none.
const newerRanges = (block, key, stamp, stacked, base = null) => {
  const out = [];
  if (STATE.get(block).marks.size === 0) return out;
  const st = ensureHead(block);
  const index = marksIndexOf(st, base);
  const list = index.byKey.get(key);
  if (list === undefined) return out;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (compareClock([m.ts, m.origin], stamp) <= 0) break;
    if (stacked && m.many) continue;
    const from = anchorEnd(st, m.from, base, m, true, NO_WAITS);
    const to = anchorEnd(st, m.to, base, m, false, NO_WAITS);
    if (from === null || to === null) continue;
    const start = visibleOfEnd(st, from);
    const end = visibleOfEnd(st, to);
    if (start < end) out.push([start, end]);
  }
  return out.sort((x, y) => x[0] - y[0]);
};

// Where a reading that only asks puts the runs an anchor waits for: nowhere.
const NO_WAITS = Object.freeze({ add: () => {} });

// The ordinal of every anchor the marks name, and the ordinal and visible
// index of every visible slot — read in one walk of the rope, no hints, so
// a block of any version reads its spans.
const walkMarks = (block, base) => {
  const st = STATE.get(block);
  const wanted = new Map(); // "run:offset" → ordinal of the slot, filled by the walk
  const marks = [];
  for (const [id, mark] of P.entries(st.marks)) {
    const [from, to, key, value, flags] = mark;
    if ((flags & OFF) !== 0) continue;
    const { ts, origin } = parseRun(id);
    marks.push({ id, ts, origin, from, to, key, value, many: (flags & MANY) !== 0 });
    for (const token of [from, to]) {
      if (token === HEAD || token === END) continue;
      const { elem } = parseAnchor(token);
      if (belowBase(elem.ts, elem.origin, base)) continue;
      wanted.set(`${elem.run}:${elem.offset}`, null);
    }
  }
  const ords = [];
  let ord = 0;
  for (const item of T.iterate(st.root)) {
    if (item.fence !== undefined) continue;
    if (wanted.size > 0) {
      for (let k = 0; k < item.len; k++) {
        const name = `${item.run}:${item.off + k}`;
        if (wanted.has(name)) wanted.set(name, ord + k);
      }
    }
    if (item.vis) for (let k = 0; k < item.len; k++) ords.push(ord + k);
    ord += item.len;
  }
  const ordinalOf = (token) => {
    if (token === HEAD) return 0;
    if (token === END) return ord;
    const { side, elem } = parseAnchor(token);
    if (belowBase(elem.ts, elem.origin, base)) return 0;
    const at = wanted.get(`${elem.run}:${elem.offset}`);
    if (at === null || at === undefined) return null;
    return at + (side === 'L' ? 0 : 1);
  };
  return { marks, ords, ordinalOf, total: ord };
};

// The marks in force over the reading, as the calls that would make them
// again: a visible range `[start, end)`, the expand rule the sides of the
// anchors say (a start after an element, or the head, takes text typed at
// it; an end before an element, or the end, does too), the key, the value
// and whether it stacks — in stamp order, so laid again they resolve as
// before. A mark switched off, not anchored yet, or over no visible
// character is left out. What `compact()` lays again over a text.
const marksIn = (block, seq = block, base = null) => {
  const length = lengthOf(block);
  if (length === 0 || STATE.get(block).marks.size === 0) return [];
  const { marks, ords, ordinalOf } = walkMarks(block, base);
  // How many visible characters sit below an ordinal: they read in ordinal order.
  const below = (ordinal) => {
    let lo = 0;
    let hi = length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ords[mid] < ordinal) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const out = [];
  for (const m of marks) {
    const lo = ordinalOf(m.from);
    const hi = ordinalOf(m.to);
    if (lo === null || hi === null || lo >= hi) continue;
    const start = below(lo);
    const end = below(hi);
    if (start >= end) continue;
    const before = m.from === HEAD || m.from[0] === '>';
    const after = m.to === END || m.to[0] === '<';
    const expand = before ? (after ? 'both' : 'before') : after ? 'after' : 'none';
    out.push({ ts: m.ts, origin: m.origin, start, end, key: m.key, value: m.value, expand, many: m.many });
  }
  return out.sort((x, y) => compareClock([x.ts, x.origin], [y.ts, y.origin]));
};

// The text as runs of equal style: `[{ text, marks }]`. A mark whose anchor
// has not arrived is not shown yet. A sweep over the walk: each mark opens at
// its first ordinal and closes at its last, the visible characters come in
// ordinal order, and the style is read again only where a mark opened or
// closed — O(characters + marks × active), not O(characters × marks).
const spans = (block, seq = block, base = null) => {
  const st = STATE.get(block);
  const length = st.root.v;
  if (length === 0) return [];
  const { marks, ords, ordinalOf } = walkMarks(block, base);
  const events = [];
  for (const m of marks) {
    const lo = ordinalOf(m.from);
    const hi = ordinalOf(m.to);
    if (lo === null || hi === null || lo >= hi) continue;
    const mark = { id: m.id, ts: m.ts, origin: m.origin, key: m.key, value: m.value, many: m.many };
    events.push([lo, 1, mark], [hi, -1, mark]);
  }
  // Closes before opens at one ordinal: `hi` is exclusive.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const active = new Set();
  const out = [];
  let e = 0;
  let style = null;
  let text = '';
  let i = 0;
  for (const item of T.iterate(st.root)) {
    if (!item.vis) continue;
    for (let k = 0; k < item.len; k++, i++) {
      const ordinal = ords[i];
      let moved = false;
      while (e < events.length && events[e][0] <= ordinal) {
        const [, kind, mark] = events[e++];
        if (kind === 1) active.add(mark);
        else active.delete(mark);
        moved = true;
      }
      if (moved) {
        const nextStyle = styleOf(active);
        if (text.length > 0 && JSON.stringify(nextStyle) !== JSON.stringify(style)) {
          out.push({ text, marks: style ?? {} });
          text = '';
        }
        style = nextStyle;
      }
      text += item.body[k];
    }
  }
  out.push({ text, marks: style ?? {} });
  return out;
};

module.exports = {
  REVERSED,
  markAnchors,
  applyMark,
  markOf,
  styleAt,
  newerRanges,
  marksIn,
  spans,
};
