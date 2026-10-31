'use strict';

// Marks over a text in the v2 engine (./sequence.js holds its design): the anchors of a range, a mark
// applied or switched off, and the index of the marks in force that a keystroke reads — the style at one
// character in O(log n). The rule and the index are v1's (its header says them), over the v2 rope.

const { compareClock } = require('../vector.js');
const { PENDING_MAX } = require('../plugin.js');
const R = require('./rope.js');
const C = require('./cow.js');
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
  draft,
  finish,
  pendingCount,
  runOf,
  counters,
  elemAt,
  lengthOf,
  positionOfSlot,
  sameBase,
} = require('./state.js');

const EXPANDS = { before: [true, false], after: [false, true], both: [true, true], none: [false, false] };
// Removing a style grows where the style would not and the other way round (Loro): both ↔ none.
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

// A `mark`: a new mark keyed by the op's stamp — first wins on a key — or `{ off }`, which flags an
// existing mark (or a placeholder for one not here yet) as removed by id.
const applyMark = (given, stamp, payload, base = null, pendingMax = PENDING_MAX) => {
  const [ts, origin] = stamp;
  const seq = asBlock(given, base);
  if (seq.k !== 't' || !payload || typeof payload !== 'object') return malformed(seq);
  const st = STATE.get(seq);
  if (payload.off !== undefined) {
    const named = parseRun(payload.off);
    if (named === null) return malformed(seq);
    const held = C.get(st.marks, payload.off);
    if (held !== undefined && (held[4] & OFF) !== 0) return unchanged(seq);
    if (held === undefined) {
      if (belowBase(named.ts, named.origin, base)) return unchanged(seq);
      const n = pendingCount(seq);
      if (n >= pendingMax) return refused(seq, 'pending', n, pendingMax);
    }
    const d = draft(seq);
    const flagged = held === undefined ? PLACEHOLDER.slice() : [held[0], held[1], held[2], held[3], held[4] | OFF];
    d.marks = C.set(d.marks, payload.off, flagged, d.owner);
    // A placeholder is pending work, counted as it comes; a mark here leaves the index.
    if (held === undefined) d.pendingMarks++;
    else d.marksIndex = withoutMark(d.marksIndex, payload.off);
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
  const held = C.get(st.marks, id);
  if (held !== undefined && !isPlaceholder(held)) return unchanged(seq);
  const d = draft(seq);
  const mark = [start, end, key, value, (many ? MANY : 0) | (held === undefined ? 0 : OFF)];
  d.marks = C.set(d.marks, id, mark, d.owner);
  // A mark that fills its placeholder settles that pending work; a new one in force joins the index.
  if (held === undefined) d.marksIndex = withMark(d, d.marksIndex, id, mark, base);
  else d.pendingMarks--;
  d.ts = Math.max(d.ts, ts);
  d.oldest = minStamp(d.oldest, [ts, origin]);
  return { seq: finish(d), changed: true, reason: null };
};

/** The mark `id` of a text's block — `[from, to, key, value, flags]` — or undefined. */
const markOf = (block, id) => (typeof id === 'string' ? C.get(STATE.get(block).marks, id) : undefined);

// ---- the index of the marks -------------------------------------------------------------------------
//
// The anchors of the marks in force sorted in walk order (an anchor at ordinal o is 2o + 1 before a slot
// and 2o after one; the head 0, the end 2·total + 1), a max segment tree over the opening anchors, the
// marks of each key in stamp order — v1's index (its header says how it is kept and read).

class End {
  constructor(m, open, run, offset, after) {
    this.m = m;
    this.open = open;
    this.run = run;
    this.offset = offset;
    this.after = after;
  }
}
const anchorEnd = (st, token, base, m, open, waits) => {
  if (token === HEAD) return new End(m, open, null, 0, true);
  if (token === END) return new End(m, open, null, 0, false);
  const { side, elem } = parseAnchor(token);
  if (belowBase(elem.ts, elem.origin, base)) return new End(m, open, null, 0, true);
  const run = runOf(st, elem.run);
  if (run === undefined || !run.placed || elem.offset >= run.len) {
    if (waits !== null) waits.add(elem.run);
    return null;
  }
  return new End(m, open, elem.run, elem.offset, side === 'R');
};

// An anchor's place in the version, as a number.
const endKey = (st, end) => {
  counters.anchorReads++;
  if (end.run === null) return end.after ? 0 : 2 * st.root.s + 1;
  return 2 * positionOfSlot(st, runOf(st, end.run), end.offset).s + (end.after ? 2 : 1);
};

class MarkEntry {
  constructor(id, n, ts, origin, mark) {
    this.id = id;
    this.n = n;
    this.ts = ts;
    this.origin = origin;
    this.from = mark[0];
    this.to = mark[1];
    this.key = mark[2];
    this.value = mark[3];
    this.many = (mark[4] & MANY) !== 0;
  }
}
const markEntry = (id, mark, n) => {
  const { ts, origin } = parseRun(id);
  return new MarkEntry(id, n, ts, origin, mark);
};

class MarksIndex {
  constructor(base, ends, byKey, waits, next) {
    this.base = base;
    this.ends = ends;
    this.byKey = byKey;
    this.waits = waits;
    this.next = next;
    this.opens = [];
    this.A = null;
    this.tree = null;
    this.size = 1;
    // The opening anchors in order (`opens`, with where each opens, `A`) and a max segment tree over
    // where each closes (`tree`, its leaves from `size` on, -1 past the last).
    const closeAt = new Int32Array(next);
    for (let i = 0; i < ends.length; i++) if (!ends[i].open) closeAt[ends[i].m.n] = i;
    const count = ends.length >> 1;
    let size = 1;
    while (size < count) size <<= 1;
    const tree = new Int32Array(2 * size).fill(-1);
    const A = new Int32Array(count);
    for (let i = 0; i < ends.length; i++) {
      if (!ends[i].open) continue;
      A[this.opens.length] = i;
      tree[size + this.opens.length] = closeAt[ends[i].m.n];
      this.opens.push(ends[i].m);
    }
    for (let i = size - 1; i >= 1; i--) tree[i] = Math.max(tree[2 * i], tree[2 * i + 1]);
    this.A = A;
    this.tree = tree;
    this.size = size;
  }
}

const byStamp = (x, y) => compareClock([x.ts, x.origin], [y.ts, y.origin]);
const keyedWith = (byKey, entry) => {
  const out = new Map(byKey);
  const held = byKey.get(entry.key);
  const list = held === undefined ? [] : held.slice();
  let i = list.length;
  while (i > 0 && byStamp(list[i - 1], entry) > 0) i--;
  list.push(entry);
  for (let k = list.length - 1; k > i; k--) list[k] = list[k - 1];
  list[i] = entry;
  out.set(entry.key, list);
  return out;
};

// The index of the marks in force of a version, made whole.
const buildMarks = (st, base) => {
  counters.markIndexes++;
  const waits = new Set();
  const ends = [];
  const keys = [];
  const byKey = new Map();
  let next = 0;
  const pairs = C.pairs(st.marks);
  for (let p = 0; p < pairs.length; p++) {
    const id = pairs[p].key;
    const mark = pairs[p].value;
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
  return new MarksIndex(base, sorted, byKey, waits, next);
};

// Where an anchor of number `key` goes among the sorted anchors: after every one at or below it.
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

const insertAt = (list, at, item) => {
  list.push(item);
  for (let i = list.length - 1; i > at; i--) list[i] = list[i - 1];
  list[at] = item;
};

// The index with mark `id` in force added — over the draft of the op that makes it.
const withMark = (d, index, id, mark, base) => {
  if (index === null || !sameBase(index.base, base)) return null;
  const m = markEntry(id, mark, index.next);
  const waits = new Set();
  const from = anchorEnd(d, m.from, base, m, true, waits);
  const to = anchorEnd(d, m.to, base, m, false, waits);
  if (from === null || to === null) {
    for (const run of index.waits) waits.add(run);
    return new MarksIndex(index.base, index.ends, index.byKey, waits, index.next);
  }
  const ends = index.ends.slice();
  const a = endKey(d, from);
  const b = endKey(d, to);
  insertAt(ends, insertionOf(d, ends, a), from);
  insertAt(ends, insertionOf(d, ends, b), to);
  const next = index.next + 1;
  return new MarksIndex(base, ends, keyedWith(index.byKey, m), index.waits, next);
};

// The index with mark `id` switched off.
const withoutMark = (index, id) => {
  if (index === null) return null;
  const ends = [];
  let entry = null;
  for (let i = 0; i < index.ends.length; i++) {
    const end = index.ends[i];
    if (end.m.id === id) entry = end.m;
    else ends.push(end);
  }
  if (entry === null) return index;
  const byKey = new Map(index.byKey);
  const list = [];
  const held = byKey.get(entry.key);
  for (let i = 0; i < held.length; i++) if (held[i] !== entry) list.push(held[i]);
  if (list.length > 0) byKey.set(entry.key, list);
  else byKey.delete(entry.key);
  return new MarksIndex(index.base, ends, byKey, index.waits, index.next);
};

// The version's index for `base`, made when it has none.
const marksIndexOf = (st, base) => {
  if (st.marksIndex === null || !sameBase(st.marksIndex.base, base)) st.marksIndex = buildMarks(st, base);
  return st.marksIndex;
};

// The marks in force at the slot of ordinal `ordinal`: opened at or below it, closed past it.
const marksOver = (st, index, ordinal) => {
  const { ends, opens, A, tree, size } = index;
  const p = insertionOf(st, ends, 2 * ordinal + 1);
  let count = 0;
  let top = opens.length;
  while (count < top) {
    const mid = (count + top) >> 1;
    if (A[mid] < p) count = mid + 1;
    else top = mid;
  }
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

const byKeyThenStamp = (x, y) =>
  x.key < y.key ? -1 : x.key > y.key ? 1 : compareClock([x.ts, x.origin], [y.ts, y.origin]);

// The style of the marks in force at one point: per key the newest value, none when null; MANY marks
// list as `{ id, value }`, the ones newer than the key's newest plain mark.
const styleOf = (active) => {
  let marks = null;
  const stacked = new Set();
  const sorted = [];
  for (const m of active) sorted.push(m);
  sorted.sort(byKeyThenStamp);
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
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

/** The style of the visible element at `index` — per key the newest value, a stack listed — or null. */
const styleAt = (block, index, base = null) => {
  const st = STATE.get(block);
  if (st.marks.size === 0) return null;
  if (!Number.isInteger(index) || index < 0 || index >= st.root.v) return null;
  const found = R.spanAt(st.root, true, index);
  const { span } = found;
  const offset = span.off + (index - found.v);
  const ordinal = positionOfSlot(st, runOf(st, span.run.key), offset).s;
  const active = marksOver(st, marksIndexOf(st, base), ordinal);
  return active.length === 0 ? null : styleOf(active);
};

// Where an anchor of the index stands in the reading: the visible slots before it.
const visibleOfEnd = (st, end) => {
  if (end.run === null) return end.after ? 0 : st.root.v;
  const at = positionOfSlot(st, runOf(st, end.run), end.offset);
  return at.v + (end.after && at.vis ? 1 : 0);
};

// Where a mark of `key` stamped `stamp` does not decide the reading: the visible ranges of the newer
// marks of the key in force, sorted by start.
const newerRanges = (block, key, stamp, stacked, base = null) => {
  const out = [];
  const st = STATE.get(block);
  if (st.marks.size === 0) return out;
  const index = marksIndexOf(st, base);
  const list = index.byKey.get(key);
  if (list === undefined) return out;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (compareClock([m.ts, m.origin], stamp) <= 0) break;
    if (stacked && m.many) continue;
    const from = anchorEnd(st, m.from, base, m, true, null);
    const to = anchorEnd(st, m.to, base, m, false, null);
    if (from === null || to === null) continue;
    const start = visibleOfEnd(st, from);
    const end = visibleOfEnd(st, to);
    if (start < end) out.push([start, end]);
  }
  return out.sort((x, y) => x[0] - y[0]);
};

// The ordinal of every anchor the marks name, and the ordinal of every visible slot — read in one walk
// of the rope, no hints, so a block of any version reads its spans.
const walkMarks = (block, base) => {
  const st = STATE.get(block);
  const wanted = new Map();
  const marks = [];
  const pairs = C.pairs(st.marks);
  for (let p = 0; p < pairs.length; p++) {
    const id = pairs[p].key;
    const [from, to, key, value, flags] = pairs[p].value;
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
  const cursor = R.first(st.root);
  for (let span = cursor === null ? null : cursor.span; span !== null; span = R.next(cursor)) {
    if (span.fence !== 0) continue;
    if (wanted.size > 0) {
      for (let k = 0; k < span.len; k++) {
        const name = `${span.run.key}:${span.off + k}`;
        if (wanted.has(name)) wanted.set(name, ord + k);
      }
    }
    if (span.vis) for (let k = 0; k < span.len; k++) ords.push(ord + k);
    ord += span.len;
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

// The marks in force over the reading, as the calls that would make them again, in stamp order.
const marksIn = (block, seq = block, base = null) => {
  const length = lengthOf(block);
  if (length === 0 || STATE.get(block).marks.size === 0) return [];
  const { marks, ords, ordinalOf } = walkMarks(block, base);
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
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
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

// The text as runs of equal style: `[{ text, marks }]`, a sweep over the walk.
const spans = (block, seq = block, base = null) => {
  const st = STATE.get(block);
  const length = st.root.v;
  if (length === 0) return [];
  const { marks, ords, ordinalOf } = walkMarks(block, base);
  const events = [];
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    const lo = ordinalOf(m.from);
    const hi = ordinalOf(m.to);
    if (lo === null || hi === null || lo >= hi) continue;
    const mark = { id: m.id, ts: m.ts, origin: m.origin, key: m.key, value: m.value, many: m.many };
    events.push([lo, 1, mark], [hi, -1, mark]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const active = new Set();
  const out = [];
  let e = 0;
  let style = null;
  let text = '';
  let i = 0;
  const cursor = R.first(st.root);
  for (let span = cursor === null ? null : cursor.span; span !== null; span = R.next(cursor)) {
    if (!span.vis) continue;
    for (let k = 0; k < span.len; k++, i++) {
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
      text += span.body[k];
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
