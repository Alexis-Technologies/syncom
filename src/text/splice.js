'use strict';

// What an op does to a block (src/text/sequence.js holds its design): a draft
// path-copied from it, a run placed with what hangs under it, cuts and
// extensions, a splice; the registers — assign and move.

const { compareClock } = require('../vector.js');
const { PENDING_MAX } = require('../plugin.js');
const T = require('./btree.js');
const P = require('./pmap.js');
const SL = require('./plist.js');
const { MAX_RUN, isText, present, isGap, rleAppend, rleCut, sameRle } = require('./rle.js');
const {
  END,
  MAX_FIELD,
  byOrigin,
  elemKey,
  isElemKey,
  isJson,
  isRunKey,
  minStamp,
  own,
  parseAnchor,
  parseElem,
  parseRun,
  malformed,
  refused,
  runKey,
  unchanged,
} = require('./keys.js');
const {
  NONE,
  SEG_MAX,
  STATE,
  arrived,
  asBlock,
  belowBase,
  childrenAt,
  createBlock,
  ensureHead,
  holdsElem,
  pendingCount,
  recordOf,
  runOf,
  seal,
  segOf,
  segmentsOf,
  stampOfKey,
  waiting,
  walkSubtree,
} = require('./state.js');

// ---- the rope: editing ------------------------------------------------------

// A draft of the block's state under an op: the fields an op may replace,
// shared with the head until written; `finish` makes the next block of it.
const draft = (block) => {
  const st = ensureHead(block);
  return {
    kind: st.kind,
    base: st.base,
    root: st.root,
    runs: st.runs,
    roots: st.roots,
    pending: st.pending,
    pendingRuns: st.pendingRuns,
    slots: st.slots,
    oldest: st.oldest,
    oldestAnchor: st.oldestAnchor,
    ts: block.ts,
    cuts: block.cuts ?? null,
    ext: block.ext ?? null,
    pos: st.pos,
    vals: st.vals,
    marks: st.marks,
    // The index of the marks holds across an op that leaves them (./marks
    // below): the order of the slots their anchors name never changes.
    marksIndex: st.marksIndex,
    lineage: st.lineage,
    copiedPending: false,
    copiedRoots: false,
  };
};

const finish = (d) => {
  const state = {
    kind: d.kind,
    base: d.base,
    root: d.root,
    runs: d.runs,
    roots: d.roots,
    pending: d.pending,
    pendingRuns: d.pendingRuns,
    slots: d.slots,
    oldest: d.oldest,
    oldestAnchor: d.oldestAnchor,
    lineage: d.lineage,
    pos: d.pos,
    vals: d.vals,
    marks: d.marks,
    marksIndex: d.marksIndex,
    views: null,
    rendered: null,
    derivedFrom: null,
    elems: null,
    elemIndex: null,
    json: null,
  };
  const block = createBlock(d.kind, d.ts, d.cuts, d.ext, state);
  d.lineage.head = block;
  return block;
};

const pendingOf = (d) => {
  if (!d.copiedPending) {
    d.pending = new Map(d.pending);
    d.copiedPending = true;
  }
  return d.pending;
};
const rootsOf = (d) => {
  if (!d.copiedRoots) {
    d.roots = d.roots.slice();
    d.copiedRoots = true;
  }
  return d.roots;
};
const setRun = (d, run) => {
  d.runs = P.set(d.runs, run.key, Object.freeze(run));
  return run;
};
const copyRun = (run) => ({ ...run });
// `segs` with `count` segments from `seg` on replaced by `pieces`.
const replacedIn = (segs, seg, count, pieces) => {
  const found = SL.find(segs, seg.off);
  return SL.splice(segs, found.c, found.i, count, pieces);
};

// The rank of `run` among `siblings` (run keys sorted by origin then stamp).
const rankAmong = (d, run, siblings) => {
  let lo = 0;
  let hi = siblings.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (byOrigin(runOf(d, siblings[mid]), run) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

// One side's children with `key` added under `off`, in order; the parent's
// record copied by the caller.
const withChild = (d, list, off, key, run) => {
  const held = list ?? SL.EMPTY;
  const found = SL.find(held, off);
  if (found !== null && found.entry.off === off) {
    const keys = found.entry.keys.slice();
    keys.splice(rankAmong(d, run, keys), 0, key);
    return SL.splice(held, found.c, found.i, 1, [{ off, keys }]);
  }
  const entry = { off, keys: [key] };
  return found === null ? SL.splice(held, 0, 0, 0, [entry]) : SL.splice(held, found.c, found.i + 1, 0, [entry]);
};

// Whether slot `off` of `run` (placed) is the last of its segment: a
// segment split there is a split after it.
const withinSegment = (d, seg, k, items) => {
  // `items` go after slot k of `seg` (k < len - 1): the segment is split.
  const a = { ...seg, len: k + 1, body: seg.body === null ? null : seg.body.slice(0, k + 1), node: null };
  const b = {
    ...seg,
    off: seg.off + k + 1,
    len: seg.len - k - 1,
    body: seg.body === null ? null : seg.body.slice(k + 1),
    node: null,
  };
  d.root = T.replace(d.root, seg, [a, ...items, b], d.lineage);
  return [a, b];
};

// The run that holds `seg` with the segment replaced by `pieces` in its list.
const replaceSeg = (d, runKeyOf, seg, pieces) => {
  const run = copyRun(runOf(d, runKeyOf));
  run.segs = replacedIn(run.segs, seg, 1, pieces);
  return setRun(d, run);
};

// Places a run whose anchor is here (or at the head) — with whatever runs
// hang under it already — its items into the rope at the place the tree
// rule gives, every record of the subtree placed, its parent's child list
// told; then what waited for each of them.
const placeRun = (d, run) => {
  const getRun = (key) => (key === run.key ? run : runOf(d, key));
  const { items, copies } = walkSubtree(getRun, d.kind, d.pos, run.key);
  const { anchor } = run;
  if (anchor.elem === null || belowBase(anchor.elem.ts, anchor.elem.origin, d.base)) {
    // A root: among the roots, by origin.
    const roots = rootsOf(d);
    const j = rankAmong(d, run, roots);
    if (roots.length === 0) d.root = T.fromItems(items, d.lineage);
    else if (j === 0) d.root = T.insertBefore(d.root, runOf(d, roots[0]).open, items, d.lineage);
    else d.root = T.insertAfter(d.root, runOf(d, roots[j - 1]).close, items, d.lineage);
    roots.splice(j, 0, run.key);
  } else {
    const e = anchor.elem;
    const parent = copyRun(runOf(d, e.run));
    if (anchor.side === 'L') {
      const siblings = childrenAt(parent.L, e.offset) ?? [];
      const j = rankAmong(d, run, siblings);
      if (j < siblings.length) d.root = T.insertBefore(d.root, runOf(d, siblings[j]).open, items, d.lineage);
      else {
        const seg = segOf(parent, e.offset);
        const k = e.offset - seg.off;
        if (k === 0) d.root = T.insertBefore(d.root, seg, items, d.lineage);
        else {
          const [a, b] = withinSegment(d, seg, k - 1, items);
          parent.segs = replacedIn(parent.segs, seg, 1, [a, b]);
        }
      }
      // The siblings are sorted by origin, so the run, were it among them, sits at its rank.
      if (siblings[j] !== run.key) parent.L = withChild(d, parent.L, e.offset, run.key, run);
    } else {
      const held = childrenAt(parent.R, e.offset) ?? NONE;
      const cont = e.offset + 1 < parent.len;
      // The virtual siblings: the explicit ones (the run itself left out)
      // with the continuation among them by origin — before the first that
      // sorts after the parent.
      let pred = null; // a run key, 'cont', or null
      let succ = null;
      let contPlaced = false;
      const afterCont = cont && byOrigin(parent, run) < 0;
      for (let i = 0; i < held.length; i++) {
        const key = held[i];
        if (key === run.key) continue;
        const c = runOf(d, key);
        if (cont && !contPlaced && byOrigin(parent, c) < 0) {
          contPlaced = true;
          if (!afterCont) {
            succ = 'cont';
            break;
          }
          pred = 'cont';
        }
        if (byOrigin(c, run) < 0) pred = key;
        else {
          succ = key;
          break;
        }
      }
      if (cont && !contPlaced && succ === null) {
        if (afterCont) pred = 'cont';
        else succ = 'cont';
      }
      if (pred === null) {
        const seg = segOf(parent, e.offset);
        const k = e.offset - seg.off;
        if (k === seg.len - 1) d.root = T.insertAfter(d.root, seg, items, d.lineage);
        else {
          const [a, b] = withinSegment(d, seg, k, items);
          parent.segs = replacedIn(parent.segs, seg, 1, [a, b]);
        }
      } else if (pred !== 'cont') d.root = T.insertAfter(d.root, runOf(d, pred).close, items, d.lineage);
      else if (succ !== null && succ !== 'cont') d.root = T.insertBefore(d.root, runOf(d, succ).open, items, d.lineage);
      else {
        // After the whole continuation: before the first child of a lower
        // offset that sorts after its continuation, else before the close.
        const tail = parent.tails > 0 ? firstTailChild(d, parent, e.offset) : null;
        d.root = T.insertBefore(d.root, tail === null ? parent.close : tail.open, items, d.lineage);
      }
      if (!held.includes(run.key)) {
        if (afterCont) parent.tails++;
        parent.R = withChild(d, parent.R, e.offset, run.key, run);
      }
    }
    setRun(d, parent);
  }
  for (const copy of copies.values()) {
    setRun(d, copy);
    arrived(d, copy.key);
  }
  for (const key of copies.keys()) {
    settleChildren(d, key, 0);
    settleRun(d, key);
  }
};

// The first right child of a lower offset of `parent` that sorts after the
// continuation — what follows the whole continuation of `offset` in the
// walk — or null when the parent's close fence does.
const firstTailChild = (d, parent, offset) => {
  const found = parent.R === null ? null : SL.find(parent.R, offset - 1);
  if (found === null) return null;
  for (const entry of SL.backward(parent.R, found.c, found.i)) {
    for (const key of entry.keys) {
      const c = runOf(d, key);
      if (byOrigin(parent, c) < 0) return c;
    }
  }
  return null;
};

// A run whose anchor is a run that is here but not placed yet: hung under
// it, to be walked with it when it is placed.
const attachChild = (d, run) => {
  const e = run.anchor.elem;
  const parent = copyRun(runOf(d, e.run));
  const side = run.anchor.side;
  parent[side] = withChild(d, parent[side], e.offset, run.key, run);
  setRun(d, parent);
};

// The runs waiting for `key` whose anchor is now here (offsets from `from`
// on): placed, each with its own.
const settleChildren = (d, key, from) => {
  const list = d.pending.get(key);
  if (list === undefined) return;
  const run = runOf(d, key);
  const rest = [];
  const place = [];
  for (const child of list) {
    const r = runOf(d, child);
    if (r.anchor.elem.offset < run.len && r.anchor.elem.offset >= from) place.push(r);
    else rest.push(child);
  }
  if (place.length === 0) return;
  const pending = pendingOf(d);
  if (rest.length > 0) pending.set(key, rest);
  else pending.delete(key);
  d.pendingRuns -= place.length;
  for (const r of place) placeRun(d, r);
};

// A run's own content grows at its end by `content` (the extension of a
// keystroke): its last segment grown when the new slots follow it, else a
// new segment after what sits between.
const extendRun = (d, key, content) => {
  const run = copyRun(runOf(d, key));
  const from = run.len;
  const o = from - 1;
  const explicit = childrenAt(run.R, o) ?? [];
  let pred = null;
  let tails = 0;
  for (const c of explicit) {
    if (byOrigin(runOf(d, c), run) < 0) pred = c;
    else tails++;
  }
  const items = segmentsOf(d.kind, d.pos, run, from, [content]);
  if (pred === null) {
    const last = SL.last(run.segs);
    const first = items[0];
    const follows =
      last.vis === first.vis && (last.body === null) === (first.body === null) && last.off + last.len === from;
    if (follows && last.body !== null && last.len + first.len > SEG_MAX) {
      // The last segment is full: the keystroke starts the next — a text's
      // full one sealed, and joined to the sealed one before it.
      if (isText(d.kind)) sealText(d, run, last, items);
      else {
        d.root = T.insertAfter(d.root, last, items, d.lineage);
        run.segs = SL.append(run.segs, items);
      }
    } else if (follows) {
      // The common keystroke: the last segment grows.
      const grown = {
        ...last,
        len: last.len + first.len,
        body: last.body === null ? null : isText(d.kind) ? last.body + first.body : last.body.concat(first.body),
        node: null,
      };
      d.root = T.replace(d.root, last, [grown, ...items.slice(1)], d.lineage);
      run.segs = replacedIn(run.segs, last, 1, [grown, ...items.slice(1)]);
    } else {
      d.root = T.insertAfter(d.root, last, items, d.lineage);
      run.segs = SL.append(run.segs, items);
    }
  } else {
    d.root = T.insertAfter(d.root, runOf(d, pred).close, items, d.lineage);
    run.segs = SL.append(run.segs, items);
  }
  run.len = from + content.length;
  run.tails += tails;
  setRun(d, run);
  arrived(d, key);
  d.slots += content.length;
  settleChildren(d, key, from);
  settleRun(d, key);
};

// A text's full segment `last` of `run`, the next slots `items` after it:
// joined to the segment before it when the two are one stretch of the rope
// (contiguous, shown alike, nothing between them) into one flat body, else
// sealed flat alone. A run typed long is then two segments — what was typed,
// one buffer, and the end being typed, a concatenation of SEG_MAX slots at
// most — for one copy of the run per SEG_MAX keystrokes.
const sealText = (d, run, last, items) => {
  const found = last.off > 0 ? SL.find(run.segs, last.off - 1) : null;
  const prev = found === null ? null : found.entry;
  const joins =
    prev !== null &&
    prev.body !== null &&
    prev.vis === last.vis &&
    prev.off + prev.len === last.off &&
    T.before(d.root, last, d.lineage) === prev;
  if (!joins) {
    seal(last.body);
    d.root = T.insertAfter(d.root, last, items, d.lineage);
    run.segs = SL.append(run.segs, items);
    return;
  }
  const joined = { ...prev, len: prev.len + last.len, body: prev.body + last.body, node: null };
  seal(joined.body);
  d.root = T.replace(d.root, last, items, d.lineage);
  d.root = T.replace(d.root, prev, [joined], d.lineage);
  run.segs = replacedIn(run.segs, prev, 2, [joined, ...items]);
};

// A cut of [offset, offset + length) of a placed run: the segments it
// crosses split, the pieces made gaps, neighbouring gaps joined.
const cutRun = (d, key, offset, length) => {
  let run = runOf(d, key);
  const end = Math.min(offset + length, run.len);
  let at = offset;
  while (at < end) {
    const seg = segOf(run, at);
    const k = at - seg.off;
    const n = Math.min(end - at, seg.len - k);
    if (seg.body === null) {
      at += n;
      continue;
    }
    const pieces = [];
    if (k > 0) pieces.push({ ...seg, len: k, body: seg.body.slice(0, k), node: null });
    const gap = { run: key, off: at, len: n, vis: false, body: null, node: null };
    pieces.push(gap);
    if (k + n < seg.len) {
      pieces.push({ ...seg, off: at + n, len: seg.len - k - n, body: seg.body.slice(k + n), node: null });
    }
    d.root = T.replace(d.root, seg, pieces, d.lineage);
    run = replaceSeg(d, key, seg, pieces);
    // The gap made, joined to its neighbours of the same run: one gap.
    let last = gap;
    const prev = T.before(d.root, gap, d.lineage);
    if (
      prev !== null &&
      prev.run === key &&
      prev.body === null &&
      prev.fence === undefined &&
      prev.off + prev.len === gap.off
    ) {
      const joined = { ...prev, len: prev.len + gap.len, node: null };
      d.root = T.replace(d.root, prev, [joined], d.lineage);
      d.root = T.replace(d.root, gap, [], d.lineage);
      run = copyRun(run);
      run.segs = replacedIn(run.segs, prev, 2, [joined]);
      run = setRun(d, run);
      last = joined;
    }
    const following = T.after(d.root, last, d.lineage);
    if (
      following !== null &&
      following.run === key &&
      following.body === null &&
      following.fence === undefined &&
      last.off + last.len === following.off
    ) {
      const joined = { ...last, len: last.len + following.len, node: null };
      d.root = T.replace(d.root, last, [joined], d.lineage);
      d.root = T.replace(d.root, following, [], d.lineage);
      run = copyRun(run);
      run.segs = replacedIn(run.segs, last, 2, [joined]);
      run = setRun(d, run);
    }
    at += n;
  }
};

// A slot of a placed list run hidden or shown — the position register
// moved: one segment split around it.
const setShown = (d, key, off, vis) => {
  const run = runOf(d, key);
  const seg = segOf(run, off);
  if (seg.body === null || seg.vis === vis) return;
  const k = off - seg.off;
  const pieces = [];
  if (k > 0) pieces.push({ ...seg, len: k, body: seg.body.slice(0, k), node: null });
  const one = { ...seg, off, len: 1, vis, body: seg.body.slice(k, k + 1), node: null };
  pieces.push(one);
  if (k + 1 < seg.len) {
    pieces.push({ ...seg, off: off + 1, len: seg.len - k - 1, body: seg.body.slice(k + 1), node: null });
  }
  d.root = T.replace(d.root, seg, pieces, d.lineage);
  replaceSeg(d, key, seg, pieces);
};

// Pending cuts and extensions of a run, applied as far as its length allows.
const settleRun = (d, key) => {
  for (;;) {
    const list = d.ext && own(d.ext, key);
    if (!list) break;
    const run = runOf(d, key);
    const len = run.len;
    // The extension that continues the run, and what lies past it still —
    // none for a position run (a move's), which holds its element alone.
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
    if (run.placed) extendRun(d, key, hit[1]);
    else setRun(d, { ...run, rle: rleAppend(d.kind, run.rle, hit[1]), len: len + hit[1].length });
    d.slots += run.placed ? 0 : hit[1].length;
  }
  const cuts = d.cuts && own(d.cuts, key);
  if (cuts) {
    const run = runOf(d, key);
    const len = run.len;
    const rest = [];
    for (const [offset, length] of cuts) {
      if (offset < len) {
        if (run.placed) cutRun(d, key, offset, Math.min(length, len - offset));
        else {
          const r = runOf(d, key);
          setRun(d, { ...r, rle: rleCut(d.kind, r.rle, offset, Math.min(length, len - offset)) });
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

// The same over a draft: what the op has added so far counts.
const pendingOfDraft = (d) => waiting(d, d.cuts, d.ext);

// Whether the block already waits to cut exactly this range of `key`.
const hasRange = (cuts, key, offset, length) => {
  const held = cuts ? own(cuts, key) : undefined;
  if (held === undefined) return false;
  for (let i = 0; i < held.length; i++) if (held[i][0] === offset && held[i][1] === length) return true;
  return false;
};

const addRange = (d, key, offset, length) => {
  const held = d.cuts && own(d.cuts, key);
  const list = held ? [...held] : [];
  list.push([offset, length]);
  d.cuts = { ...(d.cuts ?? {}), [key]: list };
  d.oldest = minStamp(d.oldest, stampOfKey(key));
};

// One `splice`: cuts first, then the insertion — a new run anchored at `at`,
// or `{ run, from }` extending a run of this origin. Returns the block it
// leaves and whether anything moved; `reason` names a refusal ('bound') or
// a payload the rule does not admit ('malformed'), either leaving the block
// as it was. `stamp` is the op's `[ts, origin]`.
const applySplice = (given, stamp, payload, base = null, pendingMax = PENDING_MAX) => {
  const [ts, origin] = stamp;
  const seq = asBlock(given, base);
  if (!payload || typeof payload !== 'object') return malformed(seq);
  const { cut, at, run, from, content, vals } = payload;
  // Values riding on the insertion — a text's embeds, each at an offset of
  // the content: `[[offset, value]]`, landed with the slots they name.
  if (vals !== undefined) {
    if (!Array.isArray(vals) || content === undefined) return malformed(seq);
    for (const pair of vals) {
      if (!Array.isArray(pair) || pair.length !== 2 || !Number.isInteger(pair[0]) || pair[0] < 0) return malformed(seq);
      if (pair[0] >= content.length || !isJson(pair[1]) || pair[1] === undefined) return malformed(seq);
    }
  }
  // A register like any other, last writer wins: an assign to one of these
  // slots that came first — from a node that saw the splice — keeps its
  // value when it is the newer, whichever arrived first.
  const assignVals = (d, runKeyOf, from) => {
    if (vals === undefined || vals.length === 0) return;
    let next = d.vals;
    for (const [offset, value] of vals) {
      const elem = elemKey(runKeyOf, from + offset);
      if (newer(next, elem, stamp)) next = P.set(next, elem, [ts, origin, value]);
    }
    d.vals = next;
  };
  // `content` always names the kind — a string for a text, an array for a
  // list — and inserts when it is not empty.
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
  if (run !== undefined && (!isRunKey(run) || !Number.isInteger(from) || from < 0)) return malformed(seq);
  // A run is extended by the origin that made it, nobody else: two origins
  // extending one run would leave the result to the order of arrival.
  if (run !== undefined && parseRun(run).origin !== origin) return malformed(seq);
  if (cut !== undefined) {
    for (const range of cut) {
      // An honest cutter saw the run it cuts, so the run is older than the op.
      const shape = Array.isArray(range) && range.length === 3 && isRunKey(range[0]) && parseRun(range[0]).ts < ts;
      if (!shape) return malformed(seq);
      const [, offset, length] = range;
      if (!Number.isInteger(offset) || offset < 0 || !isGap(length)) return malformed(seq);
    }
  }
  const st = STATE.get(seq);
  let d = null;
  const mutable = () => (d ??= draft(seq));
  let changed = false;
  const full = () => {
    const n = d === null ? pendingCount(seq) : pendingOfDraft(d);
    return n >= pendingMax ? refused(seq, 'pending', n, pendingMax) : null;
  };
  if (cut !== undefined) {
    for (const [key, offset, length] of cut) {
      // A cut of a run the base dropped is what the reset would drop: nothing.
      const made = parseRun(key);
      if (belowBase(made.ts, made.origin, base)) continue;
      const target = runOf(d ?? st, key);
      if (target === undefined || offset >= target.len) {
        if (hasRange(d === null ? seq.cuts : d.cuts, key, offset, length)) continue;
        const stop = full();
        if (stop !== null) return stop;
        addRange(mutable(), key, offset, length);
        changed = true;
        continue;
      }
      const inside = Math.min(length, target.len - offset);
      if (target.placed) {
        // Anything alive in the range? Else the cut changes nothing here.
        let alive = false;
        for (let o = offset; o < offset + inside && !alive;) {
          const seg = segOf(target, o);
          if (seg.body !== null) alive = true;
          o = seg.off + seg.len;
        }
        if (alive) {
          cutRun(mutable(), key, offset, inside);
          changed = true;
        }
      } else {
        const after = rleCut(seq.k, target.rle, offset, inside);
        if (!sameRle(after, target.rle)) {
          setRun(mutable(), { ...target, rle: after });
          changed = true;
        }
      }
      if (
        offset + length > target.len &&
        !hasRange(d === null ? seq.cuts : d.cuts, key, target.len, offset + length - target.len)
      ) {
        const stop = full();
        if (stop !== null) return stop;
        addRange(mutable(), key, target.len, offset + length - target.len);
        changed = true;
      }
    }
  }
  if (inserting) {
    if (content.length > MAX_RUN) return refused(seq, 'run', content.length, MAX_RUN);
    const slots = (d ?? st).slots + content.length;
    if (slots > MAX_FIELD) return refused(seq, 'field', slots, MAX_FIELD);
    if (at !== undefined) {
      const key = runKey(ts, origin);
      if (runOf(d ?? st, key) === undefined) {
        const record = recordOf(key, [at, isText(seq.k) ? [content] : [[...content]]], anchor);
        if (vals !== undefined) assignVals(mutable(), key, 0);
        const parent = anchor.elem === null ? null : runOf(d ?? st, anchor.elem.run);
        const rooted = anchor.elem === null || belowBase(anchor.elem.ts, anchor.elem.origin, base);
        const resolved = rooted || (parent !== undefined && anchor.elem.offset < parent.len);
        if (!resolved) {
          const stop = full();
          if (stop !== null) return stop;
        }
        const m = mutable();
        m.slots += record.len;
        m.ts = Math.max(m.ts, ts);
        m.oldest = minStamp(m.oldest, [ts, origin]);
        if (anchor.elem !== null) m.oldestAnchor = minStamp(m.oldestAnchor, [anchor.elem.ts, anchor.elem.origin]);
        if (resolved) {
          if (rooted || parent.placed) placeRun(m, record);
          else {
            setRun(m, record);
            attachChild(m, record);
            settleRun(m, key);
          }
        } else {
          setRun(m, record);
          const pending = pendingOf(m);
          const list = pending.get(anchor.elem.run) ? pending.get(anchor.elem.run).slice() : [];
          list.push(key);
          list.sort();
          pending.set(anchor.elem.run, list);
          m.pendingRuns++;
          settleRun(m, key);
        }
        changed = true;
      }
    } else {
      const target = runOf(d ?? st, run);
      // A position run (a move's) holds its element alone: grown, every
      // slot it took would show as that element.
      if (target !== undefined && target.elem !== null) return malformed(seq);
      if (target !== undefined) {
        const len = target.len;
        if (len + content.length > MAX_RUN) return refused(seq, 'run', len + content.length, MAX_RUN);
        if (from === len) {
          const m = mutable();
          assignVals(m, run, from);
          if (target.placed) extendRun(m, run, content);
          else {
            setRun(m, { ...target, rle: rleAppend(m.kind, target.rle, content), len: len + content.length });
            m.slots += content.length;
            settleRun(m, run);
          }
          changed = true;
        } else if (from > len) {
          const made = parseRun(run);
          if (belowBase(made.ts, made.origin, base)) return unchanged(seq);
          const stop = full();
          if (stop !== null) return stop;
          const m = mutable();
          const held = (m.ext && own(m.ext, run)) || NONE;
          let known = false;
          for (let i = 0; i < held.length && !known; i++) known = held[i][0] === from;
          if (!known) {
            const list = held.slice();
            list.push([from, isText(m.kind) ? content : [...content]]);
            m.ext = { ...(m.ext ?? {}), [run]: list };
            m.oldest = minStamp(m.oldest, stampOfKey(run));
            changed = true;
          }
        }
      }
    }
  }
  if (!changed) return unchanged(seq);
  return { seq: finish(d), changed: true, reason: null };
};

// ---- registers: assign and move -------------------------------------------

// A register write, LWW by stamp: false when the one the map holds is as new.
const newer = (map, key, stamp) => {
  const held = P.get(map, key);
  return held === undefined || compareClock([held[0], held[1]], stamp) < 0;
};

// An `assign`: the element's value register (a list's element, a text's embed slot).
const applyAssign = (given, stamp, payload, base = null, pendingMax = PENDING_MAX) => {
  const seq = asBlock(given, base);
  if (!payload || typeof payload !== 'object') return malformed(seq);
  const { elem, value } = payload;
  if (!isElemKey(elem) || !isJson(value) || value === undefined) return malformed(seq);
  const st = STATE.get(seq);
  if (!newer(st.vals, elem, stamp)) return unchanged(seq);
  if (P.get(st.vals, elem) === undefined && !holdsElem(st, elem)) {
    const n = pendingCount(seq);
    if (n >= pendingMax) return refused(seq, 'pending', n, pendingMax);
  }
  const d = draft(seq);
  d.vals = P.set(d.vals, elem, [stamp[0], stamp[1], value]);
  d.ts = Math.max(d.ts, stamp[0]);
  d.oldest = minStamp(d.oldest, stamp);
  return { seq: finish(d), changed: true, reason: null };
};

// The slot an element shows at under `pos`: its position run's one slot
// when a move named one, else its own; null when that run is not here.
const slotShowing = (d, elem) => {
  const winner = P.get(d.pos, elem);
  if (winner === undefined) {
    const e = parseElem(elem);
    const run = runOf(d, e.run);
    return run === undefined || e.offset >= run.len ? null : [e.run, e.offset];
  }
  return runOf(d, winner[2]) === undefined ? null : [winner[2], 0];
};

// A `move`: cuts the slot the element showed at, adds a position run that
// names it (whatever the register says — another node may anchor on it)
// and points the position register at that run when the stamp is newer.
const applyMove = (given, stamp, payload, base = null, pendingMax = PENDING_MAX) => {
  const [ts, origin] = stamp;
  const seq = asBlock(given, base);
  if (seq.k !== 'l' || !payload || typeof payload !== 'object') return malformed(seq);
  const { elem, cut, at, value } = payload;
  const anchor = parseAnchor(at);
  const cutOk = Array.isArray(cut) && cut.length === 3 && isRunKey(cut[0]) && parseRun(cut[0]).ts < ts;
  const anchorOk = anchor !== null && at !== END && (anchor.elem === null || anchor.elem.ts < ts);
  if (!isElemKey(elem) || !cutOk || !Number.isInteger(cut[1]) || cut[1] < 0 || cut[2] !== 1 || !anchorOk) {
    return malformed(seq);
  }
  if (!isJson(value) || value === undefined) return malformed(seq);
  const key = runKey(ts, origin);
  const st = STATE.get(seq);
  const moving = newer(st.pos, elem, stamp);
  if (moving && P.get(st.pos, elem) === undefined && !holdsElem(st, elem)) {
    const n = pendingCount(seq);
    if (n >= pendingMax) return refused(seq, 'pending', n, pendingMax);
  }
  const spliced = applySplice(seq, stamp, { cut: [cut], content: [] }, base, pendingMax);
  if (spliced.reason === 'bound') return spliced;
  const current = spliced.changed ? spliced.seq : seq;
  let changed = spliced.changed;
  let d = null;
  if (runOf(STATE.get(current), key) === undefined) {
    const parent = anchor.elem === null ? null : runOf(STATE.get(current), anchor.elem.run);
    const rooted = anchor.elem === null || belowBase(anchor.elem.ts, anchor.elem.origin, base);
    const resolved = rooted || (parent !== undefined && anchor.elem.offset < parent.len);
    if (!resolved) {
      const n = pendingCount(current);
      if (n >= pendingMax) return refused(seq, 'pending', n, pendingMax);
    }
    d = draft(current);
    const record = recordOf(key, [at, [[value]], elem]);
    d.slots += 1;
    d.ts = Math.max(d.ts, ts);
    d.oldest = minStamp(d.oldest, [ts, origin]);
    if (anchor.elem !== null) d.oldestAnchor = minStamp(d.oldestAnchor, [anchor.elem.ts, anchor.elem.origin]);
    // The register first, so the new run's slot shows or hides as it should.
    if (moving) {
      const was = slotShowing(d, elem);
      d.pos = P.set(d.pos, elem, [ts, origin, key]);
      if (was !== null) {
        const r = runOf(d, was[0]);
        if (r.placed) setShown(d, was[0], was[1], false);
      }
    }
    setRun(d, record);
    if (resolved && (rooted || parent.placed)) placeRun(d, record);
    else if (resolved) {
      attachChild(d, record);
      settleRun(d, key);
    } else {
      const pending = pendingOf(d);
      const list = pending.get(anchor.elem.run) ? pending.get(anchor.elem.run).slice() : [];
      list.push(key);
      list.sort();
      pending.set(anchor.elem.run, list);
      d.pendingRuns++;
      settleRun(d, key);
    }
    changed = true;
  } else if (moving) {
    d = draft(current);
    const was = slotShowing(d, elem);
    d.pos = P.set(d.pos, elem, [ts, origin, key]);
    if (was !== null) {
      const r = runOf(d, was[0]);
      if (r.placed) setShown(d, was[0], was[1], false);
    }
    const r = runOf(d, key);
    if (r.placed) setShown(d, key, 0, true);
    d.ts = Math.max(d.ts, ts);
    changed = true;
  }
  if (!changed) return unchanged(seq);
  return { seq: d === null ? current : finish(d), changed: true, reason: null };
};

module.exports = {
  draft,
  finish,
  settleRun,
  applySplice,
  applyAssign,
  applyMove,
};
