'use strict';

// The sequence engine behind the `list` and `text` field kinds: where an
// element goes, what a field reads as, and how two nodes' pictures of one
// field join. The block Storage keeps in a record's meta (`meta.blocks[field]`)
// reads as plain JSON — `{ k, ts, runs, cuts, ext, pos, vals, marks }` — and
// serializes as such, but is a ROPE underneath: the walk of the Fugue tree
// kept as a persistent B+-tree of segments (./btree.js), the run records in
// a persistent map (./pmap.js), so a keystroke, a cut, a cursor and a
// reading are O(log n) and never walk the field again. No requires beyond
// ../vector.js, ../plugin.js, ./rle.js and those two.
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
// THE ROPE. The walk is kept, not recomputed: a leaf item is a SEGMENT —
// consecutive slots of one run that read alike (`len`, `vis` when they
// show, `body` the items or null for a gap) — or a FENCE, the open or the
// close of a run's subtree, so where a child goes is always "before this
// fence" or "after that segment", found by identity. The tree measures
// slots and visible slots, so a visible index locates its segment in
// O(log n), and the hints (./btree.js) give a segment's position the same
// way for the HEAD version — the newest block of a lineage, the one an op
// lands on; a block that is no longer the head and is asked a position or
// an edit is rebuilt from its JSON first (`rebuilds` counts them). The
// tree, the run map and the block are copied by path: an op leaves a new
// block and shares what it did not touch, and an older block reads as it
// was. The JSON of a block (`runs`) is made from the rope when asked and
// kept for that version; its key order is the walk's.
//
// Content is run-length encoded, list-positions style: `["ab", 3, "c"]`
// alternates present items (a string of a text, an array of a list) with
// gaps — tombstones collapsed to a length. A gap keeps the place: an anchor,
// a mark or a cursor into a deleted element still resolves. A CUT is a union
// of ranges per run, idempotent; one for a run not here yet waits in `cuts`,
// an extension ahead of its run's length in `ext`, a run whose anchor has not
// arrived waits out of the walk with its subtree — ops from different
// origins arrive in any order, and the tree is a function of the set of
// runs, never of their order of arrival. A run is extended by its origin
// alone: another origin's `{ run, from }` is malformed, or the result would
// be the order of arrival. Each of those pending things counts against
// PENDING_MAX (`sync.pendingMax`), a run against MAX_RUN (./rle.js) and a
// field against MAX_FIELD — bounds on hostile input like `sync.maxSkew`,
// checked where an op lands (`applySplice`, `bound`) and where a peer's block
// is normalized (`normalizeSeq`) alike, so a snapshot buys nothing an op
// could not.
//
// A LIST is also movable (Kleppmann et al., "Moving elements in list
// CRDTs", 2020; Loro's MovableList): every element has, beside its place in
// the tree, two registers keyed by its name — `pos`, the position it shows
// at, and `vals`, its value — each last-writer-wins by stamp (a TEXT keeps
// `vals` too: the marker of an embed slot, U+FFFC, set with the splice that
// inserts the slot or by an `assign`; the engine knows no marker's shape,
// src/text/text.js reads it). A `move` cuts
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
// every other of its key (comments) and goes only by its own id (OFF). On
// one key the two mix in stamp order: a plain mark (a null one too) takes
// the place of what is there, a stack included, and a MANY mark newer than
// it starts a stack over it.
//
// A reset (`write`, `delete`) drops every run stamped below `base` — a run
// is as old as its first element — and a surviving run whose anchor fell
// reads as a right child of the head. `prune` applies the rule to a block
// once, at the reset, by rebuilding it under the new base; an op never adds
// what the base would drop (a cut or an extension of a run below it, a run
// below it), so meta, not only data, agrees whatever the order.
//
// What FugueMax would order differently: right siblings with different
// right origins — two runs may swap, their letters never mix. Adding that
// (a `rightOrigin` per run) changes the merge rule for new runs only, and
// is a PROTOCOL bump once the package is published.

const { compareClock } = require('../vector.js');
const { PENDING_MAX } = require('../plugin.js');
const T = require('./btree.js');
const P = require('./pmap.js');
const SL = require('./plist.js');
const {
  MAX_RUN,
  isText,
  present,
  isGap,
  rleLength,
  segLength,
  rleAppend,
  rleCut,
  sameRle,
  rleMerge,
  normalizeRle,
} = require('./rle.js');

// Pending work — runs waiting for their anchor, cuts and extensions waiting
// for their run, registers and switched-off marks for elements and marks not
// here — is bounded per field (PENDING_MAX, src/plugin.js), on the op path
// and on the snapshot path alike: beyond it an op is refused (`bound`) and a
// peer's block is dropped.
// A field holds at most MAX_FIELD slots, tombstones included (and a run
// MAX_RUN, src/rle.js's): a gap is the one thing a peer could make expensive
// for nothing. A field at MAX_FIELD takes nothing more until a reset.
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
const digits = (text, max) => {
  const n = text.length;
  if (n === 0 || n > 16 || (n > 1 && text.charCodeAt(0) === 48)) return false;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return Number(text) <= max;
};
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

const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
const keysOf = (object) => (object && typeof object === 'object' ? Object.keys(object) : []);
const isStamp = (value) => Number.isSafeInteger(value) && value > 0;
const isJson = (value) => value === null || ['string', 'number', 'boolean', 'object'].includes(typeof value);
const byOrigin = (a, b) => (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : a.ts - b.ts);
const minStamp = (a, b) => (a === null || compareClock(b, a) < 0 ? b : a);
// The older of a stamp and `[ts, origin]`: the stamp itself while it is not newer.
const olderOf = (a, ts, origin) => (a === null || ts < a[0] || (ts === a[0] && origin < a[1]) ? [ts, origin] : a);

// ---- the block ------------------------------------------------------------

// The engine's state of a block, beside the plain object the record meta
// holds: the rope, the run records, what waits, the counts the bounds read,
// the lineage and what is cached for this version.
const STATE = new WeakMap();

// How many blocks were rebuilt from their JSON because they were asked a
// position or an edit while no longer the head of their lineage.
const counters = { rebuilds: 0 };

// A block as the record meta holds it: `k` and `ts` as fields, `runs` as
// the walk-order JSON of the rope, made when read, the other maps as given
// (absent when empty) — the shape a peer's block has, in the key order
// `plainOf` gives, so deepEqual, JSON.stringify, the signed form and a
// snapshot see a plain block; nothing else is on it (what it reads as is
// asked of the engine: `lengthOf`, `totalOf`, `render`).
const MAPS = ['cuts', 'ext', 'pos', 'vals', 'marks'];
const createBlock = (kind, ts, maps, state) => {
  const block = {
    k: kind,
    ts,
    get runs() {
      return runsJson(this);
    },
  };
  for (const name of MAPS) {
    const map = maps[name];
    if (map !== undefined && map !== null && Object.keys(map).length > 0) block[name] = map;
  }
  STATE.set(block, state);
  return block;
};

const plainOf = (block) => {
  const out = { k: block.k, ts: block.ts, runs: runsJson(block) };
  for (const name of MAPS) if (block[name] !== undefined) out[name] = block[name];
  return out;
};

// A run's content as one canonical RLE: its segments in offset order, the
// pieces that read alike joined.
const rleOf = (kind, run) => {
  if (!run.placed) return run.rle;
  const out = [];
  for (const chunk of run.segs.chunks) {
    for (const seg of chunk) {
      const last = out.length - 1;
      if (seg.body === null) {
        if (last >= 0 && typeof out[last] === 'number') out[last] += seg.len;
        else out.push(seg.len);
      } else if (last >= 0 && typeof out[last] !== 'number') {
        out[last] = isText(kind) ? out[last] + seg.body : out[last].concat(seg.body);
      } else out.push(isText(kind) ? seg.body : seg.body.slice());
    }
  }
  return out;
};

const tupleOf = (kind, run) => (run.elem !== null ? [run.at, rleOf(kind, run), run.elem] : [run.at, rleOf(kind, run)]);

// The `runs` map of a block, in walk order then the pending ones by key;
// made once per version.
const runsJson = (block) => {
  const st = STATE.get(block);
  if (st.json !== null) return st.json;
  const out = {};
  for (const item of T.iterate(st.root)) {
    if (item.fence === 1) out[item.run] = tupleOf(st.kind, P.get(st.runs, item.run));
  }
  // What is not in the walk — a run waiting for its anchor, and what waits
  // under it — by key.
  const waiting = [];
  for (const [key, run] of P.entries(st.runs)) if (!run.placed) waiting.push(key);
  waiting.sort();
  for (const key of waiting) out[key] = tupleOf(st.kind, P.get(st.runs, key));
  st.json = out;
  return out;
};

/** An empty block of a kind. */
const createSeq = (kind) => hydrate({ k: kind, ts: 0, runs: {} }, null);

// ---- normalizing a peer's block --------------------------------------------

// A peer's block (or any plain one), checked into the canonical plain shape:
// every key of a known form, every run a canonical RLE of the block's kind
// anchored at an element older than itself, every anchor and register
// well-formed, the whole within MAX_FIELD slots. Anything else is dropped;
// a block with nothing left, or past the field bound, is null.
const normalizeJson = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.k === 't' || raw.k === 'l' ? raw.k : null;
  if (kind === null) return null;
  const seq = { k: kind, ts: 0, runs: {} };
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
  }
  // A value per element: a list element's assigned value, a text's embed.
  const vals = register(raw.vals, isJson);
  if (vals) seq.vals = vals;
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
  return seq;
};

// The newest stamp a plain block holds — its runs, registers and marks; cuts
// and extensions carry none of their own. Derived, so two nodes holding the
// same runs agree on it whatever else they saw along the way.
const stampsMax = (seq) => {
  let ts = 0;
  for (const key of Object.keys(seq.runs)) ts = Math.max(ts, parseRun(key).ts);
  for (const map of ['pos', 'vals']) for (const key of keysOf(seq[map])) ts = Math.max(ts, seq[map][key][0]);
  for (const key of keysOf(seq.marks)) ts = Math.max(ts, parseRun(key).ts);
  return ts;
};

/**
 * A peer's block, rebuilt into the trusted shape and the rope under `base`
 * (the entry's reset watermark, which decides what an orphan run is), within
 * MAX_FIELD slots and `pendingMax` pending items (the node's
 * `sync.pendingMax`, PENDING_MAX by default). Anything malformed is dropped;
 * a block with nothing left, or past a bound, is null.
 */
const normalizeSeq = (raw, base = null, pendingMax = PENDING_MAX) => {
  const seq = normalizeJson(raw);
  if (seq === null) return null;
  seq.ts = stampsMax(seq);
  const block = hydrate(seq, base);
  // The same bound the op path keeps: a block a peer could not have built
  // through ops is not taken as state either.
  if (pendingCount(block) > pendingMax) return null;
  return block;
};

// ---- the rope: hydration -----------------------------------------------------

// Whether an element's stamp fell below the base: its run was dropped, and
// a run anchored at it reads from the head.
const belowBase = (ts, origin, base) => base !== null && compareClock([ts, origin], base) < 0;

// A run record from its tuple, unplaced.
const recordOf = (key, tuple, anchor = parseAnchor(tuple[0])) => {
  const { ts, origin } = parseRun(key);
  const [at, content, elem] = tuple;
  return {
    key,
    ts,
    origin,
    at,
    anchor,
    elem: elem ?? null,
    len: rleLength(content),
    placed: false,
    rle: content,
    segs: null,
    open: null,
    close: null,
    L: null,
    R: null,
    tails: 0,
  };
};

// Whether slot `off` of `run` shows, beside being alive: a list slot shows
// when it is the position its element's register names — its own slot when
// no move named one, else the position run the newest move made.
const showsAt = (kind, pos, run, off) => {
  if (!isText(kind) && kind !== 't') {
    const elem = run.elem ?? elemKey(run.key, off);
    const winner = pos ? own(pos, elem) : undefined;
    if (winner === undefined) return run.elem === null;
    return run.elem === elem && run.key === winner[2];
  }
  return true;
};

// Where each piece of a run's content starts, the first at `base`.
const ONE_START = Object.freeze([0]);
const startsOf = (pieces, base = 0) => {
  if (pieces.length === 1 && base === 0) return ONE_START;
  const out = new Array(pieces.length);
  let at = base;
  for (let i = 0; i < pieces.length; i++) {
    out[i] = at;
    at += segLength(pieces[i]);
  }
  return out;
};
// The piece holding offset `off` (the last that starts at or before it).
const pieceAt = (starts, off) => {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= off) lo = mid;
    else hi = mid - 1;
  }
  return lo;
};

// A segment of `len` slots of `r` at `off` after the items `out` holds,
// joined to the last when it continues it (same run, next slot, shown
// alike, both alive or both gaps); a new one goes into the run's `segs` too.
const pushSeg = (r, off, len, vis, body, out) => {
  const last = out[out.length - 1];
  if (
    last !== undefined &&
    last.fence === undefined &&
    last.run === r.key &&
    last.off + last.len === off &&
    last.vis === vis &&
    (last.body === null) === (body === null)
  ) {
    last.len += len;
    if (body !== null) {
      if (typeof body === 'string') last.body += body;
      else for (const value of body) last.body.push(value);
    }
    return;
  }
  const seg = { run: r.key, off, len, vis, body, node: null };
  out.push(seg);
  r.segs.push(seg);
};

// The segments of slots [from, to) of `r`, from its content pieces (`r.rle`,
// starting at `starts`): a piece is one segment — a text's piece its own
// string, a gap a gap — unless the run is a list under moves, where each
// slot shows or not by its register.
const emitPieces = (kind, pos, r, starts, from, to, out) => {
  const pieces = r.rle;
  const text = isText(kind);
  const perSlot = !text && pos !== null;
  for (let p = pieceAt(starts, from); p < pieces.length; p++) {
    const start = starts[p];
    if (start >= to) break;
    const piece = pieces[p];
    const end = start + segLength(piece);
    const a = Math.max(from, start);
    const b = Math.min(to, end);
    if (a >= b) continue;
    if (typeof piece === 'number') pushSeg(r, a, b - a, false, null, out);
    else if (!perSlot) {
      const whole = a === start && b === end && text;
      pushSeg(r, a, b - a, text || r.elem === null, whole ? piece : piece.slice(a - start, b - start), out);
    } else for (let o = a; o < b; o++) pushSeg(r, o, 1, showsAt(kind, pos, r, o), [piece[o - start]], out);
  }
};

// The segments of `content` as the slots of `run` from `from` on.
const segmentsOf = (kind, pos, run, from, content) => {
  const out = [];
  const r = { key: run.key, elem: run.elem, rle: content, segs: [] };
  emitPieces(kind, pos, r, startsOf(content, from), from, from + rleLength(content), out);
  return out;
};

// The keys of the children hung at offset `off` on one side of a run (its
// `L` or `R` list, ./plist.js entries `{ off, keys }`), or undefined.
const childrenAt = (list, off) => (list === null ? undefined : SL.get(list, off)?.keys);
const byOff = (a, b) => a.off - b.off;
// One side's children from its entries as they were gathered: each list
// by origin, the entries by offset.
const childrenList = (entries, sorter) => {
  for (const entry of entries) if (entry.keys.length > 1) entry.keys.sort(sorter);
  if (entries.length > 1) entries.sort(byOff);
  return SL.fromArray(entries);
};

const openOf = (key) => ({ run: key, len: 0, vis: false, fence: 1, node: null });
const closeOf = (key) => ({ run: key, len: 0, vis: false, fence: 2, node: null });

// The offsets of a run where a child hangs, in order — where the walk of
// its content stops; the stretches between are emitted piece by piece.
const EMPTY_EVENTS = Object.freeze([]);
const offsetsOf = (list) => {
  const out = new Array(list.size);
  let i = 0;
  for (const chunk of list.chunks) for (const entry of chunk) out[i++] = entry.off;
  return out;
};
const eventsOf = (r) => {
  if (r.L === null) return r.R === null ? EMPTY_EVENTS : offsetsOf(r.R);
  if (r.R === null) return offsetsOf(r.L);
  // Both sides, merged.
  const a = offsetsOf(r.L);
  const b = offsetsOf(r.R);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i] < b[j])) out.push(a[i++]);
    else if (i >= a.length || b[j] < a[i]) out.push(b[j++]);
    else {
      out.push(a[i++]);
      j++;
    }
  }
  return out;
};

// The walk of run `top` and the runs attached under it (their L/R maps),
// as the items of the rope in order: a frame is a run at an offset; the
// continuation of a run steps the frame in place when it is the only right
// child, else it is a frame of its own; a run's close fence falls when the
// frame it was entered by pops. Every run walked comes back as a placed
// COPY (`copies`), its segments and fences set; the records read through
// `getRun` are left as they are — unless `copies` is the map they are read
// from, which then holds the copies in their place.
const CONT = null;
const ONLY_CONT = Object.freeze([CONT]);
const NO_RIGHTS = Object.freeze([]);
// A walk: what it reads runs through, what it emits, the copies it makes —
// or, when the records are the walk's own (`own`: a hydration's, shared
// with nothing yet), the records themselves placed in place.
const runAt = (w, key) => w.copies.get(key) ?? w.getRun(key);
// The right children of slot `off` of `r` in walk order, the continuation
// among them by origin (null stands for it).
const rightsOf = (w, r, off) => {
  const explicit = childrenAt(r.R, off);
  const cont = off + 1 < r.len;
  if (explicit === undefined) return cont ? ONLY_CONT : NO_RIGHTS;
  if (!cont) return explicit;
  const rights = [];
  let placed = false;
  for (const c of explicit) {
    if (!placed && byOrigin(r, runAt(w, c)) < 0) {
      rights.push(CONT);
      placed = true;
    }
    rights.push(c);
  }
  if (!placed) rights.push(CONT);
  return rights;
};
// The placed copy of a run: its content kept as pieces while it is walked.
const enter = (w, key) => {
  const g = runAt(w, key);
  if (w.own) {
    g.placed = true;
    g.segs = [];
    g.open = openOf(key);
    w.items.push(g.open);
    return g;
  }
  const r = {
    key,
    ts: g.ts,
    origin: g.origin,
    at: g.at,
    anchor: g.anchor,
    elem: g.elem,
    len: g.len,
    placed: true,
    rle: g.rle,
    segs: [],
    open: openOf(key),
    close: null,
    L: g.L,
    R: g.R,
    tails: g.tails,
  };
  w.copies.set(key, r);
  w.items.push(r.open);
  return r;
};
const leave = (w, r) => {
  r.close = closeOf(r.key);
  w.items.push(r.close);
  r.rle = null;
  r.segs = SL.fromArray(r.segs);
};
const frameOf = (r, off, first, ev, starts) => ({ r, off, phase: 0, i: 0, rights: null, first, ev, ei: 0, starts });
const openFrame = (w, key) => {
  const r = enter(w, key);
  return frameOf(r, 0, true, eventsOf(r), startsOf(r.rle));
};
const walkSubtree = (getRun, kind, pos, topKey, items = [], copies = new Map(), own = false) => {
  const w = { getRun, copies, items, own };
  const stack = [openFrame(w, topKey)];
  while (stack.length > 0) {
    const f = stack[stack.length - 1];
    const { r } = f;
    if (f.phase === 0) {
      // The stretch up to the next offset a child hangs at, in pieces.
      const { ev } = f;
      while (f.ei < ev.length && ev[f.ei] < f.off) f.ei++;
      const e = f.ei < ev.length ? ev[f.ei] : r.len;
      if (e > f.off) {
        emitPieces(kind, pos, r, f.starts, f.off, e, items);
        f.off = e;
        if (e >= r.len) {
          if (f.first) leave(w, r);
          stack.pop();
          continue;
        }
      }
      const left = childrenAt(r.L, f.off);
      if (left !== undefined && f.i < left.length) {
        stack.push(openFrame(w, left[f.i++]));
        continue;
      }
      emitPieces(kind, pos, r, f.starts, f.off, f.off + 1, items);
      f.rights = rightsOf(w, r, f.off);
      f.phase = 1;
      f.i = 0;
    }
    if (f.i < f.rights.length) {
      const nextRight = f.rights[f.i++];
      if (nextRight === CONT) {
        if (f.rights.length === 1) {
          f.off++;
          f.phase = 0;
          f.i = 0;
          f.rights = null;
        } else stack.push(frameOf(r, f.off + 1, false, f.ev, f.starts));
      } else stack.push(openFrame(w, nextRight));
      continue;
    }
    if (f.first) leave(w, r);
    stack.pop();
  }
  return { items, copies };
};

// The block of a plain (canonical) block JSON, built under `base`: the run
// records, where each stands — a root, a child, or waiting — and the walk as
// the rope, in one pass.
const hydrate = (seq, base) => {
  const kind = seq.k;
  const pos = seq.pos ?? null;
  const records = new Map();
  for (const key of Object.keys(seq.runs)) records.set(key, recordOf(key, seq.runs[key]));
  const roots = [];
  const pending = new Map();
  let pendingRuns = 0;
  let slots = 0;
  let oldest = null;
  let oldestAnchor = null;
  for (const run of records.values()) {
    slots += run.len;
    oldest = olderOf(oldest, run.ts, run.origin);
    const { anchor } = run;
    if (anchor.elem === null) {
      roots.push(run);
      continue;
    }
    const e = anchor.elem;
    oldestAnchor = olderOf(oldestAnchor, e.ts, e.origin);
    if (belowBase(e.ts, e.origin, base)) {
      roots.push(run);
      continue;
    }
    const parent = records.get(e.run);
    if (parent === undefined || e.offset >= parent.len) {
      const list = pending.get(e.run);
      if (list) list.push(run.key);
      else pending.set(e.run, [run.key]);
      pendingRuns++;
      continue;
    }
    // Gathered as entries, in order of arrival; sorted once below.
    const side = anchor.side;
    const entries = (parent[side] ??= []);
    let entry = null;
    for (const held of entries) if (held.off === e.offset) entry = held;
    if (entry !== null) entry.keys.push(run.key);
    else entries.push({ off: e.offset, keys: [run.key] });
  }
  roots.sort(byOrigin);
  const sorter = (a, b) => byOrigin(records.get(a), records.get(b));
  for (const run of records.values()) {
    if (run.L !== null) run.L = childrenList(run.L, sorter);
    if (run.R !== null) {
      for (const { off, keys } of run.R) {
        if (off + 1 < run.len) for (const key of keys) if (byOrigin(run, records.get(key)) < 0) run.tails++;
      }
      run.R = childrenList(run.R, sorter);
    }
  }
  for (const list of pending.values()) if (list.length > 1) list.sort();
  for (const map of ['cuts', 'ext']) for (const key of keysOf(seq[map])) oldest = minStamp(oldest, stampOfKey(key));
  for (const key of keysOf(seq.marks)) oldest = minStamp(oldest, stampOfKey(key));
  for (const map of ['pos', 'vals']) {
    for (const key of keysOf(seq[map])) oldest = minStamp(oldest, [seq[map][key][0], seq[map][key][1]]);
  }
  // The walk of every root and what hangs under it, as items; every run
  // walked is replaced by its placed copy.
  const items = [];
  const getRun = (key) => records.get(key);
  for (const top of roots) walkSubtree(getRun, kind, pos, top.key, items, records, true);
  const lineage = { head: null };
  const root = T.fromItems(items, lineage);
  for (const run of records.values()) Object.freeze(run);
  const runs = P.fromEntries(records);
  const state = {
    kind,
    base,
    root,
    runs,
    roots: roots.map((r) => r.key),
    pending,
    pendingRuns,
    slots,
    oldest,
    oldestAnchor,
    lineage,
    rendered: null,
    elems: null,
    elemSet: null,
    json: null,
  };
  const maps = { cuts: seq.cuts, ext: seq.ext, pos: seq.pos, vals: seq.vals, marks: seq.marks };
  const block = createBlock(kind, seq.ts, maps, state);
  lineage.head = block;
  return block;
};

const stampOfKey = (key) => {
  const { ts, origin } = parseRun(key);
  return [ts, origin];
};

// A block as the engine holds it, from whatever was given: a block of this
// engine (rebuilt under `base` when it was built under another), or plain
// JSON (a test's literal, a block from before this engine) hydrated.
const asBlock = (seq, base = null) => {
  const st = STATE.get(seq);
  if (st === undefined) {
    const plain = normalizeJson(seq);
    if (plain === null) return hydrate({ k: seq.k === 'l' ? 'l' : 't', ts: 0, runs: {} }, base);
    plain.ts = Number.isSafeInteger(seq.ts) ? seq.ts : stampsMax(plain);
    return hydrate(plain, base);
  }
  if (st.base !== base && (base !== null || st.base !== null) && !sameBase(st.base, base)) {
    const plain = plainOf(seq);
    return hydrate(plain, base);
  }
  return seq;
};
const sameBase = (a, b) => a === b || (a !== null && b !== null && a[0] === b[0] && a[1] === b[1]);

/**
 * What a reading reads through: the block itself, hydrated when plain. The
 * second argument keeps the shape the walk had (`buildIndex(seq, base)`).
 */
const buildIndex = (seq, base = null) => asBlock(seq, base);

// The head of its lineage, or the block forked into a lineage of its own:
// what an edit, a position or a neighbour must start from. The fork costs
// nothing here; the first hint the new lineage reads re-hints the tree in
// place (./btree.js), and the other head does the same when next edited.
const ensureHead = (block) => {
  const st = STATE.get(block);
  if (st.lineage.head === block) return st;
  counters.rebuilds++;
  st.lineage = { head: block };
  return st;
};

// ---- the rope: reading --------------------------------------------------------

const runOf = (st, key) => P.get(st.runs, key);

// The segment holding slot `off` of a placed run, by a binary search over
// its segments in offset order; undefined past its length.
const segOf = (run, off) => {
  const found = SL.find(run.segs, off);
  return found !== null && off < found.entry.off + found.entry.len ? found.entry : undefined;
};

// Whether the block holds the element `key` names: its run, long enough.
const holdsElem = (st, key) => {
  const e = parseElem(key);
  const run = runOf(st, e.run);
  return run !== undefined && e.offset < run.len;
};

// The character a text's embed sits in: U+FFFC, the object replacement
// character; its value is the slot's entry in `vals`.
const EMBED = '\uFFFC';

/** How many visible elements the field reads as — what a reading asks first. */
const lengthOf = (block) => STATE.get(block).root.v;
/** Every slot of the walk, tombstones included. */
const totalOf = (block) => STATE.get(block).root.s;

// The visible slot at index `i`: its segment's cursor, or null out of range.
const visibleAt = (st, i) => T.locate(st.root, 'v', i);
// The same without the path: `{ item, s, v }` for a reading that stays put.
const shownAt = (st, i) => T.find(st.root, 'v', i);

// The value at visible index `i`: a text's character; a list element's
// assigned value when a register names one, else what its run holds.
/** What the slot at visible index `i` holds — a text's character, a list's inserted element — before any value assigned to it. */
const heldAt = (block, i) => {
  const st = STATE.get(block);
  const cursor = shownAt(st, i);
  return cursor === null ? undefined : cursor.item.body[i - cursor.v];
};

const valueAt = (block, i) => {
  const st = STATE.get(block);
  const cursor = shownAt(st, i);
  if (cursor === null) return undefined;
  const { item } = cursor;
  const k = i - cursor.v;
  const held = item.body[k];
  if (!block.vals) return held;
  // A text's value is its embed's, at a slot that holds one.
  if (isText(st.kind) && held !== EMBED) return held;
  const run = runOf(st, item.run);
  const assigned = own(block.vals, run.elem ?? elemKey(item.run, item.off + k));
  return assigned === undefined ? held : assigned[2];
};

// What the field reads as: the visible elements in order — kept per
// version; a text's comes from the rope's own cache (./btree.js), so after
// one op it costs the path the op copied, not the text.
const render = (block) => {
  const st = STATE.get(block);
  if (st.rendered !== null) return st.rendered;
  let out;
  if (isText(st.kind)) out = T.text(st.root);
  else {
    out = [];
    const { vals } = block;
    for (const item of T.iterate(st.root)) {
      if (!item.vis) continue;
      const run = vals ? runOf(st, item.run) : null;
      for (let k = 0; k < item.len; k++) {
        const held = item.body[k];
        if (vals) {
          const assigned = own(vals, run.elem ?? elemKey(item.run, item.off + k));
          out.push(assigned === undefined ? held : assigned[2]);
        } else out.push(held);
      }
    }
  }
  st.rendered = out;
  return out;
};

// The names of the visible elements in order — a list's members, as the
// children hung under them are composed — kept per version like the
// reading; and whether an element shows.
const elems = (block) => {
  const st = STATE.get(block);
  if (st.elems !== null) return st.elems;
  const out = [];
  for (const item of T.iterate(st.root)) {
    if (!item.vis) continue;
    const run = runOf(st, item.run);
    for (let k = 0; k < item.len; k++) out.push(run.elem ?? elemKey(item.run, item.off + k));
  }
  st.elems = out;
  return out;
};
const hasElem = (block, key) => {
  const st = STATE.get(block);
  st.elemSet ??= new Set(elems(block));
  return st.elemSet.has(key);
};

// The element at visible index `i`: its name (a list element keeps it across
// moves; a text element's is its slot) or null out of range.
const elemAt = (block, i) => {
  const st = STATE.get(block);
  const cursor = shownAt(st, i);
  if (cursor === null) return null;
  const { item } = cursor;
  const run = runOf(st, item.run);
  return run.elem ?? elemKey(item.run, item.off + (i - cursor.v));
};

// The slot visible index `i` shows at, as a cut range.
const slotAt = (block, i) => {
  const st = STATE.get(block);
  const cursor = shownAt(st, i);
  return cursor === null ? null : [cursor.item.run, cursor.item.off + (i - cursor.v), 1];
};

// The element at slot ordinal `s` of the walk.
const elemAtSlot = (st, s) => {
  const found = T.find(st.root, 's', s);
  return elemKey(found.item.run, found.item.off + (s - found.s));
};

// Where a local insertion of `len` elements at visible index `i` goes: the
// anchor of a new run, or the run of this origin to extend. Null when `i` is
// out of range. Fugue's rule, read off the rope: after the element shown
// at `i - 1` when nothing follows it in its own subtree — the writer's own
// run grown while it can be — else before the slot that follows it in the
// walk, the leftmost of what hangs there; at 0, before the first slot.
const placeInsert = (block, i, origin, len = 1) => {
  const st = STATE.get(block);
  const length = st.root.v;
  if (!Number.isInteger(i) || i < 0 || i > length) return null;
  if (i === 0) return st.roots.length === 0 ? { at: HEAD } : { at: `<${elemAtSlot(st, 0)}` };
  const cursor = shownAt(st, i - 1);
  const r = runOf(st, cursor.item.run);
  const k = i - 1 - cursor.v;
  const off = cursor.item.off + k;
  if (childrenAt(r.R, off) === undefined && off + 1 >= r.len) {
    if (r.origin === origin && r.len + len <= MAX_RUN) return { run: r.key, from: r.len };
    return { at: `>${elemKey(r.key, off)}` };
  }
  return { at: `<${elemAtSlot(st, cursor.s + k + 1)}` };
};

// The visible elements [i, i + count) as cut ranges, grouped by run. Null
// when the range is not within the field.
const rangesOf = (block, i, count) => {
  const st = STATE.get(block);
  const length = st.root.v;
  if (!Number.isInteger(i) || !Number.isInteger(count) || i < 0 || count < 0 || i + count > length) return null;
  const out = [];
  if (count === 0) return out;
  const cursor = visibleAt(st, i);
  let item = cursor.item;
  let k = i - cursor.v;
  let left = count;
  while (left > 0) {
    if (item.vis) {
      const n = Math.min(left, item.len - k);
      const off = item.off + k;
      const last = out[out.length - 1];
      if (last && last[0] === item.run && last[1] + last[2] === off) last[2] += n;
      else out.push([item.run, off, n]);
      left -= n;
    }
    item = T.next(cursor);
    k = 0;
  }
  return out;
};

// A place in the field that survives edits around it: the slot visible
// index `i` shows at, taken on its left (`<e`, the cursor stays before that
// element) or the one before on its right (`>e`, it stays after that one);
// the head or the end at the ends. Null out of range.
const cursorAt = (block, i, side) => {
  const st = STATE.get(block);
  const length = st.root.v;
  if (!Number.isInteger(i) || i < 0 || i > length) return null;
  const slot = (k) => {
    const found = shownAt(st, k);
    return elemKey(found.item.run, found.item.off + (k - found.v));
  };
  if (side === 'after') return i === 0 ? HEAD : `>${slot(i - 1)}`;
  return i === length ? END : `<${slot(i)}`;
};

// Where a slot of a placed run sits: the slots and visible slots before it,
// and whether it shows. The head version's hints.
const positionOfSlot = (st, run, off) => {
  const seg = segOf(run, off);
  const { s, v } = T.positionOf(st.root, seg, st.lineage);
  const k = off - seg.off;
  return { s: s + k, v: v + (seg.vis ? k : 0), vis: seg.vis };
};

// Where a cursor is now: the visible elements before its slot, plus one
// for a slot still shown when the cursor sits after it. Null once the slot
// is gone — its run not here, or dropped by a reset.
const indexOfCursor = (block, token) => {
  if (token === HEAD) return 0;
  if (token === END) return lengthOf(block);
  const anchor = parseAnchor(token);
  if (anchor === null) return null;
  const st = ensureHead(block);
  const run = runOf(st, anchor.elem.run);
  if (run === undefined || !run.placed || anchor.elem.offset >= run.len) return null;
  const at = positionOfSlot(st, run, anchor.elem.offset);
  return at.v + (anchor.side === 'R' && at.vis ? 1 : 0);
};

// Where an anchor falls in the walk: the ordinal before the element for
// `<e`, after it for `>e`; the head for `^`, an anchor below the base, or
// an element dropped by it; the end for `$`; null while the element has
// not arrived.
const anchorOrdinal = (block, token, base = null) => {
  if (token === HEAD) return 0;
  if (token === END) return STATE.get(block).root.s;
  const { side, elem } = parseAnchor(token);
  if (belowBase(elem.ts, elem.origin, base)) return 0;
  const st = ensureHead(block);
  const run = runOf(st, elem.run);
  if (run === undefined || !run.placed || elem.offset >= run.len) return null;
  return positionOfSlot(st, run, elem.offset).s + (side === 'L' ? 0 : 1);
};

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
    pos: block.pos ?? null,
    vals: block.vals ?? null,
    marks: block.marks ?? null,
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
    rendered: null,
    elems: null,
    elemSet: null,
    json: null,
  };
  const block = createBlock(
    d.kind,
    d.ts,
    { cuts: d.cuts, ext: d.ext, pos: d.pos, vals: d.vals, marks: d.marks },
    state,
  );
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
      if (!siblings.includes(run.key)) parent.L = withChild(d, parent.L, e.offset, run.key, run);
    } else {
      const explicit = (childrenAt(parent.R, e.offset) ?? []).filter((key) => key !== run.key);
      const cont = e.offset + 1 < parent.len;
      // The virtual siblings: the explicit ones with the continuation among
      // them by origin — before the first that sorts after the parent.
      let pred = null; // a run key, 'cont', or null
      let succ = null;
      let contPlaced = false;
      const afterCont = cont && byOrigin(parent, run) < 0;
      for (const key of explicit) {
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
      const held = childrenAt(parent.R, e.offset) ?? [];
      if (!held.includes(run.key)) {
        if (afterCont) parent.tails++;
        parent.R = withChild(d, parent.R, e.offset, run.key, run);
      }
    }
    setRun(d, parent);
  }
  for (const copy of copies.values()) setRun(d, copy);
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
    if (last.vis === first.vis && (last.body === null) === (first.body === null) && last.off + last.len === from) {
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
  d.slots += content.length;
  settleChildren(d, key, from);
  settleRun(d, key);
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
    // A gap beside a gap of the same run is one gap.
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
      pieces.splice(pieces.indexOf(gap), 1, joined);
    }
    const last = pieces[pieces.indexOf(pieces.find((p) => p.body === null && p.off <= at && at < p.off + p.len))];
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
    const hit = list.find(([from]) => from === len);
    const rest = list.filter(([from]) => from > len);
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

// What waits in a block: runs out of the walk, cuts and extensions of runs
// not here, registers of elements no run holds, marks switched off before
// they arrived — each one a thing a peer could pile up for nothing.
const pendingCount = (block) => {
  const st = STATE.get(block);
  let n = st.pendingRuns;
  for (const key of keysOf(block.cuts)) n += block.cuts[key].length;
  for (const key of keysOf(block.ext)) n += block.ext[key].length;
  for (const map of ['pos', 'vals']) for (const key of keysOf(block[map])) if (!holdsElem(st, key)) n++;
  for (const key of keysOf(block.marks)) if (isPlaceholder(block.marks[key])) n++;
  return n;
};

// The same over a draft: what the op has added so far counts.
const pendingOfDraft = (d) => {
  let n = d.pendingRuns;
  for (const key of keysOf(d.cuts)) n += d.cuts[key].length;
  for (const key of keysOf(d.ext)) n += d.ext[key].length;
  for (const map of ['pos', 'vals']) for (const key of keysOf(d[map])) if (!holdsElem(d, key)) n++;
  for (const key of keysOf(d.marks)) if (isPlaceholder(d.marks[key])) n++;
  return n;
};

// A refusal for work past a bound: which bound, the count and the limit.
const refused = (seq, detail, count, max) => ({ seq, changed: false, reason: 'bound', detail, count, max });
const malformed = (seq) => ({ seq, changed: false, reason: 'malformed' });
const unchanged = (seq) => ({ seq, changed: false, reason: null });

// Whether the block already waits to cut exactly this range of `key`.
const hasRange = (cuts, key, offset, length) => {
  const held = cuts ? own(cuts, key) : undefined;
  return held !== undefined && held.some(([o, n]) => o === offset && n === length);
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
  const assignVals = (d, runKeyOf, from) => {
    if (vals === undefined || vals.length === 0) return;
    const next = { ...(d.vals ?? {}) };
    for (const [offset, value] of vals) next[elemKey(runKeyOf, from + offset)] = [ts, origin, value];
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
          const list = m.ext && own(m.ext, run) ? [...m.ext[run]] : [];
          if (!list.some(([f]) => f === from)) {
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
  if (payload.off !== undefined) {
    const named = parseRun(payload.off);
    if (named === null) return malformed(seq);
    const held = seq.marks && own(seq.marks, payload.off);
    if (held !== undefined && (held[4] & OFF) !== 0) return unchanged(seq);
    if (held === undefined) {
      if (belowBase(named.ts, named.origin, base)) return unchanged(seq);
      const n = pendingCount(seq);
      if (n >= pendingMax) return refused(seq, 'pending', n, pendingMax);
    }
    const d = draft(seq);
    d.marks = { ...(d.marks ?? {}) };
    d.marks[payload.off] = held === undefined ? [...PLACEHOLDER] : [held[0], held[1], held[2], held[3], held[4] | OFF];
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
  const held = seq.marks && own(seq.marks, id);
  if (held !== undefined && !isPlaceholder(held)) return unchanged(seq);
  const d = draft(seq);
  d.marks = { ...(d.marks ?? {}) };
  d.marks[id] = [start, end, key, value, (many ? MANY : 0) | (held === undefined ? 0 : OFF)];
  d.ts = Math.max(d.ts, ts);
  d.oldest = minStamp(d.oldest, [ts, origin]);
  return { seq: finish(d), changed: true, reason: null };
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

// The ordinal of every anchor the marks name, and the ordinal and visible
// index of every visible slot — read in one walk of the rope, no hints, so
// a block of any version reads its spans.
const walkMarks = (block, base) => {
  const st = STATE.get(block);
  const wanted = new Map(); // "run:offset" → ordinal of the slot, filled by the walk
  const marks = [];
  for (const id of keysOf(block.marks)) {
    const [from, to, key, value, flags] = block.marks[id];
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
  if (length === 0 || !block.marks) return [];
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

// ---- registers: assign and move -------------------------------------------

// A register write, LWW by stamp: null when the held one is as new.
const newer = (map, key, stamp) => {
  const held = map && own(map, key);
  return held === undefined || compareClock([held[0], held[1]], stamp) < 0;
};

// An `assign`: the element's value register (lists only).
const applyAssign = (given, stamp, payload, base = null, pendingMax = PENDING_MAX) => {
  const seq = asBlock(given, base);
  if (!payload || typeof payload !== 'object') return malformed(seq);
  const { elem, value } = payload;
  if (!isElemKey(elem) || !isJson(value) || value === undefined) return malformed(seq);
  if (!newer(seq.vals, elem, stamp)) return unchanged(seq);
  const st = STATE.get(seq);
  if (!(seq.vals && own(seq.vals, elem) !== undefined) && !holdsElem(st, elem)) {
    const n = pendingCount(seq);
    if (n >= pendingMax) return refused(seq, 'pending', n, pendingMax);
  }
  const d = draft(seq);
  d.vals = { ...(d.vals ?? {}), [elem]: [stamp[0], stamp[1], value] };
  d.ts = Math.max(d.ts, stamp[0]);
  d.oldest = minStamp(d.oldest, stamp);
  return { seq: finish(d), changed: true, reason: null };
};

// The slot an element shows at under `pos`: its position run's one slot
// when a move named one, else its own; null when that run is not here.
const slotShowing = (d, elem) => {
  const winner = d.pos ? own(d.pos, elem) : undefined;
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
  const moving = newer(seq.pos, elem, stamp);
  if (moving && !(seq.pos && own(seq.pos, elem) !== undefined) && !holdsElem(st, elem)) {
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
      d.pos = { ...(d.pos ?? {}), [elem]: [ts, origin, key] };
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
    d.pos = { ...(d.pos ?? {}), [elem]: [ts, origin, key] };
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

// ---- resets and joins --------------------------------------------------------

// The reset rule: drops what is stamped below `base`. Null when nothing is
// left; the block itself when the base takes nothing — O(1) by the oldest
// stamp the block holds; a rebuild under the new base otherwise.
const below = (key, base) => {
  const parsed = parseRun(key);
  return compareClock([parsed.ts, parsed.origin], base) < 0;
};
const prune = (given, base) => {
  if (base === null) return given;
  const seq = asBlock(given, STATE.has(given) ? STATE.get(given).base : base);
  const st = STATE.get(seq);
  const untouched =
    (st.oldest === null || compareClock(st.oldest, base) >= 0) &&
    (st.oldestAnchor === null || compareClock(st.oldestAnchor, base) >= 0);
  if (untouched) {
    if (!sameBase(st.base, base)) st.base = base;
    return seq;
  }
  const plain = plainOf(seq);
  const out = { k: plain.k, ts: 0, runs: {} };
  for (const key of Object.keys(plain.runs)) if (!below(key, base)) out.runs[key] = plain.runs[key];
  for (const map of ['cuts', 'ext', 'marks']) {
    for (const key of keysOf(plain[map])) if (!below(key, base)) (out[map] ??= {})[key] = plain[map][key];
  }
  for (const map of ['pos', 'vals']) {
    for (const key of keysOf(plain[map])) {
      const [ts, origin] = plain[map][key];
      if (compareClock([ts, origin], base) >= 0) (out[map] ??= {})[key] = plain[map][key];
    }
  }
  const empty = Object.keys(out.runs).length === 0 && !out.cuts && !out.ext && !out.marks && !out.pos && !out.vals;
  if (empty) return null;
  out.ts = stampsMax(out);
  return hydrate(out, base);
};

// Two nodes' pictures of one field joined: the union of runs (one run's two
// pictures merged), cuts, extensions and marks, the registers by stamp.
const join = (givenA, givenB) => {
  const a = plainOf(asBlock(givenA));
  const b = plainOf(asBlock(givenB));
  const out = { k: a.k, ts: Math.max(a.ts, b.ts), runs: {} };
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
  const addCut = (key, o, n) => {
    if (hasRange(out.cuts, key, o, n)) return;
    const held = out.cuts && own(out.cuts, key);
    (out.cuts ??= {})[key] = held ? [...held, [o, n]] : [[o, n]];
  };
  for (const side of [a, b]) {
    for (const key of keysOf(side.cuts)) for (const [o, n] of side.cuts[key]) addCut(key, o, n);
    for (const key of keysOf(side.ext)) {
      const list = out.ext && own(out.ext, key) ? out.ext[key] : [];
      for (const item of side.ext[key]) if (!list.some(([f]) => f === item[0])) list.push(item);
      (out.ext ??= {})[key] = list;
    }
    for (const map of ['pos', 'vals']) {
      for (const key of keysOf(side[map])) {
        const theirs = side[map][key];
        const mine = out[map] && own(out[map], key);
        const fresher = mine === undefined || compareClock([theirs[0], theirs[1]], [mine[0], mine[1]]) > 0;
        if (fresher) (out[map] ??= {})[key] = theirs;
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
  // Pending cuts and extensions that the union can take, taken: what
  // `settle` did on the plain block, on the plain union.
  const joined = hydrate(out, null);
  const d = draft(joined);
  for (const key of Object.keys(out.runs)) settleRun(d, key);
  return finish(d);
};

/**
 * The block of a sequence field as the engine reads it — the block itself,
 * hydrated under the entry's base when it is plain JSON (kept on the entry
 * under `entry.cache[field]` then). The third argument is of the old walk.
 */
const indexOf = (entry, field) => {
  const seq = own(entry.meta.blocks ?? {}, field);
  if (seq === undefined) return null;
  if (STATE.has(seq)) return seq;
  const cache = (entry.cache ??= {});
  const hit = own(cache, field);
  if (hit !== undefined && hit.seq === seq) return hit.block;
  const block = asBlock(seq, entry.meta.base);
  cache[field] = { seq, block };
  return block;
};

/** What the engine counted: blocks forked from an older version (`rebuilds`), trees re-hinted after one (`rehints`). */
const stats = () => ({ ...counters, rehints: T.stats().rehints });

module.exports = {
  PENDING_MAX,
  indexOf,
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
  hydrate,
  buildIndex,
  EMBED,
  heldAt,
  lengthOf,
  totalOf,
  render,
  elems,
  hasElem,
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
  marksIn,
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
  stats,
};
