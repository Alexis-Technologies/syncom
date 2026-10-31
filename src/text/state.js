'use strict';

// The engine's state of a block (src/text/sequence.js holds its design): the
// plain object and the WeakMap beside it, a plain block's JSON made whole and
// hydrated into the rope, and every reading of it — elements, values,
// positions, cursors, what waits.

const { compareClock, floorOf } = require('../vector.js');
const T = require('./btree.js');
const P = require('./pmap.js');
const SL = require('./plist.js');
const { MAX_RUN, isText, present, isGap, rleLength, segLength, normalizeRle } = require('./rle.js');
const {
  END,
  HEAD,
  MAX_FIELD,
  byOrigin,
  elemKey,
  isElemKey,
  isJson,
  isOrigin,
  isPlaceholder,
  isRunKey,
  isStamp,
  keysOf,
  minStamp,
  olderOf,
  own,
  parseAnchor,
  parseElem,
  parseRun,
} = require('./keys.js');

// ---- the block ------------------------------------------------------------

// The engine's state of a block, beside the plain object the record meta
// holds: the rope, the run records, what waits, the counts the bounds read,
// the lineage and what is cached for this version.
const STATE = new WeakMap();

// What the engine did that costs more than the path an op copies — counted
// so a test can say it did not happen: blocks forked because they were asked
// a position or an edit while no longer the head of their lineage
// (`rebuilds`), blocks hydrated from JSON (`hydrations`), indexes of the
// marks made whole (`markIndexes`) and the anchors they and the queries read
// from the rope (`anchorReads`), lists read whole (`listRenders`) and their
// names listed (`elemLists`), full segments sealed (`seals`).
const counters = {
  rebuilds: 0,
  hydrations: 0,
  markIndexes: 0,
  anchorReads: 0,
  listRenders: 0,
  elemLists: 0,
  seals: 0,
};

// A block as the record meta holds it: `k` and `ts` as fields, `runs` as
// the walk-order JSON of the rope, made when read, `cuts` and `ext` as
// given, and the registers and the marks — `pos`, `vals`, `marks` — as
// plain objects made from the engine's persistent maps when read (`viewOf`),
// each absent when empty: the shape a peer's block has, in the key order
// `plainOf` gives, so deepEqual, JSON.stringify, the signed form and a
// snapshot see a plain block; nothing else is on it (what it reads as is
// asked of the engine: `lengthOf`, `totalOf`, `render`). Nothing on an
// op's path reads those views: an op reads and writes the maps.
const MAPS = ['cuts', 'ext', 'pos', 'vals', 'marks'];
const REGISTERS = ['pos', 'vals', 'marks'];
// Whether an engine-built object holds a key — never a peer's object.
const hasAny = (map) => {
  if (map === undefined || map === null) return false;
  for (const key in map) if (Object.hasOwn(map, key)) return true;
  return false;
};
// A register map or the marks as the record holds them: a plain object,
// made from the engine's persistent map once per version, when asked.
const viewOf = (block, name) => {
  const st = STATE.get(block);
  const views = (st.views ??= { pos: null, vals: null, marks: null });
  if (views[name] !== null) return views[name];
  const out = {};
  for (const [key, value] of P.entries(st[name])) out[key] = value;
  views[name] = out;
  return out;
};
// The getter of each view, one descriptor per map, shared by every block.
const VIEW = {};
for (const name of REGISTERS) {
  VIEW[name] = {
    get() {
      return viewOf(this, name);
    },
    enumerable: true,
    configurable: true,
  };
}
const createBlock = (kind, ts, cuts, ext, state) => {
  const block = {
    k: kind,
    ts,
    get runs() {
      return runsJson(this);
    },
  };
  if (hasAny(cuts)) block.cuts = cuts;
  if (hasAny(ext)) block.ext = ext;
  for (const name of REGISTERS) if (state[name].size > 0) Object.defineProperty(block, name, VIEW[name]);
  STATE.set(block, state);
  return block;
};

// A plain register map or marks (a peer's block, normalized) as the
// engine's persistent map: fresh pairs, the tuples as they are.
const mapOf = (plain) => {
  if (plain === undefined || plain === null) return P.EMPTY;
  const pairs = [];
  for (const key of Object.keys(plain)) pairs.push([key, plain[key]]);
  return pairs.length === 0 ? P.EMPTY : P.fromEntries(pairs);
};

// A block as plain JSON, to hydrate again (a base it has not seen, a prune, a
// join): read once, so its runs' tuples are not kept (`tupleOf`).
const plainOf = (block) => {
  const out = { k: block.k, ts: block.ts, runs: runsJson(block, false) };
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

// A run's JSON tuple, made once per run record: a record is frozen when it
// is set and replaced when it changes, so a version's `runs` reuses the
// tuple of every run the op left alone — rebuilding them all cost a large
// record's landing tens of milliseconds. Kept only where a version is
// serialized (`keep`, the `runs` of a block): a block read once to hydrate
// again (a join of a peer's picture) made an entry per run that no version
// read again, and the weak map's upkeep slowed the merge by a fifth.
const TUPLES = new WeakMap();
const tupleOf = (kind, run, keep) => {
  const known = TUPLES.get(run);
  if (known !== undefined) return known;
  const tuple = run.elem !== null ? [run.at, rleOf(kind, run), run.elem] : [run.at, rleOf(kind, run)];
  if (keep && Object.isFrozen(run)) TUPLES.set(run, tuple);
  return tuple;
};

// The `runs` map of a block, in walk order then the pending ones by key;
// made once per version.
const runsJson = (block, keep = true) => {
  const st = STATE.get(block);
  if (st.json !== null) return st.json;
  const out = {};
  for (const item of T.iterate(st.root)) {
    if (item.fence === 1) out[item.run] = tupleOf(st.kind, P.get(st.runs, item.run), keep);
  }
  // What is not in the walk — a run waiting for its anchor, and what waits
  // under it — by key.
  const waiting = [];
  for (const [key, run] of P.entries(st.runs)) if (!run.placed) waiting.push(key);
  waiting.sort();
  for (const key of waiting) out[key] = tupleOf(st.kind, P.get(st.runs, key), keep);
  st.json = out;
  return out;
};

// ---- a block in pieces ---------------------------------------------------

// A block of PIECES_MIN runs or more is written in pieces (src/entries.js):
// its runs by the 32 children of the run map's root — the first five bits
// of a run key's hash (./pmap.js) — a piece a child, the rest of the block
// whole beside them (`head`). A keystroke path-copies one child, so one
// piece is new and the file of every other stays; a piece's `key` is its
// child, what tells it is the same. A plain block (read from a file) is
// grouped by the same bits, its pieces keyed by the groups made here.
const PIECES_MIN = 1024;
const piecesOf = (block) => {
  const st = STATE.get(block);
  const head = {};
  for (const name of Object.keys(block)) if (name !== 'runs') head[name] = block[name];
  const slots = [];
  if (st === undefined) {
    const keys = keysOf(block.runs);
    if (keys.length < PIECES_MIN) return null;
    const groups = [];
    for (let i = 0; i < 32; i++) groups.push(null);
    for (let i = 0; i < keys.length; i++) {
      const at = P.hashOf(keys[i]) & 31;
      if (groups[at] === null) groups[at] = {};
      groups[at][keys[i]] = block.runs[keys[i]];
    }
    for (let i = 0; i < 32; i++) {
      const group = groups[i];
      slots.push(group === null ? null : { key: group, text: () => JSON.stringify(group) });
    }
    return { head, slots };
  }
  if (st.runs.size < PIECES_MIN) return null;
  const children = P.childrenOf(st.runs);
  const { kind } = st;
  for (let i = 0; i < 32; i++) {
    const child = children[i];
    slots.push(child === null ? null : { key: child, text: () => pieceText(kind, child) });
  }
  return { head, slots };
};

// One piece's runs as JSON text, each run as the `runs` map holds it.
const pieceText = (kind, child) => {
  const out = {};
  for (const [key, run] of P.pairsUnder(child)) out[key] = tupleOf(kind, run, true);
  return JSON.stringify(out);
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
  let runs = 0;
  for (const key of keysOf(raw.runs)) {
    const run = raw.runs[key];
    const made = parseRun(key);
    if (made === null || !Array.isArray(run) || run.length < 2 || run.length > 3) continue;
    const anchor = parseAnchor(run[0]);
    if (anchor === null || run[0] === END || (anchor.elem !== null && anchor.elem.ts >= made.ts)) continue;
    const content = normalizeRle(kind, run[1]);
    if (content === null) continue;
    // A position run (a move's) names its element and holds it alone.
    if (run.length === 3 && (kind !== 'l' || !isElemKey(run[2]) || rleLength(content) !== 1)) continue;
    slots += rleLength(content);
    if (slots > MAX_FIELD) return null;
    seq.runs[key] = run.length === 3 ? [run[0], content, run[2]] : [run[0], content];
    runs++;
  }
  for (const key of keysOf(raw.cuts)) {
    const given = raw.cuts[key];
    if (!isRunKey(key) || !Array.isArray(given)) continue;
    const list = [];
    for (let i = 0; i < given.length; i++) {
      const r = given[i];
      if (Array.isArray(r) && r.length === 2 && Number.isInteger(r[0]) && r[0] >= 0 && isGap(r[1])) {
        list.push([r[0], r[1]]);
      }
    }
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
    let n = 0;
    for (const key of keysOf(raw2)) {
      const v = raw2[key];
      if (isElemKey(key) && Array.isArray(v) && v.length === 3 && isStamp(v[0]) && isOrigin(v[1]) && check(v[2])) {
        out[key] = [v[0], v[1], v[2]];
        n++;
      }
    }
    return n > 0 ? out : null;
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
    let n = 0;
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
      n++;
    }
    if (n > 0) seq.marks = marks;
  }
  const empty = runs === 0 && !seq.cuts && !seq.ext && !seq.marks && !seq.pos && !seq.vals;
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
// no move named one, else the position run the newest move made. `pos` is
// the register map (./pmap.js).
const showsAt = (kind, pos, run, off) => {
  if (!isText(kind)) {
    const elem = run.elem ?? elemKey(run.key, off);
    const winner = P.get(pos, elem);
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

// A body grows by SEG_MAX slots at most. A text's body grown a keystroke
// at a time is a chain of concatenations — a rope of the engine's own, some
// 32 bytes a unit — that the first read inside it copies whole: past the cap
// the next slots start a segment of their own, and the full one is sealed
// flat, joined to the sealed one before it (`sealText`), so a read inside
// what was typed never copies it again. A list's body is copied whole
// whenever it grows or is split: a list's segment holds SEG_MAX slots at
// most, its content cut to that size when it is laid (a gap is any length,
// a text's piece from a file is one flat string). What a block serializes
// as does not see it: a run's content is one RLE whatever segments it is
// read from.
const SEG_MAX = 2048;

// What sealing a body read last: kept, so that no compiler drops the read.
let sealed = 0;
// A text's body read once in the middle: an engine that keeps a
// concatenation as a rope (V8's cons strings) flattens it there, in place —
// the same string, one buffer — and every version that shares it gains.
const seal = (body) => {
  counters.seals++;
  if (typeof body === 'string' && body.length > 0) sealed ^= body.charCodeAt(body.length >> 1);
};

// A segment of `len` slots of `r` at `off` after the items `out` holds,
// joined to the last when it continues it (same run, next slot, shown
// alike, both alive or both gaps) and the two hold SEG_MAX slots at most;
// a new one goes into the run's `segs` too — a list's content past the cap
// in segments of SEG_MAX, a text's piece whole.
const pushSeg = (r, off, len, vis, body, out) => {
  const last = out[out.length - 1];
  if (
    last !== undefined &&
    last.fence === undefined &&
    last.run === r.key &&
    last.off + last.len === off &&
    last.vis === vis &&
    (last.body === null) === (body === null) &&
    (body === null || last.len + len <= SEG_MAX)
  ) {
    last.len += len;
    if (body !== null) {
      if (typeof body === 'string') last.body += body;
      else for (const value of body) last.body.push(value);
    }
    return;
  }
  if (body === null || len <= SEG_MAX || typeof body === 'string') {
    const seg = { run: r.key, off, len, vis, body, node: null };
    out.push(seg);
    r.segs.push(seg);
    return;
  }
  for (let at = 0; at < len; at += SEG_MAX) {
    const n = Math.min(SEG_MAX, len - at);
    const seg = { run: r.key, off: off + at, len: n, vis, body: body.slice(at, at + n), node: null };
    out.push(seg);
    r.segs.push(seg);
  }
};

// The segments of slots [from, to) of `r`, from its content pieces (`r.rle`,
// starting at `starts`): a piece is one segment — a text's piece its own
// string, a gap a gap — unless the run is a list under moves, where each
// slot shows or not by its register.
const emitPieces = (kind, pos, r, starts, from, to, out) => {
  const pieces = r.rle;
  const text = isText(kind);
  const perSlot = !text && pos.size > 0;
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
const NONE = Object.freeze([]);
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
  counters.hydrations++;
  const kind = seq.k;
  const pos = mapOf(seq.pos);
  const records = new Map();
  for (const key of Object.keys(seq.runs)) records.set(key, recordOf(key, seq.runs[key]));
  const roots = [];
  const pending = new Map();
  // The entry of each offset, per list of entries a side gathers.
  const atOffset = new Map();
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
    let entries = parent[side];
    let offsets;
    if (entries === null) {
      entries = parent[side] = [];
      offsets = new Map();
      atOffset.set(entries, offsets);
    } else offsets = atOffset.get(entries);
    const entry = offsets.get(e.offset);
    if (entry !== undefined) entry.keys.push(run.key);
    else {
      const made = { off: e.offset, keys: [run.key] };
      entries.push(made);
      offsets.set(e.offset, made);
    }
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
  const rootKeys = [];
  for (let i = 0; i < roots.length; i++) {
    rootKeys.push(roots[i].key);
    walkSubtree(getRun, kind, pos, rootKeys[i], items, records, true);
  }
  const lineage = { head: null };
  const root = T.fromItems(items, lineage);
  for (const run of records.values()) Object.freeze(run);
  const runs = P.fromEntries(records);
  const state = {
    kind,
    base,
    root,
    runs,
    roots: rootKeys,
    pending,
    pendingRuns,
    slots,
    oldest,
    oldestAnchor,
    lineage,
    pos,
    vals: mapOf(seq.vals),
    marks: mapOf(seq.marks),
    marksIndex: null,
    views: null,
    rendered: null,
    derivedFrom: null,
    elems: null,
    elemIndex: null,
    json: null,
  };
  const block = createBlock(kind, seq.ts, seq.cuts, seq.ext, state);
  lineage.head = block;
  return block;
};

const stampOfKey = (key) => {
  const { ts, origin } = parseRun(key);
  return [ts, origin];
};

// The engine's block of each plain block it was asked for, with the base it
// was built under: a block read from a file is hydrated once — by the first
// reading and the op after it alike — and nothing keeps the pair alive but
// the plain block itself (an entry that moved on to the engine's block
// lets both go).
const HYDRATED = new WeakMap();

// A block as the engine holds it, from whatever was given: a block of this
// engine (rebuilt under `base` when it was built under another), or plain
// JSON (a block read from a file, a test's literal) hydrated — once per
// plain block and base.
const asBlock = (seq, base = null) => {
  const st = STATE.get(seq);
  if (st === undefined) {
    const hit = HYDRATED.get(seq);
    if (hit !== undefined && sameBase(hit.base, base)) return hit.block;
    const plain = normalizeJson(seq);
    let block;
    if (plain === null) block = hydrate({ k: seq.k === 'l' ? 'l' : 't', ts: 0, runs: {} }, base);
    else {
      plain.ts = Number.isSafeInteger(seq.ts) ? seq.ts : stampsMax(plain);
      block = hydrate(plain, base);
    }
    if (seq !== null && typeof seq === 'object') HYDRATED.set(seq, { base, block });
    return block;
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

// The value of the slot of `item` at `k`: what an assignment set, else what
// it holds (a text's value is its embed's, at a slot that holds one).
const valueOf = (st, item, k) => {
  const held = item.body[k];
  if (st.vals.size === 0 || (isText(st.kind) && held !== EMBED)) return held;
  const run = runOf(st, item.run);
  const assigned = P.get(st.vals, run.elem ?? elemKey(item.run, item.off + k));
  return assigned === undefined ? held : assigned[2];
};

const valueAt = (block, i) => {
  const st = STATE.get(block);
  const cursor = shownAt(st, i);
  return cursor === null ? undefined : valueOf(st, cursor.item, i - cursor.v);
};

/**
 * What visible [i, i + count) reads as, from the rope in O(log n + count): a
 * text's characters, a list's values (an assigned one where one is).
 */
const valuesAt = (block, i, count) => {
  const st = STATE.get(block);
  const text = isText(st.kind);
  let out = text ? '' : [];
  const cursor = count > 0 ? visibleAt(st, i) : null;
  if (cursor === null) return out;
  let k = i - cursor.v;
  for (let item = cursor.item; item !== null && out.length < count; item = T.next(cursor), k = 0) {
    if (!item.vis) continue;
    const n = Math.min(item.len - k, count - out.length);
    if (text) out += item.body.slice(k, k + n);
    else for (let j = k; j < k + n; j++) out.push(valueOf(st, item, j));
  }
  return out;
};

// The runs an element of which holds an assigned value: a full reading
// looks values up there alone — every other element reads as it was
// inserted, its name never made.
const assignedRuns = (st) => {
  const out = new Set();
  for (const [key] of P.entries(st.vals)) {
    const e = parseElem(key);
    if (e !== null) out.add(e.run);
  }
  return out;
};

// What the field reads as: the visible elements in order — kept per
// version; a text's comes from the rope's own cache (./btree.js), so after
// one op it costs the path the op copied, not the text. A list's is made
// whole when nothing gave it from the version before (`derive`).
const render = (block) => {
  const st = STATE.get(block);
  if (st.rendered !== null) return st.rendered;
  if (st.derivedFrom !== null) {
    const { before, changes } = st.derivedFrom;
    st.derivedFrom = null;
    derive(before, block, changes);
    if (st.rendered !== null) return st.rendered;
  }
  let out;
  if (isText(st.kind)) out = T.text(st.root);
  else {
    counters.listRenders++;
    out = [];
    const flagged = st.vals.size > 0 ? assignedRuns(st) : null;
    for (const item of T.iterate(st.root)) {
      if (!item.vis) continue;
      const run = flagged === null ? null : runOf(st, item.run);
      if (run === null || (run.elem === null && !flagged.has(item.run))) {
        for (let k = 0; k < item.len; k++) out.push(item.body[k]);
      } else for (let k = 0; k < item.len; k++) out.push(valueOf(st, item, k));
    }
  }
  st.rendered = out;
  return out;
};

/**
 * A list's reading after an op, derived from the reading before it and what
 * the op changed (src/text/kind.js `changeOf`: splices in the indices the
 * reading had when each applied, a `setAt`, a `move`) instead of made
 * whole: the array before copied once (a native copy), the change laid on
 * it, the values it brings read from the rope. Kept as the block's reading
 * when its length is the block's; nothing when `before` was never read.
 */
const derive = (before, block, changes) => {
  const st = STATE.get(block);
  const prev = STATE.get(before).rendered;
  if (isText(st.kind) || st.rendered !== null || prev === null || !Array.isArray(changes)) return;
  // Native slices joined by one concat: the elements copied twice, never
  // moved one by one (a splice or a copyWithin on a copy is slower here).
  let out = prev;
  for (const change of changes) {
    const { action, index } = change;
    if (action === 'splice') {
      const added = change.content === undefined ? 0 : change.content.length;
      const values = added === 0 ? [] : valuesAt(block, index, added);
      const rest = index + change.count;
      if (index === out.length) out = out.concat(values);
      else if (rest >= out.length) out = out.slice(0, index).concat(values);
      else out = out.slice(0, index).concat(values, out.slice(rest));
    } else if (action === 'setAt') {
      if (out === prev) out = prev.slice();
      out[index] = valueAt(block, index);
    } else if (action === 'move') {
      const { from, to } = change;
      const value = [valueAt(block, to)];
      out =
        from < to
          ? out.slice(0, from).concat(out.slice(from + 1, to + 1), value, out.slice(to + 1))
          : out.slice(0, to).concat(value, out.slice(to, from), out.slice(from + 1));
    } else return;
  }
  if (out.length === st.root.v) st.rendered = out;
};

// A list's reading to be derived when it is read (`render`): kept only where
// the reading before was made, so a block holds one reading of the one
// before it, never a chain of versions.
const deriveLater = (before, block, changes) => {
  const st = STATE.get(block);
  if (isText(st.kind) || st.rendered !== null || !Array.isArray(changes)) return;
  if (STATE.get(before).rendered === null) return;
  st.derivedFrom = { before, changes };
};

// The names of the visible elements in order — a list's members, as the
// children hung under them are composed — kept per version like the
// reading; and whether an element shows.
const elems = (block) => {
  const st = STATE.get(block);
  if (st.elems !== null) return st.elems;
  counters.elemLists++;
  const out = [];
  for (const item of T.iterate(st.root)) {
    if (!item.vis) continue;
    const run = runOf(st, item.run);
    for (let k = 0; k < item.len; k++) out.push(run.elem ?? elemKey(item.run, item.off + k));
  }
  st.elems = out;
  return out;
};
// The index of each visible element by its name (the first, were one shown twice), kept per version.
const elemIndexOf = (block) => {
  const st = STATE.get(block);
  if (st.elemIndex !== null) return st.elemIndex;
  const list = elems(block);
  const index = new Map();
  for (let i = 0; i < list.length; i++) if (!index.has(list[i])) index.set(list[i], i);
  st.elemIndex = index;
  return index;
};
/**
 * Where the element `key` shows in the reading, or -1: its showing slot —
 * the position run the newest move named, else its own — read from the
 * rope, O(log n), on the head of its lineage; an older version reads its
 * list of names, made once, rather than fork the head's hints.
 */
const indexOfElem = (block, key) => {
  const st = STATE.get(block);
  if (st.lineage.head !== block) {
    const i = elemIndexOf(block).get(key);
    return i === undefined ? -1 : i;
  }
  const e = parseElem(key);
  if (e === null) return -1;
  const winner = P.get(st.pos, key);
  const run = runOf(st, winner === undefined ? e.run : winner[2]);
  const off = winner === undefined ? e.offset : 0;
  // A slot shows under the name its run gives it: a position run's, the moved element's.
  if (run === undefined || run.elem !== (winner === undefined ? null : key) || !run.placed || off >= run.len) {
    return -1;
  }
  const at = positionOfSlot(st, run, off);
  return at.vis ? at.v : -1;
};
const hasElem = (block, key) => indexOfElem(block, key) !== -1;

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
    // A position run (a move's) holds its element alone: what is typed after
    // it is a run of its own, or every slot added would show as that element.
    if (r.origin === origin && r.elem === null && r.len + len <= MAX_RUN) return { run: r.key, from: r.len };
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

/**
 * The visible slots of `[off, off + len)` of run `run`, as the reading shows
 * them: `{ index, count }` — where the first stands, how many are shown —
 * or null when the run is not placed here. O(log n): what a change report
 * (src/text/kind.js) reads an op's cuts and inserts with.
 */
const spanOf = (block, run, off, len) => {
  const st = ensureHead(block);
  const r = runOf(st, run);
  if (r === undefined || !r.placed || !Number.isInteger(off) || off < 0 || off >= r.len || !(len > 0)) return null;
  const last = Math.min(off + len, r.len) - 1;
  const a = positionOfSlot(st, r, off);
  const b = last === off ? a : positionOfSlot(st, r, last);
  return { index: a.v, count: b.v + (b.vis ? 1 : 0) - a.v };
};

/**
 * The visible slots of `[off, off + len)` of run `run` as the reading shows
 * them, one `{ index, count }` per stretch: a run's slots read in offset
 * order, but what others inserted inside the run stands between them, so a
 * range of a run is several stretches of the reading. Merged where two
 * meet; ascending; an empty array when none shows; null when the run is
 * not placed here. O(segments × log n).
 */
const spansOf = (block, run, off, len) => {
  const st = ensureHead(block);
  const r = runOf(st, run);
  if (r === undefined || !r.placed || !Number.isInteger(off) || off < 0 || off >= r.len || !(len > 0)) return null;
  const end = Math.min(off + len, r.len);
  const out = [];
  const found = SL.find(r.segs, off);
  if (found === null) return out;
  const { chunks } = r.segs;
  for (let c = found.c, i = found.i; c < chunks.length; c++, i = 0) {
    const chunk = chunks[c];
    for (; i < chunk.length; i++) {
      const seg = chunk[i];
      if (seg.off >= end) return out;
      const lo = Math.max(off, seg.off);
      const hi = Math.min(end, seg.off + seg.len);
      if (!seg.vis || hi <= lo) continue;
      const index = T.positionOf(st.root, seg, st.lineage).v + (lo - seg.off);
      const prev = out[out.length - 1];
      if (prev !== undefined && prev.index + prev.count === index) prev.count += hi - lo;
      else out.push({ index, count: hi - lo });
    }
  }
  return out;
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

// What waits in a block: runs out of the walk, cuts and extensions of runs
// not here, registers of elements no run holds, marks switched off before
// they arrived — each one a thing a peer could pile up for nothing.
const pendingCount = (block) => {
  const st = STATE.get(block);
  return waiting(st, block.cuts, block.ext);
};

// What waits in a state (a block's or a draft's): an op that might add to it
// asks, which is an op about something not here yet.
const waiting = (st, cuts, ext) => {
  let n = st.pendingRuns;
  for (const key of keysOf(cuts)) n += cuts[key].length;
  for (const key of keysOf(ext)) n += ext[key].length;
  for (const [key] of P.entries(st.pos)) if (!holdsElem(st, key)) n++;
  for (const [key] of P.entries(st.vals)) if (!holdsElem(st, key)) n++;
  for (const [, mark] of P.entries(st.marks)) if (isPlaceholder(mark)) n++;
  return n;
};

// The index a run's arrival (placed, or grown) leaves: none when an anchor
// waited for it — the next query makes it again.
const arrived = (d, key) => {
  if (d.marksIndex !== null && d.marksIndex.waits.has(key)) d.marksIndex = null;
};

/**
 * The block of a sequence field as the engine reads it — the block itself,
 * or, when the record holds plain JSON (read from a file), its hydration
 * under the field's floor: made once per plain block (`HYDRATED`), shared
 * with the op that lands on it next.
 */
const indexOf = (entry, field) => {
  const seq = own(entry.meta.blocks ?? {}, field);
  if (seq === undefined) return null;
  if (STATE.has(seq)) return seq;
  return asBlock(seq, floorOf(entry.meta, field));
};

/**
 * What the engine counted (`counters` above): blocks forked from an older
 * version (`rebuilds`), trees re-hinted after one (`rehints`), hydrations,
 * mark indexes made whole and anchors read, lists read whole and their names
 * listed, segments sealed.
 */
const stats = () => ({ ...counters, rehints: T.stats().rehints });

/**
 * The segments of placed run `run` of a block, in offset order — `[off, len,
 * alive]` — what holds its slots, for a test to read; null when it is not placed.
 */
const segmentsIn = (block, run) => {
  const r = runOf(STATE.get(block), run);
  if (r === undefined || !r.placed) return null;
  const out = [];
  for (const seg of SL.iterate(r.segs)) out.push([seg.off, seg.len, seg.body !== null]);
  return out;
};

module.exports = {
  STATE,
  counters,
  createBlock,
  plainOf,
  createSeq,
  normalizeJson,
  stampsMax,
  belowBase,
  recordOf,
  SEG_MAX,
  seal,
  segmentsOf,
  childrenAt,
  NONE,
  walkSubtree,
  hydrate,
  stampOfKey,
  asBlock,
  sameBase,
  buildIndex,
  ensureHead,
  runOf,
  segOf,
  holdsElem,
  EMBED,
  lengthOf,
  totalOf,
  shownAt,
  heldAt,
  valueAt,
  valuesAt,
  render,
  derive,
  deriveLater,
  elems,
  indexOfElem,
  hasElem,
  elemAt,
  slotAt,
  placeInsert,
  rangesOf,
  cursorAt,
  positionOfSlot,
  spanOf,
  spansOf,
  indexOfCursor,
  anchorOrdinal,
  pendingCount,
  waiting,
  arrived,
  indexOf,
  stats,
  segmentsIn,
  PIECES_MIN,
  piecesOf,
};
