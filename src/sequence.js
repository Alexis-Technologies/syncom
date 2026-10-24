'use strict';

// The sequence engine behind the `list` and `text` field kinds: where an
// element goes, what a field reads as, and how two nodes' pictures of one
// field join. Pure functions over the plain JSON block Storage keeps in a
// record's meta (`meta.seqs[field]`); no requires beyond ./vector.js and
// ./rle.js (the run-length content), so it ships to the browser as it is.
//
// The ordering rule is Fugue (Weidner & Kleppmann, "The Art of the Fugue",
// 2023; reference: fugue-simple, MIT): every element has one place in a
// tree. A RUN is the elements one `splice` inserted, in order — one tree
// node per element, element i+1 the right child of element i under the
// run's origin. A new run is anchored at an element its writer saw: the
// RIGHT child of the element before the insertion point when that element
// has no right children (tombstones included), else the LEFT child of the
// leftmost descendant of its first right child. Same-side siblings are
// ordered by origin, then by stamp (two runs of one origin on one side only
// happen with forged ops). The reading is the pre-order walk of that tree:
// left children, the element if alive, right children. A run's own
// continuation is one of those right children, so consecutive inserts by
// one origin at the end of its run EXTEND the run instead of anchoring a new
// one (`{ run, from }`): the same tree, one key fewer per keystroke.
//
// Content is run-length encoded, list-positions style: `["ab", 3, "c"]`
// alternates present items (a string of a text, an array of a list) with
// gaps — tombstones collapsed to a length. A gap keeps the place: an anchor,
// a mark or a cursor into a deleted element still resolves. A CUT is a union
// of ranges per run, idempotent; one for a run not here yet waits in `cuts`,
// an extension ahead of its run's length in `ext`, a run whose anchor has not
// arrived stays in `runs` and out of the walk with its subtree — ops from
// different origins arrive in any order, and the tree is a function of the
// set of runs, never of their order of arrival. Each of those pending things
// counts against PENDING_MAX, a bound on hostile input like `sync.maxSkew`.
//
// A LIST is also movable (Kleppmann et al., "Moving elements in list
// CRDTs", 2020; Loro's MovableList): every element has, beside its place in
// the tree, two registers keyed by its name — `pos`, the position it shows
// at, and `vals`, its value — each last-writer-wins by stamp. A `move` cuts
// the slot the element showed at and adds a one-element POSITION run
// (`[at, [[value]], elem]`) that names the element; the register then points
// at that run. A slot shows iff it is alive and it is the position its
// element's register names (its own slot, when no move has named one), so
// two concurrent moves leave the element once, at the newer one's place, and
// a move concurrent with a cut of the old slot brings the element back at the
// new one. An `assign` sets the value register; a cut element keeps neither.
//
// A TEXT carries MARKS (Peritext, Litt et al. 2022; Loro's rich text): a
// mark is the range between two anchors — an element and a side, `<e` or
// `>e`, or the head `^` or the end `$` — with a key and a value, keyed by
// the stamp of the op that made it. Which side an anchor takes is what makes
// a style grow or not under text typed at its edge: a character typed after
// `e` is a right child of `e`, inside `>e` and outside `<next`; one typed
// before `e` is a left child, inside `>prev` and outside `<e` — the same
// tree rule that places the text. Per key, the newest mark covering a
// character wins and a null value is none; a mark flagged MANY stacks with
// every other of its key (comments) and goes only by its own id (OFF).
//
// A reset (`write`, `delete`) drops every run stamped below `base` — a run
// is as old as its first element — and a surviving run whose anchor fell
// reads as a right child of the head. `prune` applies the rule to a block,
// `applySplice` to each op as it lands, so meta, not only data, agrees
// whatever the order.
//
// What FugueMax would order differently: right siblings with different
// right origins — two runs may swap, their letters never mix. Adding that
// (a `rightOrigin` per run) changes the merge rule for new runs only, and
// is a PROTOCOL bump once the package is published.

const { compareClock } = require('./vector.js');
const {
  MAX_RUN,
  GAP,
  isText,
  present,
  isGap,
  rleLength,
  rleExpand,
  rleAppend,
  rleCut,
  sameRle,
  rleMerge,
  normalizeRle,
} = require('./rle.js');

// Pending work — runs waiting for their anchor, cuts and extensions waiting
// for their run, registers and switched-off marks for elements and marks not
// here — is bounded per field, on the op path and on the snapshot path
// alike: beyond it an op is refused (`bound`) and a peer's block is dropped.
const PENDING_MAX = 4096;
// A field holds at most MAX_FIELD slots, tombstones included (and a run
// MAX_RUN, src/rle.js's): the index allocates per slot, so a gap is the one
// thing a peer could make expensive for nothing. A field at MAX_FIELD takes
// nothing more until a reset.
const MAX_FIELD = 1 << 22;

// Keys: a run is `ts:origin` (the op that created it), an element
// `ts:offset:origin` — the offset in the middle so two indexOf calls parse
// it whatever the origin holds (`:` is allowed there; `@` and control
// characters are not). Canonical digits only, or one element would have
// two names.
const hasControl = (value) => {
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) < 32) return true;
  return false;
};
const isOrigin = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('@') && !hasControl(value);
const digits = (text, max) =>
  text.length > 0 && text.length <= 16 && /^\d+$/.test(text) && String(Number(text)) === text && Number(text) <= max;
const runKey = (ts, origin) => `${ts}:${origin}`;
const elemKey = (run, offset) => {
  const colon = run.indexOf(':');
  return `${run.slice(0, colon)}:${offset}:${run.slice(colon + 1)}`;
};
const parseRun = (key) => {
  if (typeof key !== 'string') return null;
  const colon = key.indexOf(':');
  if (colon === -1) return null;
  const ts = key.slice(0, colon);
  const origin = key.slice(colon + 1);
  if (!digits(ts, Number.MAX_SAFE_INTEGER) || !isOrigin(origin)) return null;
  return { ts: Number(ts), origin };
};
const parseElem = (key) => {
  if (typeof key !== 'string') return null;
  const first = key.indexOf(':');
  const second = first === -1 ? -1 : key.indexOf(':', first + 1);
  if (second === -1) return null;
  const ts = key.slice(0, first);
  const offset = key.slice(first + 1, second);
  const origin = key.slice(second + 1);
  if (!digits(ts, Number.MAX_SAFE_INTEGER) || !digits(offset, 2 ** 31 - 1) || !isOrigin(origin)) return null;
  return { ts: Number(ts), offset: Number(offset), origin, run: `${ts}:${origin}` };
};
const isRunKey = (key) => parseRun(key) !== null;
const isElemKey = (key) => parseElem(key) !== null;

// An anchor names a side of an element: `>e` (its right child), `<e` (its
// left child), `^` the head and `$` the end (marks and cursors only).
const HEAD = '^';
const END = '$';
const parseAnchor = (token) => {
  if (token === HEAD) return { side: 'R', elem: null };
  if (token === END) return { side: 'L', elem: null };
  if (typeof token !== 'string' || (token[0] !== '<' && token[0] !== '>')) return null;
  const elem = parseElem(token.slice(1));
  return elem === null ? null : { side: token[0] === '<' ? 'L' : 'R', elem };
};
const isAnchor = (token) => parseAnchor(token) !== null;

// The slots a block holds, tombstones included — through the memoized parse
// of each run (`parsedRun`), so a block of many runs is summed, not re-read.
const blockSlots = (seq) => {
  let n = 0;
  for (const key of Object.keys(seq.runs)) n += parsedRun(key, seq.runs[key]).len;
  return n;
};

// ---- the block -----------------------------------------------------------

const createSeq = (kind) => ({ k: kind, ts: 0, runs: {} });

// The newest stamp a block holds — its runs, registers and marks; cuts and
// extensions carry none of their own. Derived, so two nodes holding the
// same runs agree on it whatever else they saw along the way.
const stampsMax = (seq) => {
  let ts = 0;
  for (const key of Object.keys(seq.runs)) ts = Math.max(ts, parseRun(key).ts);
  for (const map of ['pos', 'vals']) for (const key of keysOf(seq[map])) ts = Math.max(ts, seq[map][key][0]);
  for (const key of keysOf(seq.marks)) ts = Math.max(ts, parseRun(key).ts);
  return ts;
};
const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
const keysOf = (object) => (object && typeof object === 'object' ? Object.keys(object) : []);

const isStamp = (value) => Number.isSafeInteger(value) && value > 0;
const isJson = (value) => value === null || ['string', 'number', 'boolean', 'object'].includes(typeof value);

// A peer's block, rebuilt into the trusted shape: every key of a known
// form, every run a canonical RLE of the block's kind anchored at an element
// older than itself, every anchor and register well-formed, the whole within
// MAX_FIELD slots and PENDING_MAX pending items under `base` (the entry's
// reset watermark, which decides what an orphan run is). Anything else is
// dropped; a block with nothing left, or past a bound, is null.
const normalizeSeq = (raw, base = null) => {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.k === 't' || raw.k === 'l' ? raw.k : null;
  if (kind === null) return null;
  const seq = createSeq(kind);
  let slots = 0;
  for (const key of keysOf(raw.runs)) {
    const run = raw.runs[key];
    const made = parseRun(key);
    if (made === null || !Array.isArray(run) || run.length < 2 || run.length > 3) continue;
    const anchor = parseAnchor(run[0]);
    if (anchor === null || run[0] === END || (anchor.elem !== null && anchor.elem.ts >= made.ts)) continue;
    const content = normalizeRle(kind, run[1]);
    if (content === null) continue;
    if (run.length === 3 && (kind !== 'l' || !isElemKey(run[2]))) continue;
    slots += rleLength(content);
    if (slots > MAX_FIELD) return null;
    seq.runs[key] = run.length === 3 ? [run[0], content, run[2]] : [run[0], content];
  }
  const ranges = (list) =>
    Array.isArray(list)
      ? list.filter((r) => Array.isArray(r) && r.length === 2 && Number.isInteger(r[0]) && r[0] >= 0 && isGap(r[1]))
      : [];
  for (const key of keysOf(raw.cuts)) {
    if (!isRunKey(key)) continue;
    const list = ranges(raw.cuts[key]).map(([o, n]) => [o, n]);
    if (list.length > 0) (seq.cuts ??= {})[key] = list;
  }
  for (const key of keysOf(raw.ext)) {
    if (!isRunKey(key) || !Array.isArray(raw.ext[key])) continue;
    const list = [];
    for (const item of raw.ext[key]) {
      if (!Array.isArray(item) || item.length !== 2 || !Number.isInteger(item[0]) || item[0] < 0) continue;
      const content = present(kind, item[1]) && item[1].length > 0 ? (isText(kind) ? item[1] : [...item[1]]) : null;
      if (content !== null) list.push([item[0], content]);
    }
    if (list.length > 0) (seq.ext ??= {})[key] = list;
  }
  const register = (raw2, check) => {
    const out = {};
    for (const key of keysOf(raw2)) {
      const v = raw2[key];
      if (isElemKey(key) && Array.isArray(v) && v.length === 3 && isStamp(v[0]) && isOrigin(v[1]) && check(v[2])) {
        out[key] = [v[0], v[1], v[2]];
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  };
  if (kind === 'l') {
    const pos = register(raw.pos, isRunKey);
    if (pos) seq.pos = pos;
    const vals = register(raw.vals, isJson);
    if (vals) seq.vals = vals;
  }
  if (kind === 't') {
    const marks = {};
    for (const key of keysOf(raw.marks)) {
      const m = raw.marks[key];
      const made = parseRun(key);
      if (made === null || !Array.isArray(m) || m.length !== 5) continue;
      const from = parseAnchor(m[0]);
      const to = parseAnchor(m[1]);
      if (from === null || to === null || typeof m[2] !== 'string' || !isJson(m[3])) continue;
      // An honest mark spans elements older than itself.
      if ((from.elem !== null && from.elem.ts >= made.ts) || (to.elem !== null && to.elem.ts >= made.ts)) continue;
      if (!Number.isInteger(m[4]) || m[4] < 0 || m[4] > 3) continue;
      marks[key] = [m[0], m[1], m[2], m[3], m[4]];
    }
    if (Object.keys(marks).length > 0) seq.marks = marks;
  }
  const empty = Object.keys(seq.runs).length === 0 && !seq.cuts && !seq.ext && !seq.marks && !seq.pos && !seq.vals;
  if (empty) return null;
  seq.ts = stampsMax(seq);
  // The same bound the op path keeps: a block a peer could not have built
  // through ops is not taken as state either.
  if (pendingCount(seq, buildIndex(seq, base)) > PENDING_MAX) return null;
  return seq;
};

// Copy-on-write: the block and its maps are shallow copies, the run arrays
// are shared and never mutated — a changed run is a new array.
const cloneSeq = (seq) => {
  const out = { k: seq.k, ts: seq.ts, runs: { ...seq.runs } };
  if (seq.cuts) out.cuts = { ...seq.cuts };
  if (seq.ext) out.ext = { ...seq.ext };
  if (seq.pos) out.pos = { ...seq.pos };
  if (seq.vals) out.vals = { ...seq.vals };
  if (seq.marks) out.marks = { ...seq.marks };
  return out;
};

// Whether the block holds the element `key` names: its run, long enough.
const holdsElem = (seq, key) => {
  const e = parseElem(key);
  const run = own(seq.runs, e.run);
  return run !== undefined && e.offset < rleLength(run[1]);
};

// What waits in a block: runs out of the walk, cuts and extensions of runs
// not here, registers of elements no run holds, marks switched off before
// they arrived — each one a thing a peer could pile up for nothing.
const pendingCount = (seq, index) => {
  let n = index.pending.size;
  for (const key of keysOf(seq.cuts)) n += seq.cuts[key].length;
  for (const key of keysOf(seq.ext)) n += seq.ext[key].length;
  for (const map of ['pos', 'vals']) {
    for (const key of keysOf(seq[map])) {
      const e = parseElem(key);
      const r = index.byKey.get(e.run);
      if (r === undefined || e.offset >= r.len) n++;
    }
  }
  for (const key of keysOf(seq.marks)) if (isPlaceholder(seq.marks[key])) n++;
  return n;
};

// A refusal for work past a bound: which bound, the count and the limit.
const refused = (seq, detail, count, max) => ({ seq, changed: false, reason: 'bound', detail, count, max });

// ---- the tree and its walk ----------------------------------------------

const byOrigin = (a, b) => (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : a.ts - b.ts);
const CONT = Symbol('continuation');

// What a run's tuple parses to, kept by the tuple: an unchanged run shares
// its tuple between a block and the next (cloneSeq copies the map, not the
// tuples), so a rebuild of the index parses only what changed. A tuple met
// under another key is parsed again, not trusted.
const PARSED = new WeakMap();
const parsedRun = (key, tuple) => {
  const hit = PARSED.get(tuple);
  if (hit !== undefined && hit.key === key) return hit;
  const { ts, origin } = parseRun(key);
  const [at, content, elem] = tuple;
  const parsed = {
    key,
    ts,
    origin,
    at,
    anchor: parseAnchor(at),
    content,
    items: rleExpand(content),
    len: rleLength(content),
    elem: elem ?? null,
  };
  PARSED.set(tuple, parsed);
  return parsed;
};

// Reads the block into an index: the runs with their children by element,
// the walk in order (every element, tombstones too) and the visible
// elements, with each element's walk ordinal and visible position.
const buildIndex = (seq, base = null) => {
  const keys = Object.keys(seq.runs);
  const runs = [];
  const byKey = new Map();
  let total = 0;
  for (const key of keys) {
    const p = parsedRun(key, seq.runs[key]);
    const r = {
      key,
      i: runs.length,
      ts: p.ts,
      origin: p.origin,
      at: p.at,
      anchor: p.anchor,
      content: p.content,
      items: p.items,
      len: p.len,
      elem: p.elem,
      // Where the run's slots sit in the index's per-slot arrays.
      start: total,
      L: null,
      R: null,
    };
    total += p.len;
    runs.push(r);
    byKey.set(key, r);
  }
  const root = [];
  const pending = new Set();
  for (const r of runs) {
    const { anchor } = r;
    if (anchor.elem === null) {
      root.push(r);
      continue;
    }
    const e = anchor.elem;
    if (base !== null && compareClock([e.ts, e.origin], base) < 0) {
      root.push(r);
      continue;
    }
    const parent = byKey.get(e.run);
    if (parent === undefined || e.offset >= parent.len) {
      pending.add(r.key);
      continue;
    }
    const side = anchor.side === 'L' ? 'L' : 'R';
    const map = (parent[side] ??= new Map());
    const list = map.get(e.offset);
    if (list) list.push(r);
    else map.set(e.offset, [r]);
  }
  root.sort(byOrigin);
  for (const r of runs) {
    if (r.L) for (const list of r.L.values()) list.sort(byOrigin);
    if (r.R) for (const list of r.R.values()) list.sort(byOrigin);
  }
  // The walk. Per slot (a run's start plus the offset): its ordinal, the
  // visible index at it, whether it shows.
  const ordRun = new Int32Array(total);
  const ordOff = new Int32Array(total);
  const visRun = new Int32Array(total);
  const visOff = new Int32Array(total);
  const ordAt = new Int32Array(total).fill(-1);
  const visAt = new Int32Array(total).fill(-1);
  const shown = new Uint8Array(total);
  let n = 0;
  let v = 0;
  const movable = seq.k === 'l';
  const visElem = movable ? [] : null;
  // A list slot shows when alive AND it is the position its element's
  // register names: its own slot when no move named one, else the position
  // run the newest move made.
  const shows = (r, off) => {
    if (r.items[off] === GAP) return false;
    if (!movable) return true;
    const elem = r.elem ?? elemKey(r.key, off);
    const winner = seq.pos && own(seq.pos, elem);
    if (winner === undefined) return r.elem === null;
    return r.elem === elem && r.key === winner[2];
  };
  const emit = (r, off) => {
    const slot = r.start + off;
    ordRun[n] = r.i;
    ordOff[n] = off;
    ordAt[slot] = n;
    visAt[slot] = v;
    n++;
    if (shows(r, off)) {
      visRun[v] = r.i;
      visOff[v] = off;
      shown[slot] = 1;
      if (movable) visElem.push(r.elem ?? elemKey(r.key, off));
      v++;
    }
  };
  const rightsOf = (r, off) => {
    const explicit = r.R?.get(off);
    const cont = off + 1 < r.len;
    if (!explicit) return cont ? [CONT] : [];
    if (!cont) return explicit;
    const rights = [];
    let placed = false;
    for (const c of explicit) {
      if (!placed && byOrigin(r, c) < 0) {
        rights.push(CONT);
        placed = true;
      }
      rights.push(c);
    }
    if (!placed) rights.push(CONT);
    return rights;
  };
  const stack = [];
  const frame = (r, off) => ({ r, off, phase: 0, i: 0, rights: null });
  for (const top of root) {
    stack.push(frame(top, 0));
    while (stack.length > 0) {
      const f = stack[stack.length - 1];
      if (f.phase === 0) {
        const left = f.r.L?.get(f.off);
        if (left && f.i < left.length) {
          stack.push(frame(left[f.i++], 0));
          continue;
        }
        emit(f.r, f.off);
        f.rights = rightsOf(f.r, f.off);
        f.phase = 1;
        f.i = 0;
      }
      if (f.i < f.rights.length) {
        const next = f.rights[f.i++];
        if (next === CONT) {
          if (f.rights.length === 1) {
            // Only the continuation: step in place instead of growing the stack.
            f.off++;
            f.phase = 0;
            f.i = 0;
            f.rights = null;
          } else stack.push(frame(f.r, f.off + 1));
        } else stack.push(frame(next, 0));
        continue;
      }
      stack.pop();
    }
  }
  const visible = visRun.subarray(0, v);
  const visibleOff = visOff.subarray(0, v);
  return {
    kind: seq.k,
    runs,
    byKey,
    root,
    pending,
    ordRun,
    ordOff,
    visRun: visible,
    visOff: visibleOff,
    visElem,
    ordAt,
    visAt,
    shown,
    vals: seq.vals ?? null,
    length: v,
    total: n,
  };
};

// The index of a block that differs from an indexed one by `content`
// appended to run `run` at `from` — the keystroke — made from the held
// index in one pass over the new slots instead of a walk over all of them.
// The new slots land at the end of the walk, so the arrays grow by `count`
// and nothing before them moves, when: the run is the last in key order
// (its slots end the per-slot arrays), its last slot was the last emitted
// (no explicit right child, no continuation), no run waits for an anchor
// (one could wait for a new slot), and no list register names a new
// element. Otherwise null, and the caller walks. The new run tuple's parse
// is registered too, so the next op's prune and slot count read it cached.
// A child list of another run may still hold the run record this one
// replaces; only `key`, `origin`, `ts`, `L` and `R` are read through those.
const extendIndex = (index, seq, { run, from, content }) => {
  const r = index.byKey.get(run);
  const count = content.length;
  if (r === undefined || r.len !== from || r.i !== index.runs.length - 1 || index.pending.size > 0) return null;
  if (index.total === 0 || index.ordAt[r.start + from - 1] !== index.total - 1) return null;
  const tuple = own(seq.runs, run);
  if (tuple === undefined || rleLength(tuple[1]) !== from + count) return null;
  const movable = seq.k === 'l';
  const tail = new Array(count);
  for (let i = 0; i < count; i++) {
    tail[i] = content[i];
    if (movable && seq.pos && own(seq.pos, elemKey(run, from + i)) !== undefined) return null;
  }
  const items = r.items.concat(tail);
  const len = from + count;
  PARSED.set(tuple, {
    key: run,
    ts: r.ts,
    origin: r.origin,
    at: r.at,
    anchor: r.anchor,
    content: tuple[1],
    items,
    len,
    elem: r.elem,
  });
  const r2 = { ...r, content: tuple[1], items, len };
  const runs = index.runs.slice();
  runs[r.i] = r2;
  const byKey = new Map(index.byKey);
  byKey.set(run, r2);
  const root = index.root.map((x) => (x === r ? r2 : x));
  const total = index.total + count;
  const length = index.length + count;
  const grow = (old, size) => {
    const out = new Int32Array(size);
    out.set(old);
    return out;
  };
  const ordRun = grow(index.ordRun, total);
  const ordOff = grow(index.ordOff, total);
  const visRun = grow(index.visRun, length);
  const visOff = grow(index.visOff, length);
  const ordAt = grow(index.ordAt, total);
  const visAt = grow(index.visAt, total);
  const shown = new Uint8Array(total);
  shown.set(index.shown);
  const visElem = movable ? index.visElem.slice() : null;
  for (let i = 0; i < count; i++) {
    const off = from + i;
    const slot = r.start + off;
    const ord = index.total + i;
    const vis = index.length + i;
    ordRun[ord] = r.i;
    ordOff[ord] = off;
    ordAt[slot] = ord;
    visAt[slot] = vis;
    shown[slot] = 1;
    visRun[vis] = r.i;
    visOff[vis] = off;
    if (movable) visElem.push(elemKey(run, off));
  }
  const out = {
    kind: seq.k,
    runs,
    byKey,
    root,
    pending: index.pending,
    ordRun,
    ordOff,
    visRun,
    visOff,
    visElem,
    ordAt,
    visAt,
    shown,
    vals: seq.vals ?? null,
    length,
    total,
  };
  // A text's reading grows by the content; a list's is read again (a value
  // register may name a new element).
  if (!movable && index.rendered !== undefined) out.rendered = index.rendered + content;
  return out;
};

// The value at visible index `i`: a text's character; a list element's
// assigned value when a register names one, else what its run holds.
const valueAt = (index, i) => {
  const held = index.runs[index.visRun[i]].items[index.visOff[i]];
  if (index.visElem === null || index.vals === null) return held;
  const assigned = own(index.vals, index.visElem[i]);
  return assigned === undefined ? held : assigned[2];
};

// What the field reads as: the visible elements in order — kept on the
// index, which is never mutated, so a second reading of one block is free
// and an extended index carries a text's reading over.
const render = (index) => {
  if (index.rendered !== undefined) return index.rendered;
  const { runs, visRun, visOff, length } = index;
  let out;
  if (index.kind === 't') {
    out = '';
    for (let i = 0; i < length; i++) out += runs[visRun[i]].items[visOff[i]];
  } else {
    out = new Array(length);
    for (let i = 0; i < length; i++) out[i] = valueAt(index, i);
  }
  index.rendered = out;
  return out;
};

// The element at visible index `i`: its name (a list element keeps it across
// moves; a text element's is its slot) or null out of range.
const elemAt = (index, i) => {
  if (i < 0 || i >= index.length) return null;
  return index.visElem !== null ? index.visElem[i] : elemKey(index.runs[index.visRun[i]].key, index.visOff[i]);
};

// The slot visible index `i` shows at, as a cut range.
const slotAt = (index, i) =>
  i >= 0 && i < index.length ? [index.runs[index.visRun[i]].key, index.visOff[i], 1] : null;

const leftmostDescendant = (r, off) => {
  for (;;) {
    const left = r.L?.get(off);
    if (!left || left.length === 0) return [r, off];
    r = left[0];
    off = 0;
  }
};

// Where a local insertion at visible index `i` goes: the anchor of a new
// run, or the run of this origin to extend. Null when `i` is out of range.
const placeInsert = (index, i, origin) => {
  if (!Number.isInteger(i) || i < 0 || i > index.length) return null;
  if (i === 0) {
    if (index.root.length === 0) return { at: HEAD };
    const [r, off] = leftmostDescendant(index.root[0], 0);
    return { at: `<${elemKey(r.key, off)}` };
  }
  const r = index.runs[index.visRun[i - 1]];
  const off = index.visOff[i - 1];
  const explicit = r.R?.get(off);
  const cont = off + 1 < r.len;
  if (!explicit && !cont) {
    // Own run, at its end: extend it — until it is full, then a new run
    // anchored after its last element reads the same.
    if (r.origin === origin && r.len < MAX_RUN) return { run: r.key, from: r.len };
    return { at: `>${elemKey(r.key, off)}` };
  }
  let first;
  if (!explicit) first = [r, off + 1];
  else if (!cont || byOrigin(explicit[0], r) < 0) first = [explicit[0], 0];
  else first = [r, off + 1];
  const [d, doff] = leftmostDescendant(first[0], first[1]);
  return { at: `<${elemKey(d.key, doff)}` };
};

// The visible elements [i, i + count) as cut ranges, grouped by run. Null
// when the range is not within the field.
const rangesOf = (index, i, count) => {
  if (!Number.isInteger(i) || !Number.isInteger(count) || i < 0 || count < 0 || i + count > index.length) return null;
  const out = [];
  for (let k = i; k < i + count; k++) {
    const key = index.runs[index.visRun[k]].key;
    const off = index.visOff[k];
    const last = out[out.length - 1];
    if (last && last[0] === key && last[1] + last[2] === off) last[2]++;
    else out.push([key, off, 1]);
  }
  return out;
};

// ---- applying ops --------------------------------------------------------

// Pending cuts and extensions of a run, applied as far as its length allows.
const settle = (seq, key) => {
  let run = seq.runs[key];
  let changed = false;
  for (;;) {
    let moved = false;
    const list = seq.ext && own(seq.ext, key);
    if (list) {
      const len = rleLength(run[1]);
      const rest = [];
      for (const [from, content] of list) {
        if (from === len && !moved) {
          run =
            run.length === 3
              ? [run[0], rleAppend(seq.k, run[1], content), run[2]]
              : [run[0], rleAppend(seq.k, run[1], content)];
          moved = true;
        } else if (from > len) rest.push([from, content]);
      }
      if (rest.length > 0) seq.ext[key] = rest;
      else {
        delete seq.ext[key];
        if (Object.keys(seq.ext).length === 0) delete seq.ext;
      }
    }
    if (moved) {
      seq.runs[key] = run;
      changed = true;
    } else break;
  }
  const cuts = seq.cuts && own(seq.cuts, key);
  if (cuts) {
    const len = rleLength(run[1]);
    const rest = [];
    let content = run[1];
    for (const [offset, length] of cuts) {
      if (offset < len) {
        content = rleCut(seq.k, content, offset, Math.min(length, len - offset));
        if (offset + length > len) rest.push([len, offset + length - len]);
      } else rest.push([offset, length]);
    }
    if (content !== run[1]) {
      seq.runs[key] = run.length === 3 ? [run[0], content, run[2]] : [run[0], content];
      changed = true;
    }
    if (rest.length > 0) seq.cuts[key] = rest;
    else {
      delete seq.cuts[key];
      if (Object.keys(seq.cuts).length === 0) delete seq.cuts;
    }
  }
  return changed;
};

// Whether the block already waits to cut exactly this range of `key`.
const hasRange = (seq, key, offset, length) => {
  const held = seq.cuts && own(seq.cuts, key);
  return held !== undefined && held.some(([o, n]) => o === offset && n === length);
};

// Adds a pending cut once: a range already waiting is not waited for twice
// (a join of two pictures that both hold it, the same op arriving again).
const addRange = (seq, key, offset, length) => {
  if (hasRange(seq, key, offset, length)) return false;
  const held = seq.cuts && own(seq.cuts, key);
  const list = held ? [...held] : [];
  list.push([offset, length]);
  (seq.cuts ??= {})[key] = list;
  return true;
};

// One `splice`: cuts first, then the insertion — a new run anchored at `at`,
// or `{ run, from }` extending a run of this origin. Returns the block it
// leaves and whether anything moved; `reason` names a refusal ('bound') or
// a payload the rule does not admit ('malformed'), either leaving the block
// as it was. `stamp` is the op's `[ts, origin]`.
const applySplice = (seq, stamp, payload, base = null, pendingMax = PENDING_MAX) => {
  const [ts, origin] = stamp;
  if (!payload || typeof payload !== 'object') return { seq, changed: false, reason: 'malformed' };
  const { cut, at, run, from, content } = payload;
  // `content` always names the kind — a string for a text, an array for a
  // list — and inserts when it is not empty.
  if (content === undefined || !present(seq.k, content)) return { seq, changed: false, reason: 'malformed' };
  const inserting = content.length > 0;
  if (cut !== undefined && !Array.isArray(cut)) return { seq, changed: false, reason: 'malformed' };
  if (!inserting && (cut === undefined || cut.length === 0)) return { seq, changed: false, reason: 'malformed' };
  if (!inserting && (at !== undefined || run !== undefined)) return { seq, changed: false, reason: 'malformed' };
  if (inserting && (at === undefined) === (run === undefined)) return { seq, changed: false, reason: 'malformed' };
  if (at !== undefined) {
    const anchor = parseAnchor(at);
    if (anchor === null || at === END || (anchor.elem !== null && anchor.elem.ts >= ts)) {
      return { seq, changed: false, reason: 'malformed' };
    }
  }
  if (run !== undefined && (!isRunKey(run) || !Number.isInteger(from) || from < 0)) {
    return { seq, changed: false, reason: 'malformed' };
  }
  // A run is extended by the origin that made it, nobody else: two origins
  // extending one run would leave the result to the order of arrival.
  if (run !== undefined && parseRun(run).origin !== origin) return { seq, changed: false, reason: 'malformed' };
  let next = null;
  const mutable = () => (next ??= cloneSeq(seq));
  let changed = false;
  // Set when the op did nothing but append to a run: what `extendIndex`
  // takes to carry the held block's index over instead of walking anew.
  let extended = null;
  let index = null;
  const indexOf = () => (index ??= buildIndex(next ?? seq, base));
  const pending = () => pendingCount(next ?? seq, indexOf());
  const full = () => {
    const n = pending();
    return n >= pendingMax ? refused(seq, 'pending', n, pendingMax) : null;
  };
  if (cut !== undefined) {
    for (const range of cut) {
      // An honest cutter saw the run it cuts, so the run is older than the op.
      const shape = Array.isArray(range) && range.length === 3 && isRunKey(range[0]) && parseRun(range[0]).ts < ts;
      if (!shape) return { seq, changed: false, reason: 'malformed' };
      const [, offset, length] = range;
      if (!Number.isInteger(offset) || offset < 0 || !isGap(length)) {
        return { seq, changed: false, reason: 'malformed' };
      }
    }
    for (const [key, offset, length] of cut) {
      const target = own(seq.runs, key);
      if (target === undefined || offset >= rleLength(target[1])) {
        if (hasRange(next ?? seq, key, offset, length)) continue;
        const stop = full();
        if (stop !== null) return stop;
        addRange(mutable(), key, offset, length);
        changed = true;
        continue;
      }
      const m = mutable();
      const before = m.runs[key];
      const len = rleLength(before[1]);
      const inside = Math.min(length, len - offset);
      const after = rleCut(m.k, before[1], offset, inside);
      if (!sameRle(after, before[1])) {
        m.runs[key] = before.length === 3 ? [before[0], after, before[2]] : [before[0], after];
        changed = true;
      }
      if (offset + length > len && !hasRange(m, key, len, offset + length - len)) {
        const stop = full();
        if (stop !== null) return stop;
        addRange(m, key, len, offset + length - len);
        changed = true;
      }
    }
  }
  if (inserting) {
    if (content.length > MAX_RUN) return refused(seq, 'run', content.length, MAX_RUN);
    const slots = blockSlots(next ?? seq) + content.length;
    if (slots > MAX_FIELD) return refused(seq, 'field', slots, MAX_FIELD);
    if (at !== undefined) {
      const key = runKey(ts, origin);
      if (own((next ?? seq).runs, key) === undefined) {
        const anchor = parseAnchor(at);
        const parent = anchor.elem === null ? null : own((next ?? seq).runs, anchor.elem.run);
        const resolved =
          anchor.elem === null ||
          (base !== null && compareClock([anchor.elem.ts, anchor.elem.origin], base) < 0) ||
          (parent !== undefined && anchor.elem.offset < rleLength(parent[1]));
        if (!resolved) {
          const stop = full();
          if (stop !== null) return stop;
        }
        const m = mutable();
        m.runs[key] = [at, isText(m.k) ? [content] : [[...content]]];
        m.ts = Math.max(m.ts, ts);
        settle(m, key);
        changed = true;
      }
    } else {
      const target = own((next ?? seq).runs, run);
      if (target !== undefined) {
        const len = rleLength(target[1]);
        if (len + content.length > MAX_RUN) return refused(seq, 'run', len + content.length, MAX_RUN);
        if (from === len) {
          const m = mutable();
          m.runs[run] =
            target.length === 3
              ? [target[0], rleAppend(m.k, target[1], content), target[2]]
              : [target[0], rleAppend(m.k, target[1], content)];
          // Nothing waited for this run and nothing was cut: the block differs
          // from the held one by these items appended, and the index can too.
          if (!settle(m, run) && cut === undefined) extended = { run, from: len, content };
          changed = true;
        } else if (from > len) {
          const stop = full();
          if (stop !== null) return stop;
          const m = mutable();
          const list = m.ext && own(m.ext, run) ? [...m.ext[run]] : [];
          if (!list.some(([f]) => f === from)) {
            list.push([from, isText(m.k) ? content : [...content]]);
            (m.ext ??= {})[run] = list;
            changed = true;
          }
        }
      }
    }
  }
  if (!changed) return { seq, changed: false, reason: null };
  return { seq: next, changed: true, reason: null, extended };
};

// ---- marks -----------------------------------------------------------

const MANY = 1;
const OFF = 2;
// What an `off` leaves for a mark not here yet: no anchors, no key, no value, switched off.
const PLACEHOLDER = [HEAD, HEAD, '', null, OFF];
const isPlaceholder = (m) => m[0] === HEAD && m[1] === HEAD && m[2] === '' && m[3] === null && (m[4] & OFF) !== 0;
const EXPANDS = { before: [true, false], after: [false, true], both: [true, true], none: [false, false] };
// Removing a style grows where the style would not and the other way round
// (Loro): both ↔ none, before and after stay.
const REVERSED = { before: 'before', after: 'after', both: 'none', none: 'both' };

// The anchors of a mark over visible [start, end) under an expand rule.
const markAnchors = (index, start, end, expand) => {
  const [before, after] = EXPANDS[expand];
  const at = (i) => elemAt(index, i);
  const from = before ? (start === 0 ? HEAD : `>${at(start - 1)}`) : start === index.length ? END : `<${at(start)}`;
  const to = after ? (end === index.length ? END : `<${at(end)}`) : end === 0 ? HEAD : `>${at(end - 1)}`;
  return [from, to];
};

// A `mark`: a new mark keyed by the op's stamp — first wins on a key — or
// `{ off }`, which flags an existing mark (or a placeholder for one not here
// yet) as removed by id. A mark that lands on its placeholder fills it in and
// stays off; the block's `ts` counts a placeholder by the id it names, so the
// two orders leave one block.
const applyMark = (seq, stamp, payload, base = null, pendingMax = PENDING_MAX) => {
  const [ts, origin] = stamp;
  if (seq.k !== 't' || !payload || typeof payload !== 'object') return { seq, changed: false, reason: 'malformed' };
  if (payload.off !== undefined) {
    const named = parseRun(payload.off);
    if (named === null) return { seq, changed: false, reason: 'malformed' };
    const held = seq.marks && own(seq.marks, payload.off);
    if (held !== undefined && (held[4] & OFF) !== 0) return { seq, changed: false, reason: null };
    if (held === undefined) {
      const n = pendingCount(seq, buildIndex(seq, base));
      if (n >= pendingMax) return refused(seq, 'pending', n, pendingMax);
    }
    const next = cloneSeq(seq);
    (next.marks ??= {})[payload.off] =
      held === undefined ? [...PLACEHOLDER] : [held[0], held[1], held[2], held[3], held[4] | OFF];
    next.ts = Math.max(next.ts, named.ts);
    return { seq: next, changed: true, reason: null };
  }
  const { start, end, key, value, many } = payload;
  const a = parseAnchor(start);
  const b = parseAnchor(end);
  const okAnchor = (x) => x !== null && (x.elem === null || x.elem.ts < ts);
  if (!okAnchor(a) || !okAnchor(b) || typeof key !== 'string' || !isJson(value) || value === undefined) {
    return { seq, changed: false, reason: 'malformed' };
  }
  if (many !== undefined && many !== true) return { seq, changed: false, reason: 'malformed' };
  const id = runKey(ts, origin);
  const held = seq.marks && own(seq.marks, id);
  if (held !== undefined && !isPlaceholder(held)) return { seq, changed: false, reason: null };
  const next = cloneSeq(seq);
  (next.marks ??= {})[id] = [start, end, key, value, (many ? MANY : 0) | (held === undefined ? 0 : OFF)];
  next.ts = Math.max(next.ts, ts);
  return { seq: next, changed: true, reason: null };
};

// Where an anchor falls in the walk: the ordinal before the element for
// `<e`, after it for `>e`; the head for `^`, an anchor below the base, or
// an element dropped by it; the end for `$`; null while the element has
// not arrived.
const anchorOrdinal = (index, token, base) => {
  if (token === HEAD) return 0;
  if (token === END) return index.total;
  const { side, elem } = parseAnchor(token);
  if (base !== null && compareClock([elem.ts, elem.origin], base) < 0) return 0;
  const r = index.byKey.get(elem.run);
  if (r === undefined || elem.offset >= r.len) return null;
  return index.ordAt[r.start + elem.offset] + (side === 'L' ? 0 : 1);
};

// Marks by key, then by stamp: the order their values are laid over one
// another in, so the newest of a key wins.
const byKeyThenStamp = (x, y) =>
  x.key < y.key ? -1 : x.key > y.key ? 1 : compareClock([x.ts, x.origin], [y.ts, y.origin]);

// The style of the marks in force at one point: per key the newest value,
// none when null; a MANY key lists every mark as `{ id, value }`.
const styleOf = (active) => {
  let marks = null;
  for (const m of [...active].sort(byKeyThenStamp)) {
    marks ??= {};
    if (m.many) (marks[m.key] ??= []).push({ id: m.id, value: m.value });
    else if (m.value === null) delete marks[m.key];
    else marks[m.key] = m.value;
  }
  return marks && Object.keys(marks).length > 0 ? marks : null;
};

// The text as runs of equal style: `[{ text, marks }]`. A mark whose anchor
// has not arrived is not shown yet. A sweep over the walk: each mark opens at
// its first ordinal and closes at its last, the visible characters come in
// ordinal order, and the style is read again only where a mark opened or
// closed — O(characters + marks × active), not O(characters × marks).
const spans = (index, seq, base = null) => {
  const { runs, visRun, visOff, length } = index;
  if (length === 0) return [];
  const ordOf = (i) => index.ordAt[runs[visRun[i]].start + visOff[i]];
  const events = [];
  for (const id of keysOf(seq.marks)) {
    const [from, to, key, value, flags] = seq.marks[id];
    if ((flags & OFF) !== 0) continue;
    const lo = anchorOrdinal(index, from, base);
    const hi = anchorOrdinal(index, to, base);
    if (lo === null || hi === null || lo >= hi) continue;
    const { ts, origin } = parseRun(id);
    const mark = { id, ts, origin, key, value, many: (flags & MANY) !== 0 };
    events.push([lo, 1, mark], [hi, -1, mark]);
  }
  // Closes before opens at one ordinal: `hi` is exclusive.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const active = new Set();
  const out = [];
  let e = 0;
  let style = null;
  let text = '';
  for (let i = 0; i < length; i++) {
    const ord = ordOf(i);
    let moved = false;
    while (e < events.length && events[e][0] <= ord) {
      const [, kind, mark] = events[e++];
      if (kind === 1) active.add(mark);
      else active.delete(mark);
      moved = true;
    }
    if (moved) {
      const next = styleOf(active);
      if (text.length > 0 && JSON.stringify(next) !== JSON.stringify(style)) {
        out.push({ text, marks: style ?? {} });
        text = '';
      }
      style = next;
    }
    text += runs[visRun[i]].items[visOff[i]];
  }
  out.push({ text, marks: style ?? {} });
  return out;
};

// ---- cursors ---------------------------------------------------------

// A place in the field that survives edits around it: the slot visible
// index `i` shows at, taken on its left (`<e`, the cursor stays before that
// element) or the one before on its right (`>e`, it stays after that one);
// the head or the end at the ends. Null out of range.
const cursorAt = (index, i, side) => {
  if (!Number.isInteger(i) || i < 0 || i > index.length) return null;
  const slot = (k) => elemKey(index.runs[index.visRun[k]].key, index.visOff[k]);
  if (side === 'after') return i === 0 ? HEAD : `>${slot(i - 1)}`;
  return i === index.length ? END : `<${slot(i)}`;
};

// Where a cursor is now: the visible elements before its slot, plus one
// for a slot still shown when the cursor sits after it. Null once the slot
// is gone — its run not here, or dropped by a reset.
const indexOfCursor = (index, token) => {
  if (token === HEAD) return 0;
  if (token === END) return index.length;
  const anchor = parseAnchor(token);
  if (anchor === null) return null;
  const r = index.byKey.get(anchor.elem.run);
  if (r === undefined || anchor.elem.offset >= r.len) return null;
  const slot = r.start + anchor.elem.offset;
  return index.visAt[slot] + (anchor.side === 'R' ? index.shown[slot] : 0);
};

// A register write, LWW by stamp: null when the held one is as new.
const newer = (map, key, stamp) => {
  const held = map && own(map, key);
  return held === undefined || compareClock([held[0], held[1]], stamp) < 0;
};

// A register for an element no run here holds is pending work, bounded like
// a cut: null to go on, a refusal to hand back.
const orphan = (seq, map, elem, base, pendingMax) => {
  if ((seq[map] && own(seq[map], elem) !== undefined) || holdsElem(seq, elem)) return null;
  const n = pendingCount(seq, buildIndex(seq, base));
  return n >= pendingMax ? refused(seq, 'pending', n, pendingMax) : null;
};

// An `assign`: the element's value register (lists only).
const applyAssign = (seq, stamp, payload, base = null, pendingMax = PENDING_MAX) => {
  if (seq.k !== 'l' || !payload || typeof payload !== 'object') return { seq, changed: false, reason: 'malformed' };
  const { elem, value } = payload;
  if (!isElemKey(elem) || !isJson(value) || value === undefined) return { seq, changed: false, reason: 'malformed' };
  if (!newer(seq.vals, elem, stamp)) return { seq, changed: false, reason: null };
  const stop = orphan(seq, 'vals', elem, base, pendingMax);
  if (stop !== null) return stop;
  const next = cloneSeq(seq);
  (next.vals ??= {})[elem] = [stamp[0], stamp[1], value];
  next.ts = Math.max(next.ts, stamp[0]);
  return { seq: next, changed: true, reason: null };
};

// A `move`: cuts the slot the element showed at, adds a position run that
// names it (whatever the register says — another node may anchor on it)
// and points the position register at that run when the stamp is newer.
const applyMove = (seq, stamp, payload, base = null, pendingMax = PENDING_MAX) => {
  const [ts, origin] = stamp;
  if (seq.k !== 'l' || !payload || typeof payload !== 'object') return { seq, changed: false, reason: 'malformed' };
  const { elem, cut, at, value } = payload;
  const anchor = parseAnchor(at);
  const cutOk = Array.isArray(cut) && cut.length === 3 && isRunKey(cut[0]) && parseRun(cut[0]).ts < ts;
  const anchorOk = anchor !== null && at !== END && (anchor.elem === null || anchor.elem.ts < ts);
  if (!isElemKey(elem) || !cutOk || !Number.isInteger(cut[1]) || cut[1] < 0 || cut[2] !== 1 || !anchorOk) {
    return { seq, changed: false, reason: 'malformed' };
  }
  if (!isJson(value) || value === undefined) return { seq, changed: false, reason: 'malformed' };
  const key = runKey(ts, origin);
  let next = null;
  const mutable = () => (next ??= cloneSeq(seq));
  const stop = newer(seq.pos, elem, stamp) ? orphan(seq, 'pos', elem, base, pendingMax) : null;
  if (stop !== null) return stop;
  const spliced = applySplice(seq, stamp, { cut: [cut], content: [] }, base, pendingMax);
  if (spliced.reason === 'bound') return spliced;
  if (spliced.changed) next = spliced.seq;
  if (own((next ?? seq).runs, key) === undefined) {
    const parent = anchor.elem === null ? null : own((next ?? seq).runs, anchor.elem.run);
    const resolved =
      anchor.elem === null ||
      (base !== null && compareClock([anchor.elem.ts, anchor.elem.origin], base) < 0) ||
      (parent !== undefined && anchor.elem.offset < rleLength(parent[1]));
    if (!resolved) {
      const n = pendingCount(next ?? seq, buildIndex(next ?? seq, base));
      if (n >= pendingMax) return refused(seq, 'pending', n, pendingMax);
    }
    const m = mutable();
    m.runs[key] = [at, [[value]], elem];
    m.ts = Math.max(m.ts, ts);
    settle(m, key);
  }
  if (newer((next ?? seq).pos, elem, stamp)) (mutable().pos ??= {})[elem] = [ts, origin, key];
  if (next === null) return { seq, changed: false, reason: null };
  return { seq: next, changed: true, reason: null };
};

// The reset rule: drops what is stamped below `base`. Null when nothing is left.
const below = (key, base) => {
  const parsed = parseRun(key);
  return compareClock([parsed.ts, parsed.origin], base) < 0;
};
const prune = (seq, base) => {
  if (base === null) return seq;
  let next = null;
  const mutable = () => (next ??= cloneSeq(seq));
  // A run's stamp through the tuple's parse (parsedRun): a block of
  // thousands of runs is pruned on every op after a reset.
  for (const key of Object.keys(seq.runs)) {
    const { ts, origin } = parsedRun(key, seq.runs[key]);
    if (compareClock([ts, origin], base) < 0) delete mutable().runs[key];
  }
  for (const map of ['cuts', 'ext', 'marks']) {
    for (const key of keysOf(seq[map])) {
      if (below(key, base)) {
        const m = mutable();
        delete m[map][key];
        if (Object.keys(m[map]).length === 0) delete m[map];
      }
    }
  }
  for (const map of ['pos', 'vals']) {
    for (const key of keysOf(seq[map])) {
      const [ts, origin] = seq[map][key];
      if (compareClock([ts, origin], base) < 0) {
        const m = mutable();
        delete m[map][key];
        if (Object.keys(m[map]).length === 0) delete m[map];
      }
    }
  }
  const out = next ?? seq;
  const empty = Object.keys(out.runs).length === 0 && !out.cuts && !out.ext && !out.marks && !out.pos && !out.vals;
  if (empty) return null;
  if (next !== null) next.ts = stampsMax(next);
  return out;
};

// Two nodes' pictures of one field joined: the union of runs (one run's two
// pictures merged), cuts, extensions and marks, the registers by stamp.
const join = (a, b) => {
  const out = createSeq(a.k);
  out.ts = Math.max(a.ts, b.ts);
  for (const key of Object.keys(a.runs)) out.runs[key] = a.runs[key];
  for (const key of Object.keys(b.runs)) {
    const mine = own(out.runs, key);
    if (mine === undefined) out.runs[key] = b.runs[key];
    else {
      const theirs = b.runs[key];
      const content = rleMerge(a.k, mine[1], theirs[1]);
      out.runs[key] =
        mine.length === 3 || theirs.length === 3 ? [mine[0], content, mine[2] ?? theirs[2]] : [mine[0], content];
    }
  }
  for (const side of [a, b]) {
    for (const key of keysOf(side.cuts)) for (const [o, n] of side.cuts[key]) addRange(out, key, o, n);
    for (const key of keysOf(side.ext)) {
      const list = out.ext && own(out.ext, key) ? out.ext[key] : [];
      for (const item of side.ext[key]) if (!list.some(([f]) => f === item[0])) list.push(item);
      (out.ext ??= {})[key] = list;
    }
    for (const map of ['pos', 'vals']) {
      for (const key of keysOf(side[map])) {
        const theirs = side[map][key];
        const mine = out[map] && own(out[map], key);
        const newer = mine === undefined || compareClock([theirs[0], theirs[1]], [mine[0], mine[1]]) > 0;
        if (newer) (out[map] ??= {})[key] = theirs;
      }
    }
    for (const key of keysOf(side.marks)) {
      const theirs = side.marks[key];
      const mine = out.marks && own(out.marks, key);
      if (mine === undefined) (out.marks ??= {})[key] = theirs;
      else if (theirs[4] !== mine[4] || isPlaceholder(mine) !== isPlaceholder(theirs)) {
        // The filled-in mark over its placeholder, the flags of both.
        const filled = isPlaceholder(mine) ? theirs : mine;
        out.marks[key] = [filled[0], filled[1], filled[2], filled[3], mine[4] | theirs[4]];
      }
    }
  }
  for (const key of Object.keys(out.runs)) settle(out, key);
  return out;
};

module.exports = {
  PENDING_MAX,
  MAX_RUN,
  MAX_FIELD,
  HEAD,
  END,
  runKey,
  elemKey,
  parseRun,
  parseElem,
  parseAnchor,
  isRunKey,
  isElemKey,
  isAnchor,
  rleLength,
  rleAppend,
  rleCut,
  rleMerge,
  normalizeRle,
  createSeq,
  normalizeSeq,
  cloneSeq,
  buildIndex,
  extendIndex,
  render,
  valueAt,
  elemAt,
  placeInsert,
  rangesOf,
  applySplice,
  applyAssign,
  applyMove,
  applyMark,
  markAnchors,
  anchorOrdinal,
  spans,
  slotAt,
  cursorAt,
  indexOfCursor,
  REVERSED,
  MANY,
  OFF,
  prune,
  join,
  pendingCount,
};
