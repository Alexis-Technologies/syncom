'use strict';

// What an op does to a block in the v2 engine (./sequence.js holds its design): a run placed with what
// hangs under it, cuts and extensions, a splice; the registers — assign and move. Every op first reads
// what it will do and every bound it meets — nothing is written before it is known to land — then
// freezes the block it starts from and writes a draft (./state.js), each node copied once.

const { compareClock } = require('../../vector.js');
const { PENDING_MAX } = require('../../plugin.js');
const R = require('./rope.js');
const I = require('./ids.js');
const C = require('./cow.js');
const { MAX_RUN, isText, present, isGap, rleAppend, rleCut, sameRle } = require('../rle.js');
const {
  END,
  MAX_FIELD,
  byOrigin,
  elemKey,
  isElemKey,
  isJson,
  minStamp,
  own,
  parseAnchor,
  parseElem,
  parseRun,
  malformed,
  refused,
  runKey,
  unchanged,
} = require('../keys.js');
const {
  Span,
  Child,
  STATE,
  SEG_MAX,
  NONE,
  Walk,
  arrived,
  asBlock,
  belowBase,
  childrenAt,
  draft,
  finish,
  holdsElem,
  keyOf,
  lastSegOf,
  pendingCount,
  recordOf,
  rootsOf,
  runById,
  runOf,
  seal,
  segOf,
  segmentsOf,
  setRun,
  setSpans,
  stampOfKey,
  walkSubtree,
  writableRun,
} = require('./state.js');

// A run's name as a key gives it: the lineage's when it interned the key (it interns well-formed keys
// only, so the key parses), else parsed — null when the key names no run.
const nameOf = (doc, key) => doc.byKey.get(key) ?? parseRun(key);

const insertAt = (list, at, item) => {
  list.push(item);
  for (let i = list.length - 1; i > at; i--) list[i] = list[i - 1];
  list[at] = item;
};

// The rank of `id` among `siblings` (run names sorted by origin then stamp).
const rankAmong = (siblings, id) => {
  let lo = 0;
  let hi = siblings.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (byOrigin(siblings[mid], id) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

// One side's children with `id` added under `off`, in order.
const withChild = (list, off, id) => {
  const held = list ?? C.EMPTY_LIST;
  const found = C.floorEntry(held, off);
  if (found !== null && found.entry.off === off) {
    const { c, i } = found;
    const ids = found.entry.ids.slice();
    insertAt(ids, rankAmong(ids, id), id);
    return C.splice(held, c, i, 1, [new Child(off, ids)]);
  }
  const entry = new Child(off, [id]);
  return found === null ? C.splice(held, 0, 0, 0, [entry]) : C.splice(held, found.c, found.i + 1, 0, [entry]);
};

// `items` after slot k of `seg` (k < len - 1): the span split around them; the two halves.
const withinSegment = (d, seg, k, items) => {
  const { owner } = d;
  const a = new Span(seg.run, seg.off, k + 1, seg.vis, seg.body === null ? null : seg.body.slice(0, k + 1), 0, owner);
  const b = new Span(
    seg.run,
    seg.off + k + 1,
    seg.len - k - 1,
    seg.vis,
    seg.body === null ? null : seg.body.slice(k + 1),
    0,
    owner,
  );
  const all = [a];
  for (let i = 0; i < items.length; i++) all.push(items[i]);
  all.push(b);
  R.replace(d, seg, all);
  setSpans(d, seg.run, [seg], [a, b]);
};

// The spans a walk laid for a placed copy, indexed; the copy's content kept in them alone.
const indexCopy = (d, copy) => {
  const { segs } = copy;
  copy.segs = null;
  copy.rle = null;
  setRun(d, copy);
  const { n } = copy.id;
  for (let i = 0; i < segs.length; i++) d.ids = I.set(d.ids, keyOf(n, segs[i].off), segs[i], d.owner);
};

// Places a run whose anchor is here (or at the head) — with whatever runs hang under it already — its
// spans into the rope where the tree rule puts them, every record of the subtree placed, its parent's
// child list told; then what waited for each of them.
const placeRun = (d, run) => {
  const w = new Walk(d, run, d.kind, d.pos, new Map(), false, d.owner);
  walkSubtree(w, run.id);
  const { items, copies } = w;
  if (run.aId === null || belowBase(run.aId.ts, run.aId.origin, d.base)) {
    // A root: among the roots, by origin.
    const roots = rootsOf(d);
    const j = rankAmong(roots, run.id);
    if (roots.length === 0) d.root = R.fromSpans(items, d.owner);
    else if (j === 0) R.insertBefore(d, runById(d, roots[0]).open, items);
    else R.insertAfter(d, runById(d, roots[j - 1]).close, items);
    insertAt(roots, j, run.id);
  } else {
    const parent = writableRun(d, run.aId);
    const off = run.aOff;
    if (run.side === 'L') {
      const siblings = childrenAt(parent.L, off) ?? NONE;
      const j = rankAmong(siblings, run.id);
      if (j < siblings.length) R.insertBefore(d, runById(d, siblings[j]).open, items);
      else {
        const seg = segOf(d, parent, off);
        const k = off - seg.off;
        if (k === 0) R.insertBefore(d, seg, items);
        else withinSegment(d, seg, k - 1, items);
      }
      if (siblings[j] !== run.id) parent.L = withChild(parent.L, off, run.id);
    } else {
      const held = childrenAt(parent.R, off) ?? NONE;
      const cont = off + 1 < parent.len;
      // The virtual siblings: the explicit ones (the run itself left out) with the continuation among
      // them by origin — before the first that sorts after the parent.
      let pred = null;
      let succ = null;
      let contPlaced = false;
      const afterCont = cont && byOrigin(parent.id, run.id) < 0;
      for (let i = 0; i < held.length; i++) {
        const c = held[i];
        if (c === run.id) continue;
        if (cont && !contPlaced && byOrigin(parent.id, c) < 0) {
          contPlaced = true;
          if (!afterCont) {
            succ = CONT;
            break;
          }
          pred = CONT;
        }
        if (byOrigin(c, run.id) < 0) pred = c;
        else {
          succ = c;
          break;
        }
      }
      if (cont && !contPlaced && succ === null) {
        if (afterCont) pred = CONT;
        else succ = CONT;
      }
      if (pred === null) {
        const seg = segOf(d, parent, off);
        const k = off - seg.off;
        if (k === seg.len - 1) R.insertAfter(d, seg, items);
        else withinSegment(d, seg, k, items);
      } else if (pred !== CONT) R.insertAfter(d, runById(d, pred).close, items);
      else if (succ !== null && succ !== CONT) R.insertBefore(d, runById(d, succ).open, items);
      else {
        // After the whole continuation: before the first child of a lower offset that sorts after its
        // continuation, else before the close.
        const tail = parent.tails > 0 ? firstTailChild(d, parent, off) : null;
        R.insertBefore(d, tail === null ? parent.close : tail.open, items);
      }
      if (held.indexOf(run.id) === -1) {
        if (afterCont) parent.tails++;
        parent.R = withChild(parent.R, off, run.id);
      }
    }
  }
  for (const copy of copies.values()) {
    indexCopy(d, copy);
    arrived(d, copy.id);
  }
  for (const id of copies.keys()) {
    settleChildren(d, id, 0);
    settleRun(d, id);
  }
};
// The continuation among a run's right children, as `placeRun` reads them.
const CONT = Object.freeze({ cont: true });

// The first right child of a lower offset of `parent` that sorts after the continuation — what follows
// the whole continuation of `offset` in the walk — or null when the parent's close fence does.
const firstTailChild = (d, parent, offset) => {
  const found = parent.R === null ? null : C.floorEntry(parent.R, offset - 1);
  if (found === null) return null;
  const { chunks } = parent.R;
  let i = found.i;
  for (let c = found.c; c >= 0; c--) {
    const chunk = chunks[c];
    if (c !== found.c) i = chunk.length - 1;
    for (; i >= 0; i--) {
      const { ids } = chunk[i];
      for (let k = 0; k < ids.length; k++) if (byOrigin(parent.id, ids[k]) < 0) return runById(d, ids[k]);
    }
  }
  return null;
};

// A run whose anchor is a run that is here but not placed yet: hung under it, walked when it is placed.
const attachChild = (d, run) => {
  const parent = writableRun(d, run.aId);
  if (run.side === 'L') parent.L = withChild(parent.L, run.aOff, run.id);
  else parent.R = withChild(parent.R, run.aOff, run.id);
};

// The runs waiting for `id` whose anchor is now here (offsets from `from` on): placed, each with its own.
const settleChildren = (d, id, from) => {
  const list = C.get(d.pending, id.n);
  if (list === undefined) return;
  const run = runById(d, id);
  const rest = [];
  const place = [];
  for (let i = 0; i < list.length; i++) {
    const r = runById(d, list[i]);
    if (r.aOff < run.len && r.aOff >= from) place.push(r);
    else rest.push(list[i]);
  }
  if (place.length === 0) return;
  d.pending = rest.length > 0 ? C.set(d.pending, id.n, rest, d.owner) : C.remove(d.pending, id.n, d.owner);
  d.pendingRuns -= place.length;
  for (let i = 0; i < place.length; i++) placeRun(d, place[i]);
};

// A run's own content grown at its end by `content` (a keystroke's extension): its last span grown when
// the new slots follow it, else new spans after what sits between.
const extendRun = (d, id, content) => {
  const run = writableRun(d, id);
  const from = run.len;
  const explicit = childrenAt(run.R, from - 1) ?? NONE;
  let pred = null;
  let tails = 0;
  for (let i = 0; i < explicit.length; i++) {
    if (byOrigin(explicit[i], id) < 0) pred = explicit[i];
    else tails++;
  }
  const items = segmentsOf(d.kind, d.pos, run, from, [content], d.owner);
  if (pred === null) {
    const last = lastSegOf(d, run);
    const first = items[0];
    const follows =
      last.vis === first.vis && (last.body === null) === (first.body === null) && last.off + last.len === from;
    if (follows && last.body !== null && last.len + first.len > SEG_MAX) {
      // The last span is full: the keystroke starts the next — a text's full one sealed, and joined to
      // the sealed one before it.
      if (isText(d.kind)) sealText(d, run, last, items);
      else {
        R.insertAfter(d, last, items);
        setSpans(d, id, NONE, items);
      }
    } else if (follows) {
      // The common keystroke: the last span grows.
      const body = last.body === null ? null : isText(d.kind) ? last.body + first.body : last.body.concat(first.body);
      const grown = new Span(id, last.off, last.len + first.len, last.vis, body, 0, d.owner);
      const all = [grown];
      for (let i = 1; i < items.length; i++) all.push(items[i]);
      R.replace(d, last, all);
      setSpans(d, id, [last], all);
    } else {
      R.insertAfter(d, last, items);
      setSpans(d, id, NONE, items);
    }
  } else {
    R.insertAfter(d, runById(d, pred).close, items);
    setSpans(d, id, NONE, items);
  }
  run.len = from + content.length;
  run.tails += tails;
  arrived(d, id);
  d.slots += content.length;
  settleChildren(d, id, from);
  settleRun(d, id);
};

// A text's full span `last` of `run`, the next slots `items` after it: joined to the span before it when
// the two are one stretch of the rope into one flat body, else sealed flat alone.
const sealText = (d, run, last, items) => {
  const { id } = run;
  const before = last.off > 0 ? I.floor(d.ids, keyOf(id.n, last.off - 1)) : undefined;
  const prev = before instanceof Span && before.run === id ? before : null;
  const joins =
    prev !== null &&
    prev.body !== null &&
    prev.vis === last.vis &&
    prev.off + prev.len === last.off &&
    R.before(d, last) === prev;
  if (!joins) {
    seal(last.body);
    R.insertAfter(d, last, items);
    setSpans(d, id, NONE, items);
    return;
  }
  const joined = new Span(id, prev.off, prev.len + last.len, prev.vis, prev.body + last.body, 0, d.owner);
  seal(joined.body);
  R.replace(d, last, items);
  R.replace(d, prev, [joined]);
  const all = [joined];
  for (let i = 0; i < items.length; i++) all.push(items[i]);
  setSpans(d, id, [prev, last], all);
};

// A cut of [offset, offset + length) of a placed run: the spans it crosses split, the pieces made gaps,
// neighbouring gaps joined.
const cutRun = (d, id, offset, length) => {
  const run = runById(d, id);
  const end = Math.min(offset + length, run.len);
  const { owner } = d;
  let at = offset;
  while (at < end) {
    const seg = segOf(d, run, at);
    const k = at - seg.off;
    const n = Math.min(end - at, seg.len - k);
    if (seg.body === null) {
      at += n;
      continue;
    }
    const pieces = [];
    if (k > 0) pieces.push(new Span(id, seg.off, k, seg.vis, seg.body.slice(0, k), 0, owner));
    const gap = new Span(id, at, n, false, null, 0, owner);
    pieces.push(gap);
    if (k + n < seg.len) pieces.push(new Span(id, at + n, seg.len - k - n, seg.vis, seg.body.slice(k + n), 0, owner));
    R.replace(d, seg, pieces);
    setSpans(d, id, [seg], pieces);
    // The gap made, joined to its neighbours of the same run: one gap.
    let last = gap;
    const prev = R.before(d, gap);
    if (prev !== null && prev.run === id && prev.body === null && prev.fence === 0 && prev.off + prev.len === gap.off) {
      const joined = new Span(id, prev.off, prev.len + gap.len, prev.vis, null, 0, owner);
      R.replace(d, prev, [joined]);
      R.replace(d, gap, NONE);
      setSpans(d, id, [prev, gap], [joined]);
      last = joined;
    }
    const following = R.after(d, last);
    if (
      following !== null &&
      following.run === id &&
      following.body === null &&
      following.fence === 0 &&
      last.off + last.len === following.off
    ) {
      const joined = new Span(id, last.off, last.len + following.len, last.vis, null, 0, owner);
      R.replace(d, last, [joined]);
      R.replace(d, following, NONE);
      setSpans(d, id, [last, following], [joined]);
    }
    at += n;
  }
};

// A slot of a placed list run hidden or shown — the position register moved: one span split around it.
const setShown = (d, id, off, vis) => {
  const run = runById(d, id);
  const seg = segOf(d, run, off);
  if (seg.body === null || seg.vis === vis) return;
  const k = off - seg.off;
  const { owner } = d;
  const pieces = [];
  if (k > 0) pieces.push(new Span(id, seg.off, k, seg.vis, seg.body.slice(0, k), 0, owner));
  pieces.push(new Span(id, off, 1, vis, seg.body.slice(k, k + 1), 0, owner));
  if (k + 1 < seg.len) pieces.push(new Span(id, off + 1, seg.len - k - 1, seg.vis, seg.body.slice(k + 1), 0, owner));
  R.replace(d, seg, pieces);
  setSpans(d, id, [seg], pieces);
};

// Pending cuts and extensions of a run, applied as far as its length allows.
const settleRun = (d, id) => {
  const { key } = id;
  for (;;) {
    const list = d.ext && own(d.ext, key);
    if (!list) break;
    const run = runById(d, id);
    const len = run.len;
    // The extension that continues the run, and what lies past it still — none for a position run.
    let hit;
    const rest = [];
    for (let i = 0; i < list.length && run.elem === null; i++) {
      const from = list[i][0];
      if (from === len) hit ??= list[i];
      else if (from > len) rest.push(list[i]);
    }
    d.ext = { ...d.ext };
    if (rest.length > 0) d.ext[key] = rest;
    else {
      delete d.ext[key];
      if (Object.keys(d.ext).length === 0) d.ext = null;
    }
    if (hit === undefined) break;
    const { placed } = run;
    if (placed) extendRun(d, id, hit[1]);
    else {
      const w = writableRun(d, id);
      w.rle = rleAppend(d.kind, w.rle, hit[1]);
      w.len = len + hit[1].length;
    }
    d.slots += placed ? 0 : hit[1].length;
  }
  const cuts = d.cuts && own(d.cuts, key);
  if (cuts) {
    const run = runById(d, id);
    const len = run.len;
    const rest = [];
    for (let i = 0; i < cuts.length; i++) {
      const [offset, length] = cuts[i];
      if (offset < len) {
        if (run.placed) cutRun(d, id, offset, Math.min(length, len - offset));
        else {
          const w = writableRun(d, id);
          w.rle = rleCut(d.kind, w.rle, offset, Math.min(length, len - offset));
        }
        if (offset + length > len) rest.push([len, offset + length - len]);
      } else rest.push([offset, length]);
    }
    d.cuts = { ...d.cuts };
    if (rest.length > 0) d.cuts[key] = rest;
    else {
      delete d.cuts[key];
      if (Object.keys(d.cuts).length === 0) d.cuts = null;
    }
  }
};

// Whether `cuts` waits to cut exactly this range of `key`.
const hasRange = (cuts, key, offset, length) => {
  const held = cuts ? own(cuts, key) : undefined;
  if (held === undefined) return false;
  for (let i = 0; i < held.length; i++) if (held[i][0] === offset && held[i][1] === length) return true;
  return false;
};
// The same over ranges an op plans to add (`[key, offset, length]` each).
const planned = (ranges, key, offset, length) => {
  for (let i = 0; i < ranges.length; i++) {
    if (ranges[i][0] === key && ranges[i][1] === offset && ranges[i][2] === length) return true;
  }
  return false;
};

const addRange = (d, key, offset, length) => {
  const held = d.cuts && own(d.cuts, key);
  const list = held ? held.slice() : [];
  list.push([offset, length]);
  d.cuts = { ...(d.cuts ?? {}), [key]: list };
  d.oldest = minStamp(d.oldest, stampOfKey(key));
};

// Whether a placed run's slots in [offset, offset + inside) hold anything alive.
const aliveIn = (st, run, offset, inside) => {
  for (let o = offset; o < offset + inside;) {
    const seg = segOf(st, run, o);
    if (seg.body !== null) return true;
    o = seg.off + seg.len;
  }
  return false;
};

// The cuts of a splice laid on a draft, in order: a range of a run not here (or past its end) waits in
// `cuts`, the rest is cut. Read first by `planCuts`, which says what they do and what they cost.
const layCuts = (d, kind, cut, base) => {
  for (let c = 0; c < cut.length; c++) {
    const [key, offset, length] = cut[c];
    const made = nameOf(d.doc, key);
    if (belowBase(made.ts, made.origin, base)) continue;
    const target = runOf(d, key);
    if (target === undefined || offset >= target.len) {
      if (!hasRange(d.cuts, key, offset, length)) addRange(d, key, offset, length);
      continue;
    }
    const inside = Math.min(length, target.len - offset);
    if (target.placed) {
      if (aliveIn(d, target, offset, inside)) cutRun(d, target.id, offset, inside);
    } else {
      const after = rleCut(kind, target.rle, offset, inside);
      if (!sameRle(after, target.rle)) writableRun(d, target.id).rle = after;
    }
    if (offset + length > target.len && !hasRange(d.cuts, key, target.len, offset + length - target.len)) {
      addRange(d, key, target.len, offset + length - target.len);
    }
  }
};

// What a splice's cuts will do, read and not written: whether anything changes, the ranges that will
// wait, and the first that would pass `pendingMax` — v1's refusal, its count the pending work with the
// ranges before it counted (`count`: the block's, made once when asked).
class CutPlan {
  constructor() {
    this.changed = false;
    this.ranges = [];
    this.stop = null;
  }
}
const planCuts = (seq, st, cut, base, pendingMax, count) => {
  const plan = new CutPlan();
  // A run not here yet whose content a range before cut (still unplaced, cut again): v1 reads the draft.
  const after = new Map();
  for (let c = 0; c < cut.length; c++) {
    const [key, offset, length] = cut[c];
    const made = nameOf(st.doc, key);
    if (belowBase(made.ts, made.origin, base)) continue;
    const target = runOf(st, key);
    if (target === undefined || offset >= target.len) {
      if (hasRange(seq.cuts, key, offset, length) || planned(plan.ranges, key, offset, length)) continue;
      const n = count() + plan.ranges.length;
      if (n >= pendingMax) {
        plan.stop = refused(seq, 'pending', n, pendingMax);
        return plan;
      }
      plan.ranges.push([key, offset, length]);
      plan.changed = true;
      continue;
    }
    const inside = Math.min(length, target.len - offset);
    if (target.placed) {
      if (aliveIn(st, target, offset, inside)) plan.changed = true;
    } else {
      const rle = after.get(key) ?? target.rle;
      const cutRle = rleCut(seq.k, rle, offset, inside);
      if (!sameRle(cutRle, rle)) {
        after.set(key, cutRle);
        plan.changed = true;
      }
    }
    const rest = offset + length - target.len;
    if (rest > 0 && !hasRange(seq.cuts, key, target.len, rest) && !planned(plan.ranges, key, target.len, rest)) {
      const n = count() + plan.ranges.length;
      if (n >= pendingMax) {
        plan.stop = refused(seq, 'pending', n, pendingMax);
        return plan;
      }
      plan.ranges.push([key, target.len, rest]);
      plan.changed = true;
    }
  }
  return plan;
};

// A register write, LWW by stamp: false when the one the map holds is as new.
const newer = (map, key, stamp) => {
  const held = C.get(map, key);
  return held === undefined || compareClock([held[0], held[1]], stamp) < 0;
};

// The pending work of a block, counted once, when a bound first asks.
const counter = (seq) => {
  let n = -1;
  return () => (n === -1 ? (n = pendingCount(seq)) : n);
};

// A new run's place: a root, under a placed parent, under one here but not placed, or waiting.
const ROOTED = 0;
const PLACED = 1;
const ATTACHED = 2;
const WAITING = 3;
const placeOf = (st, aId, aOff, base) => {
  if (aId === null || belowBase(aId.ts, aId.origin, base)) return ROOTED;
  const parent = runById(st, aId);
  if (parent === undefined || aOff >= parent.len) return WAITING;
  return parent.placed ? PLACED : ATTACHED;
};
// A new run laid in a draft where `placeOf` says.
const layRun = (d, record, where) => {
  if (where === ROOTED || where === PLACED) {
    placeRun(d, record);
    return;
  }
  setRun(d, record);
  if (where === ATTACHED) attachChild(d, record);
  else {
    const list = C.get(d.pending, record.aId.n);
    const next = list === undefined ? [] : list.slice();
    let at = next.length;
    while (at > 0 && next[at - 1].key > record.id.key) at--;
    insertAt(next, at, record.id);
    d.pending = C.set(d.pending, record.aId.n, next, d.owner);
    d.pendingRuns++;
  }
  settleRun(d, record.id);
};

// One `splice`: cuts first, then the insertion — a new run anchored at `at`, or `{ run, from }` extending
// a run of this origin. Returns the block it leaves and whether anything moved; `reason` names a refusal
// ('bound') or a payload the rule does not admit ('malformed'), either leaving the block as it was — and
// every one of them, with its count, is known before anything is written. `stamp` is `[ts, origin]`.
const applySplice = (given, stamp, payload, base = null, pendingMax = PENDING_MAX) => {
  const [ts, origin] = stamp;
  const seq = asBlock(given, base);
  if (!payload || typeof payload !== 'object') return malformed(seq);
  const { cut, at, run, from, content, vals } = payload;
  if (vals !== undefined) {
    if (!Array.isArray(vals) || content === undefined) return malformed(seq);
    for (let i = 0; i < vals.length; i++) {
      const pair = vals[i];
      if (!Array.isArray(pair) || pair.length !== 2 || !Number.isInteger(pair[0]) || pair[0] < 0) return malformed(seq);
      if (pair[0] >= content.length || !isJson(pair[1]) || pair[1] === undefined) return malformed(seq);
    }
  }
  if (content === undefined || !present(seq.k, content)) return malformed(seq);
  const inserting = content.length > 0;
  if (cut !== undefined && !Array.isArray(cut)) return malformed(seq);
  if (!inserting && (cut === undefined || cut.length === 0)) return malformed(seq);
  if (!inserting && (at !== undefined || run !== undefined)) return malformed(seq);
  if (inserting && (at === undefined) === (run === undefined)) return malformed(seq);
  const anchor = at === undefined ? null : parseAnchor(at);
  if (at !== undefined && (anchor === null || at === END || (anchor.elem !== null && anchor.elem.ts >= ts))) {
    return malformed(seq);
  }
  const st = STATE.get(seq);
  const { doc } = st;
  if (run !== undefined) {
    // A run is extended by the origin that made it, nobody else.
    const named = nameOf(doc, run);
    if (named === null || !Number.isInteger(from) || from < 0 || named.origin !== origin) return malformed(seq);
  }
  if (cut !== undefined) {
    for (let i = 0; i < cut.length; i++) {
      const range = cut[i];
      // An honest cutter saw the run it cuts, so the run is older than the op.
      const named = Array.isArray(range) && range.length === 3 ? nameOf(doc, range[0]) : null;
      if (named === null || !(named.ts < ts)) return malformed(seq);
      if (!Number.isInteger(range[1]) || range[1] < 0 || !isGap(range[2])) return malformed(seq);
    }
  }
  const count = counter(seq);
  // What the cuts do, read first.
  const cuts = cut === undefined ? null : planCuts(seq, st, cut, base, pendingMax, count);
  if (cuts !== null && cuts.stop !== null) return cuts.stop;
  let changed = cuts !== null && cuts.changed;
  // What the insertion does: 0 nothing, 1 a new run, 2 an extension laid, 3 an extension that waits.
  let insert = 0;
  let key = null;
  let target = null;
  let where = ROOTED;
  if (inserting) {
    if (content.length > MAX_RUN) return refused(seq, 'run', content.length, MAX_RUN);
    const slots = st.slots + content.length;
    if (slots > MAX_FIELD) return refused(seq, 'field', slots, MAX_FIELD);
    const waits = cuts === null ? 0 : cuts.ranges.length;
    if (at !== undefined) {
      key = runKey(ts, origin);
      if (runOf(st, key) === undefined) {
        const e = anchor.elem;
        const parent = e === null ? undefined : runOf(st, e.run);
        const rooted = e === null || belowBase(e.ts, e.origin, base);
        if (!rooted && !(parent !== undefined && e.offset < parent.len)) {
          // The values riding on the run are registers of slots not here: they wait too.
          let fresh = 0;
          if (vals !== undefined) {
            const seen = new Set();
            for (let i = 0; i < vals.length; i++) {
              const elem = elemKey(key, vals[i][0]);
              if (seen.has(elem)) continue;
              seen.add(elem);
              if (C.get(st.vals, elem) === undefined) fresh++;
            }
          }
          const n = count() + waits + fresh;
          if (n >= pendingMax) return refused(seq, 'pending', n, pendingMax);
        }
        insert = 1;
        changed = true;
      }
    } else {
      target = runOf(st, run);
      if (target !== undefined && target.elem !== null) return malformed(seq);
      if (target !== undefined) {
        const len = target.len;
        if (len + content.length > MAX_RUN) return refused(seq, 'run', len + content.length, MAX_RUN);
        if (from === len) {
          insert = 2;
          changed = true;
        } else if (from > len) {
          if (belowBase(target.id.ts, target.id.origin, base)) return unchanged(seq);
          const n = count() + waits;
          if (n >= pendingMax) return refused(seq, 'pending', n, pendingMax);
          const held = (seq.ext && own(seq.ext, run)) || NONE;
          let known = false;
          for (let i = 0; i < held.length && !known; i++) known = held[i][0] === from;
          if (!known) {
            insert = 3;
            changed = true;
          }
        }
      }
    }
  }
  if (!changed) return unchanged(seq);
  // Written: the block frozen, a draft of it.
  const d = draft(seq);
  if (cut !== undefined) layCuts(d, seq.k, cut, base);
  // A register like any other, last writer wins: an assign to one of these slots that came first keeps
  // its value when it is the newer, whichever arrived first.
  const assignVals = (runKeyOf, start) => {
    if (vals === undefined || vals.length === 0) return;
    for (let i = 0; i < vals.length; i++) {
      const elem = elemKey(runKeyOf, start + vals[i][0]);
      if (newer(d.vals, elem, stamp)) d.vals = C.set(d.vals, elem, [ts, origin, vals[i][1]], d.owner);
    }
  };
  if (insert === 1) {
    const record = recordOf(d.doc, key, [at, isText(seq.k) ? [content] : [content.slice()]], d.owner, anchor);
    assignVals(key, 0);
    where = placeOf(d, record.aId, record.aOff, base);
    d.slots += record.len;
    d.ts = Math.max(d.ts, ts);
    d.oldest = minStamp(d.oldest, [ts, origin]);
    if (anchor.elem !== null) d.oldestAnchor = minStamp(d.oldestAnchor, [anchor.elem.ts, anchor.elem.origin]);
    layRun(d, record, where);
  } else if (insert === 2) {
    assignVals(run, from);
    const { id } = target;
    if (target.placed) extendRun(d, id, content);
    else {
      const w = writableRun(d, id);
      w.rle = rleAppend(d.kind, w.rle, content);
      w.len = target.len + content.length;
      d.slots += content.length;
      settleRun(d, id);
    }
  } else if (insert === 3) {
    const held = (d.ext && own(d.ext, run)) || NONE;
    const list = held.slice();
    list.push([from, isText(d.kind) ? content : content.slice()]);
    d.ext = { ...(d.ext ?? {}), [run]: list };
    d.oldest = minStamp(d.oldest, stampOfKey(run));
  }
  return { seq: finish(d), changed: true, reason: null };
};

// ---- registers: assign and move ---------------------------------------------------------------------

// An `assign`: the element's value register (a list's element, a text's embed slot).
const applyAssign = (given, stamp, payload, base = null, pendingMax = PENDING_MAX) => {
  const seq = asBlock(given, base);
  if (!payload || typeof payload !== 'object') return malformed(seq);
  const { elem, value } = payload;
  if (!isElemKey(elem) || !isJson(value) || value === undefined) return malformed(seq);
  const st = STATE.get(seq);
  if (!newer(st.vals, elem, stamp)) return unchanged(seq);
  if (C.get(st.vals, elem) === undefined && !holdsElem(st, elem)) {
    const n = pendingCount(seq);
    if (n >= pendingMax) return refused(seq, 'pending', n, pendingMax);
  }
  const d = draft(seq);
  d.vals = C.set(d.vals, elem, [stamp[0], stamp[1], value], d.owner);
  d.ts = Math.max(d.ts, stamp[0]);
  d.oldest = minStamp(d.oldest, stamp);
  return { seq: finish(d), changed: true, reason: null };
};

// The slot an element shows at under `pos`: its position run's one slot when a move named one, else its
// own; null when that run is not here.
const slotShowing = (d, elem) => {
  const winner = C.get(d.pos, elem);
  if (winner === undefined) {
    const e = parseElem(elem);
    const run = runOf(d, e.run);
    return run === undefined || e.offset >= run.len ? null : run;
  }
  return runOf(d, winner[2]) ?? null;
};
const offsetShowing = (d, elem) => (C.get(d.pos, elem) === undefined ? parseElem(elem).offset : 0);

// A `move`: cuts the slot the element showed at, adds a position run that names it (whatever the
// register says — another node may anchor on it) and points the position register at that run when the
// stamp is newer.
const applyMove = (given, stamp, payload, base = null, pendingMax = PENDING_MAX) => {
  const [ts, origin] = stamp;
  const seq = asBlock(given, base);
  if (seq.k !== 'l' || !payload || typeof payload !== 'object') return malformed(seq);
  const { elem, cut, at, value } = payload;
  const anchor = parseAnchor(at);
  const named = Array.isArray(cut) && cut.length === 3 ? nameOf(STATE.get(seq).doc, cut[0]) : null;
  const cutOk = named !== null && named.ts < ts;
  const anchorOk = anchor !== null && at !== END && (anchor.elem === null || anchor.elem.ts < ts);
  if (!isElemKey(elem) || !cutOk || !Number.isInteger(cut[1]) || cut[1] < 0 || cut[2] !== 1 || !anchorOk) {
    return malformed(seq);
  }
  if (!isJson(value) || value === undefined) return malformed(seq);
  const key = runKey(ts, origin);
  const st = STATE.get(seq);
  const moving = newer(st.pos, elem, stamp);
  const count = counter(seq);
  if (moving && C.get(st.pos, elem) === undefined && !holdsElem(st, elem)) {
    const n = count();
    if (n >= pendingMax) return refused(seq, 'pending', n, pendingMax);
  }
  // The cut of the slot the element showed at, as a splice of its own would lay it.
  const ranges = [cut];
  const cuts = planCuts(seq, st, ranges, base, pendingMax, count);
  if (cuts.stop !== null) return cuts.stop;
  let changed = cuts.changed;
  const fresh = runOf(st, key) === undefined;
  if (fresh) {
    const e = anchor.elem;
    const parent = e === null ? undefined : runOf(st, e.run);
    const rooted = e === null || belowBase(e.ts, e.origin, base);
    if (!rooted && !(parent !== undefined && e.offset < parent.len)) {
      const n = count() + cuts.ranges.length;
      if (n >= pendingMax) return refused(seq, 'pending', n, pendingMax);
    }
    changed = true;
  } else if (moving) changed = true;
  if (!changed) return unchanged(seq);
  const d = draft(seq);
  layCuts(d, seq.k, ranges, base);
  if (fresh) {
    const record = recordOf(d.doc, key, [at, [[value]], elem], d.owner, anchor);
    const where = placeOf(d, record.aId, record.aOff, base);
    d.slots += 1;
    d.ts = Math.max(d.ts, ts);
    d.oldest = minStamp(d.oldest, [ts, origin]);
    if (anchor.elem !== null) d.oldestAnchor = minStamp(d.oldestAnchor, [anchor.elem.ts, anchor.elem.origin]);
    // The register first, so the new run's slot shows or hides as it should.
    if (moving) moveRegister(d, elem, ts, origin, key);
    if (where === ROOTED || where === PLACED) {
      setRun(d, record);
      placeRun(d, record);
    } else layRun(d, record, where);
  } else if (moving) {
    moveRegister(d, elem, ts, origin, key);
    const r = runOf(d, key);
    if (r.placed) setShown(d, r.id, 0, true);
    d.ts = Math.max(d.ts, ts);
  }
  return { seq: finish(d), changed: true, reason: null };
};
// The position register of `elem` pointed at run `key`; the slot it showed at hidden.
const moveRegister = (d, elem, ts, origin, key) => {
  const was = slotShowing(d, elem);
  const off = was === null ? 0 : offsetShowing(d, elem);
  d.pos = C.set(d.pos, elem, [ts, origin, key], d.owner);
  if (was !== null && was.placed) setShown(d, was.id, off, false);
};

module.exports = {
  settleRun,
  applySplice,
  applyAssign,
  applyMove,
};
