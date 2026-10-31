'use strict';

// The v2 engine's state of a block (./sequence.js holds its design): the names a lineage interns, the
// run records and the spans, the plain object and the WeakMap beside it, a plain block's JSON made whole
// and hydrated into the rope, and every reading of it — elements, values, positions, cursors, what waits.

const { compareClock, floorOf } = require('../vector.js');
const R = require('./rope.js');
const I = require('./ids.js');
const C = require('./cow.js');
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

const { Span } = R;

// ---- names ------------------------------------------------------------------------------------------

// A run's name, parsed once where it enters and shared by every version of the lineage: its number
// within the lineage (`n`), its stamp, its origin, its key as the JSON spells it.
class RunId {
  constructor(n, ts, origin, key) {
    this.n = n;
    this.ts = ts;
    this.origin = origin;
    this.key = key;
    this.hash = -1;
  }
}
// The names a lineage of versions interned — a hydration, a join, a prune that rebuilds start one;
// every op and fork after shares it. Only grows.
class Doc {
  constructor() {
    this.byKey = new Map();
    this.count = 0;
  }
}
const intern = (doc, key, ts, origin) => {
  let id = doc.byKey.get(key);
  if (id === undefined) {
    id = new RunId(doc.count++, ts, origin, key);
    doc.byKey.set(key, id);
  }
  return id;
};
/** The FNV-1a hash of a run's key — what a block's pieces are bucketed by — made once. */
const hashOfId = (id) => {
  if (id.hash === -1) id.hash = C.fnv(id.key);
  return id.hash;
};

// A run's record and its spans in the id index (./ids.js): the record at offset -1, a span at its own.
const SPAN = 2097152;
const keyOf = (n, off) => n * SPAN + off + 1;

// The owners: one per op, one per hydration (./cow.js).
let owners = 0;
const nextOwner = () => ++owners;

// A run's record, one per version that changed it: where it hangs (`side` of slot `aOff` of run `aId`,
// none for the head), the element a position run names (`elem`), its length, its content while it
// waits out of the walk (`rle`), its fences once placed, its children by offset on each side (`L`, `R`:
// ./cow.js lists of `Child`), how many right children sort after its continuation (`tails`), its JSON
// tuple once made (`tuple`), and the spans a walk is laying (`segs`, the walk's own).
class Run {
  constructor(id, at, side, aId, aOff, elem, len, owner) {
    this.id = id;
    this.at = at;
    this.side = side;
    this.aId = aId;
    this.aOff = aOff;
    this.elem = elem;
    this.len = len;
    this.placed = false;
    this.rle = null;
    this.open = null;
    this.close = null;
    this.L = null;
    this.R = null;
    this.tails = 0;
    this.owner = owner;
    this.tuple = null;
    this.segs = null;
  }
}
const copyRun = (run, owner) => {
  const r = new Run(run.id, run.at, run.side, run.aId, run.aOff, run.elem, run.len, owner);
  r.placed = run.placed;
  r.rle = run.rle;
  r.open = run.open;
  r.close = run.close;
  r.L = run.L;
  r.R = run.R;
  r.tails = run.tails;
  return r;
};
// The runs hung at one offset of a run, sorted by origin then stamp.
class Child {
  constructor(off, ids) {
    this.off = off;
    this.ids = ids;
  }
}

// ---- the block ------------------------------------------------------------------------------------

// What the engine did that costs more than the path an op copies — counted so a test can say it did
// not happen: hydrations, indexes of the marks made whole and the anchors they read, lists read whole
// and their names listed, full segments sealed (`rebuilds` stays 0: no version is forked here, a
// frozen one reads from a walk of its own — ./rope.js `walks`).
const counters = {
  rebuilds: 0,
  hydrations: 0,
  markIndexes: 0,
  anchorReads: 0,
  listRenders: 0,
  elemLists: 0,
  seals: 0,
};

// The engine's state of a block: the tables of its lineage, its owner (an op's, or a hydration's) and
// whether a later op froze it, the rope and the id index, the roots, what waits, the counts the bounds
// read, the registers and the marks, and what is cached for this version.
class State {
  constructor(doc, kind, owner) {
    this.doc = doc;
    this.kind = kind;
    this.owner = owner;
    this.frozen = false;
    this.base = null;
    this.root = null;
    this.ids = I.EMPTY;
    this.runCount = 0;
    this.roots = null;
    this.ownRoots = false;
    this.pending = C.EMPTY;
    this.pendingRuns = 0;
    this.slots = 0;
    this.oldest = null;
    this.oldestAnchor = null;
    this.ts = 0;
    this.cuts = null;
    this.ext = null;
    this.pos = C.EMPTY;
    this.vals = C.EMPTY;
    this.marks = C.EMPTY;
    this.marksIndex = null;
    this.tokens = null;
    this.ownTokens = false;
    this.views = null;
    this.rendered = null;
    this.derivedFrom = null;
    this.elems = null;
    this.elemIndex = null;
    this.json = null;
    this.walked = null;
  }
}

// The state of a block is a private field the plain object is stamped with — a constructor that returns
// the object it is given lends it its fields — so the object reads, serializes, spreads and compares as
// the JSON it shows, and finding its state is a field read: a WeakMap entry per version cost an op more
// than the rest of its face, most of it in the collector.
class Face {
  constructor(object) {
    return object;
  }
}
class STATE extends Face {
  #state;
  constructor(object, state) {
    super(object);
    this.#state = state;
  }
  /** The engine's state of a block, or undefined for anything else. */
  static get(object) {
    return typeof object === 'object' && object !== null && #state in object ? object.#state : undefined;
  }
  static has(object) {
    return typeof object === 'object' && object !== null && #state in object;
  }
}
const stamp = (block, state) => new STATE(block, state);

const MAPS = ['cuts', 'ext', 'pos', 'vals', 'marks'];
const REGISTERS = ['pos', 'vals', 'marks'];
const hasAny = (map) => {
  if (map === undefined || map === null) return false;
  for (const key in map) if (Object.hasOwn(map, key)) return true;
  return false;
};
// A register map or the marks as the record holds them: a plain object, in the order the trie walks.
const viewOf = (block, name) => {
  const st = STATE.get(block);
  const views = (st.views ??= { pos: null, vals: null, marks: null });
  if (views[name] !== null) return views[name];
  const out = {};
  const pairs = C.pairs(st[name]);
  for (let i = 0; i < pairs.length; i++) out[pairs[i].key] = pairs[i].value;
  views[name] = out;
  return out;
};
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
// `runs`, one getter every block shares.
const RUNS = {
  get() {
    return runsJson(this);
  },
  enumerable: true,
  configurable: true,
};
const createBlock = (state) => {
  const block = { k: state.kind, ts: state.ts };
  Object.defineProperty(block, 'runs', RUNS);
  if (hasAny(state.cuts)) block.cuts = state.cuts;
  if (hasAny(state.ext)) block.ext = state.ext;
  for (const name of REGISTERS) if (state[name].size > 0) Object.defineProperty(block, name, VIEW[name]);
  return stamp(block, state);
};

// A plain register map or marks as the engine's map: the tuples as they are.
const mapOf = (plain, owner) => {
  let map = C.EMPTY;
  if (plain === undefined || plain === null) return map;
  const keys = Object.keys(plain);
  for (let i = 0; i < keys.length; i++) map = C.set(map, keys[i], plain[keys[i]], owner);
  return map;
};

// A block as plain JSON, to hydrate again (a base it has not seen, a prune, a join).
const plainOf = (block) => {
  const out = { k: block.k, ts: block.ts, runs: runsJson(block, false) };
  for (const name of MAPS) if (block[name] !== undefined) out[name] = block[name];
  return out;
};

const runById = (st, id) => I.get(st.ids, id.n * SPAN);
const runOf = (st, key) => {
  const id = st.doc.byKey.get(key);
  return id === undefined ? undefined : I.get(st.ids, id.n * SPAN);
};

// A run's content as one canonical RLE: its spans in offset order, the pieces that read alike joined.
const rleOf = (st, run) => {
  if (!run.placed) return run.rle;
  const text = isText(st.kind);
  const out = [];
  const { id } = run;
  const cursor = I.seek(st.ids, keyOf(id.n, 0));
  for (let seg = cursor.value; seg instanceof Span && seg.run === id; I.next(cursor), seg = cursor.value) {
    const last = out.length - 1;
    if (seg.body === null) {
      if (last >= 0 && typeof out[last] === 'number') out[last] += seg.len;
      else out.push(seg.len);
    } else if (last >= 0 && typeof out[last] !== 'number') {
      out[last] = text ? out[last] + seg.body : out[last].concat(seg.body);
    } else out.push(text ? seg.body : seg.body.slice());
  }
  return out;
};

// A run's JSON tuple, kept on its record: a record is replaced whenever it or its spans change, so a
// version's `runs` reuses the tuple of every run the op left alone. Kept only where a version is
// serialized (`keep`).
const tupleOf = (st, run, keep) => {
  if (run.tuple !== null) return run.tuple;
  const tuple = run.elem !== null ? [run.at, rleOf(st, run), run.elem] : [run.at, rleOf(st, run)];
  if (keep) run.tuple = tuple;
  return tuple;
};

// Every run record of a version, in the order of their numbers.
const recordsOf = (st) => {
  const out = [];
  const cursor = I.seek(st.ids, -1);
  for (let value = cursor.value; value !== undefined; I.next(cursor), value = cursor.value) {
    if (value instanceof Run) out.push(value);
  }
  return out;
};

// The `runs` map of a block, in walk order then the waiting ones by key; made once per version.
const runsJson = (block, keep = true) => {
  const st = STATE.get(block);
  if (st.json !== null) return st.json;
  const out = {};
  const cursor = R.first(st.root);
  if (cursor !== null) {
    for (let span = cursor.span; span !== null; span = R.next(cursor)) {
      if (span.fence === 1) out[span.run.key] = tupleOf(st, runById(st, span.run), keep);
    }
  }
  const waiting = [];
  const records = recordsOf(st);
  for (let i = 0; i < records.length; i++) if (!records[i].placed) waiting.push(records[i]);
  waiting.sort(byKey);
  for (let i = 0; i < waiting.length; i++) out[waiting[i].id.key] = tupleOf(st, waiting[i], keep);
  st.json = out;
  return out;
};
const byKey = (a, b) => (a.id.key < b.id.key ? -1 : a.id.key > b.id.key ? 1 : 0);
const byIdKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

// ---- a block in pieces ------------------------------------------------------------------------------

// A block of PIECES_MIN runs or more is written in pieces (src/entries.js): its runs by the first five
// bits of their keys' hash, a piece a bucket, the rest of the block whole beside them (`head`). A
// piece's `key` is its bucket's TOKEN: an op that writes a run of a bucket gives the bucket a new one,
// so the file of every other bucket stays. A piece lists its runs as the v1 map walked them.
const PIECES_MIN = 1024;
class Token {
  constructor(owner) {
    this.owner = owner;
  }
}
// The bucket of run `id` written by draft `d`: a new token, once per op.
const touchToken = (d, id) => {
  if (d.tokens === null) return;
  if (!d.ownTokens) {
    d.tokens = d.tokens.slice();
    d.ownTokens = true;
  }
  const b = hashOfId(id) & 31;
  if (d.tokens[b].owner !== d.owner) d.tokens[b] = new Token(d.owner);
};
const byWalk = (a, b) => {
  const x = C.walkOrderOf(hashOfId(a.id));
  const y = C.walkOrderOf(hashOfId(b.id));
  return x - y || byKey(a, b);
};
const piecesOf = (block) => {
  const st = STATE.get(block);
  const head = {};
  const names = Object.keys(block);
  for (let i = 0; i < names.length; i++) if (names[i] !== 'runs') head[names[i]] = block[names[i]];
  const slots = [];
  if (st === undefined) {
    const keys = keysOf(block.runs);
    if (keys.length < PIECES_MIN) return null;
    const groups = [];
    for (let i = 0; i < 32; i++) groups.push(null);
    for (let i = 0; i < keys.length; i++) {
      const at = C.fnv(keys[i]) & 31;
      if (groups[at] === null) groups[at] = {};
      groups[at][keys[i]] = block.runs[keys[i]];
    }
    for (let i = 0; i < 32; i++) {
      const group = groups[i];
      slots.push(group === null ? null : { key: group, text: () => JSON.stringify(group) });
    }
    return { head, slots };
  }
  if (st.runCount < PIECES_MIN) return null;
  if (st.tokens === null) {
    st.tokens = [];
    for (let i = 0; i < 32; i++) st.tokens.push(new Token(st.owner));
  }
  const groups = [];
  for (let i = 0; i < 32; i++) groups.push([]);
  const records = recordsOf(st);
  for (let i = 0; i < records.length; i++) groups[hashOfId(records[i].id) & 31].push(records[i]);
  for (let i = 0; i < 32; i++) {
    const group = groups[i];
    slots.push(group.length === 0 ? null : { key: st.tokens[i], text: () => pieceText(st, group) });
  }
  return { head, slots };
};
const pieceText = (st, group) => {
  group.sort(byWalk);
  const out = {};
  for (let i = 0; i < group.length; i++) out[group[i].id.key] = tupleOf(st, group[i], true);
  return JSON.stringify(out);
};

/** An empty block of a kind. */
const createSeq = (kind) => hydrate({ k: kind, ts: 0, runs: {} }, null);

// ---- normalizing a peer's block ---------------------------------------------------------------------

// A peer's block (or any plain one), checked into the canonical plain shape: every key of a known form,
// every run a canonical RLE of the block's kind anchored at an element older than itself, every anchor
// and register well-formed, the whole within MAX_FIELD slots. Anything else is dropped; a block with
// nothing left, or past the field bound, is null.
const normalizeJson = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.k === 't' || raw.k === 'l' ? raw.k : null;
  if (kind === null) return null;
  const seq = { k: kind, ts: 0, runs: {} };
  let slots = 0;
  let runs = 0;
  const runKeys = keysOf(raw.runs);
  for (let i = 0; i < runKeys.length; i++) {
    const key = runKeys[i];
    const run = raw.runs[key];
    const made = parseRun(key);
    if (made === null || !Array.isArray(run) || run.length < 2 || run.length > 3) continue;
    const anchor = parseAnchor(run[0]);
    if (anchor === null || run[0] === END || (anchor.elem !== null && anchor.elem.ts >= made.ts)) continue;
    const content = normalizeRle(kind, run[1]);
    if (content === null) continue;
    if (run.length === 3 && (kind !== 'l' || !isElemKey(run[2]) || rleLength(content) !== 1)) continue;
    slots += rleLength(content);
    if (slots > MAX_FIELD) return null;
    seq.runs[key] = run.length === 3 ? [run[0], content, run[2]] : [run[0], content];
    runs++;
  }
  const cutKeys = keysOf(raw.cuts);
  for (let k = 0; k < cutKeys.length; k++) {
    const key = cutKeys[k];
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
  const extKeys = keysOf(raw.ext);
  for (let k = 0; k < extKeys.length; k++) {
    const key = extKeys[k];
    if (!isRunKey(key) || !Array.isArray(raw.ext[key])) continue;
    const list = [];
    const items = raw.ext[key];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!Array.isArray(item) || item.length !== 2 || !Number.isInteger(item[0]) || item[0] < 0) continue;
      const content = present(kind, item[1]) && item[1].length > 0 ? (isText(kind) ? item[1] : item[1].slice()) : null;
      if (content !== null) list.push([item[0], content]);
    }
    if (list.length > 0) (seq.ext ??= {})[key] = list;
  }
  const register = (raw2, check) => {
    const out = {};
    let n = 0;
    const keys = keysOf(raw2);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
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
  const vals = register(raw.vals, isJson);
  if (vals) seq.vals = vals;
  if (kind === 't') {
    const marks = {};
    let n = 0;
    const markKeys = keysOf(raw.marks);
    for (let i = 0; i < markKeys.length; i++) {
      const key = markKeys[i];
      const m = raw.marks[key];
      const made = parseRun(key);
      if (made === null || !Array.isArray(m) || m.length !== 5) continue;
      const from = parseAnchor(m[0]);
      const to = parseAnchor(m[1]);
      if (from === null || to === null || typeof m[2] !== 'string' || !isJson(m[3])) continue;
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

// The newest stamp a plain block holds — its runs, registers and marks.
const stampsMax = (seq) => {
  let ts = 0;
  const runKeys = Object.keys(seq.runs);
  for (let i = 0; i < runKeys.length; i++) ts = Math.max(ts, parseRun(runKeys[i]).ts);
  for (const map of ['pos', 'vals']) {
    const keys = keysOf(seq[map]);
    for (let i = 0; i < keys.length; i++) ts = Math.max(ts, seq[map][keys[i]][0]);
  }
  const markKeys = keysOf(seq.marks);
  for (let i = 0; i < markKeys.length; i++) ts = Math.max(ts, parseRun(markKeys[i]).ts);
  return ts;
};

// ---- the rope: hydration ----------------------------------------------------------------------------

// Whether an element's stamp fell below the base: its run was dropped, and a run anchored at it reads
// from the head.
const belowBase = (ts, origin, base) => base !== null && compareClock([ts, origin], base) < 0;

// A run's record from its tuple, unplaced: its name and its anchor's interned.
const recordOf = (doc, key, tuple, owner, anchor = parseAnchor(tuple[0])) => {
  const made = parseRun(key);
  const id = intern(doc, key, made.ts, made.origin);
  const e = anchor.elem;
  const aId = e === null ? null : intern(doc, e.run, e.ts, e.origin);
  const run = new Run(id, tuple[0], anchor.side, aId, e === null ? 0 : e.offset, tuple[2] ?? null, 0, owner);
  run.rle = tuple[1];
  run.len = rleLength(tuple[1]);
  return run;
};

// Whether slot `off` of run `id` shows, beside being alive: a list slot shows when it is the position
// its element's register names — its own slot when no move named one, else the position run the newest
// move made.
const showsAt = (kind, pos, id, elem, off) => {
  if (isText(kind)) return true;
  const name = elem ?? elemKey(id.key, off);
  const winner = C.get(pos, name);
  if (winner === undefined) return elem === null;
  return elem === name && id.key === winner[2];
};

// Where each piece of a run's content starts, the first at `base`.
const startsOf = (pieces, base) => {
  const out = [];
  let at = base;
  for (let i = 0; i < pieces.length; i++) {
    out.push(at);
    at += segLength(pieces[i]);
  }
  return out;
};
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

// A body grows by SEG_MAX slots at most (v1's rule, kept: a text typed long is what was typed, sealed
// flat, and the end being typed; a list's spans of SEG_MAX).
const SEG_MAX = 2048;

let sealed = 0;
const seal = (body) => {
  counters.seals++;
  if (typeof body === 'string' && body.length > 0) sealed ^= body.charCodeAt(body.length >> 1);
};

// A span of `len` slots of run `id` at `off` after the items `out` holds, joined to the last when it
// continues it (same run, next slot, shown alike, both alive or both gaps) and the two hold SEG_MAX
// slots at most; a new one goes into `segs` too — a list's content past the cap in spans of SEG_MAX, a
// text's piece whole.
const pushSeg = (id, off, len, vis, body, out, segs, owner) => {
  const last = out.length > 0 ? out[out.length - 1] : null;
  if (
    last !== null &&
    last.fence === 0 &&
    last.run === id &&
    last.off + last.len === off &&
    last.vis === vis &&
    (last.body === null) === (body === null) &&
    (body === null || last.len + len <= SEG_MAX)
  ) {
    last.len += len;
    if (body !== null) {
      if (typeof body === 'string') last.body += body;
      else for (let i = 0; i < body.length; i++) last.body.push(body[i]);
    }
    return;
  }
  if (body === null || len <= SEG_MAX || typeof body === 'string') {
    const seg = new Span(id, off, len, vis, body, 0, owner);
    out.push(seg);
    segs.push(seg);
    return;
  }
  for (let at = 0; at < len; at += SEG_MAX) {
    const n = Math.min(SEG_MAX, len - at);
    const seg = new Span(id, off + at, n, vis, body.slice(at, at + n), 0, owner);
    out.push(seg);
    segs.push(seg);
  }
};

// The spans of slots [from, to) of run `id` from its content `pieces` (starting at `starts`): a piece is
// one span — a text's piece its own string, a gap a gap — unless the run is a list under moves, where
// each slot shows or not by its register.
const emitPieces = (kind, pos, id, elem, pieces, starts, from, to, out, segs, owner) => {
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
    if (typeof piece === 'number') pushSeg(id, a, b - a, false, null, out, segs, owner);
    else if (!perSlot) {
      const whole = a === start && b === end && text;
      const body = whole ? piece : piece.slice(a - start, b - start);
      pushSeg(id, a, b - a, text || elem === null, body, out, segs, owner);
    } else {
      for (let o = a; o < b; o++) {
        pushSeg(id, o, 1, showsAt(kind, pos, id, elem, o), [piece[o - start]], out, segs, owner);
      }
    }
  }
};

/** The spans of `content` as the slots of `run` from `from` on, made `owner`'s. */
const segmentsOf = (kind, pos, run, from, content, owner) => {
  const out = [];
  const segs = [];
  emitPieces(
    kind,
    pos,
    run.id,
    run.elem,
    content,
    startsOf(content, from),
    from,
    from + rleLength(content),
    out,
    segs,
    owner,
  );
  return out;
};

// The runs hung at offset `off` on one side of a run (a list of Child), or undefined.
const childrenAt = (list, off) => {
  if (list === null) return undefined;
  const entry = C.at(list, off);
  return entry === undefined ? undefined : entry.ids;
};
const NONE = Object.freeze([]);

// The offsets of a run where a child hangs, in order — where the walk of its content stops.
const offsetsOf = (list, out) => {
  const { chunks } = list;
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    for (let i = 0; i < chunk.length; i++) out.push(chunk[i].off);
  }
  return out;
};
const eventsOf = (r) => {
  if (r.L === null) return r.R === null ? NONE : offsetsOf(r.R, []);
  if (r.R === null) return offsetsOf(r.L, []);
  const a = offsetsOf(r.L, []);
  const b = offsetsOf(r.R, []);
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

// ---- the walk of a subtree --------------------------------------------------------------------------

// A walk: the version it reads runs from (none for a hydration's own records), the run it places (not
// in the version yet), what it emits, the placed copies it makes — or, when the records are the walk's
// own (`own`: a hydration's, shared with nothing yet), the records themselves placed in place.
class Walk {
  constructor(st, extra, kind, pos, copies, own, owner) {
    this.st = st;
    this.extra = extra;
    this.kind = kind;
    this.pos = pos;
    this.items = [];
    this.copies = copies;
    this.own = own;
    this.owner = owner;
  }
}
const runAt = (w, id) => {
  const copy = w.copies.get(id);
  if (copy !== undefined) return copy;
  if (w.extra !== null && w.extra.id === id) return w.extra;
  return runById(w.st, id);
};
// The right children of slot `off` of `r` in walk order, its continuation among them by origin (CONT).
const CONT = null;
const ONLY_CONT = Object.freeze([CONT]);
const rightsOf = (r, off) => {
  const explicit = childrenAt(r.R, off);
  const cont = off + 1 < r.len;
  if (explicit === undefined) return cont ? ONLY_CONT : NONE;
  if (!cont) return explicit;
  const rights = [];
  let placed = false;
  for (let i = 0; i < explicit.length; i++) {
    if (!placed && byOrigin(r.id, explicit[i]) < 0) {
      rights.push(CONT);
      placed = true;
    }
    rights.push(explicit[i]);
  }
  if (!placed) rights.push(CONT);
  return rights;
};
const enter = (w, id) => {
  const g = runAt(w, id);
  const open = new Span(id, 0, 0, false, null, 1, w.owner);
  w.items.push(open);
  if (w.own) {
    g.placed = true;
    g.segs = [];
    g.open = open;
    return g;
  }
  const r = copyRun(g, w.owner);
  r.placed = true;
  r.segs = [];
  r.open = open;
  r.close = null;
  w.copies.set(id, r);
  return r;
};
const leave = (w, r) => {
  r.close = new Span(r.id, 0, 0, false, null, 2, w.owner);
  w.items.push(r.close);
};
class Frame {
  constructor(r, off, first, ev, starts) {
    this.r = r;
    this.off = off;
    this.phase = 0;
    this.i = 0;
    this.rights = null;
    this.first = first;
    this.ev = ev;
    this.ei = 0;
    this.starts = starts;
  }
}
const openFrame = (w, id) => {
  const r = enter(w, id);
  return new Frame(r, 0, true, eventsOf(r), startsOf(r.rle, 0));
};
// The walk of run `top` and the runs hung under it, as spans in order (v1's walk, frame by frame: a
// run's continuation steps the frame in place when it is the only right child, else it is a frame of
// its own; a run's close falls when the frame it was entered by pops).
const walkSubtree = (w, top) => {
  const stack = [openFrame(w, top)];
  const { kind, pos, items, owner } = w;
  while (stack.length > 0) {
    const f = stack[stack.length - 1];
    const { r } = f;
    if (f.phase === 0) {
      const { ev } = f;
      while (f.ei < ev.length && ev[f.ei] < f.off) f.ei++;
      const e = f.ei < ev.length ? ev[f.ei] : r.len;
      if (e > f.off) {
        emitPieces(kind, pos, r.id, r.elem, r.rle, f.starts, f.off, e, items, r.segs, owner);
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
      emitPieces(kind, pos, r.id, r.elem, r.rle, f.starts, f.off, f.off + 1, items, r.segs, owner);
      f.rights = rightsOf(r, f.off);
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
        } else stack.push(new Frame(r, f.off + 1, false, f.ev, f.starts));
      } else stack.push(openFrame(w, nextRight));
      continue;
    }
    if (f.first) leave(w, r);
    stack.pop();
  }
};

// The block of a plain (canonical) block JSON, built under `base`: the run records, where each stands
// — a root, a child, or waiting — the walk as the rope and the records with their spans as the id index,
// in one pass.
const hydrate = (seq, base) => {
  counters.hydrations++;
  const kind = seq.k;
  const doc = new Doc();
  const owner = nextOwner();
  const st = new State(doc, kind, owner);
  const pos = mapOf(seq.pos, owner);
  const records = new Map();
  const runKeys = Object.keys(seq.runs);
  for (let i = 0; i < runKeys.length; i++) {
    const run = recordOf(doc, runKeys[i], seq.runs[runKeys[i]], owner);
    records.set(run.id, run);
  }
  const roots = [];
  const waiting = new Map();
  // Each side's children gathered as entries, in order of arrival; sorted once below.
  const lefts = new Map();
  const rights = new Map();
  let pendingRuns = 0;
  let slots = 0;
  let oldest = null;
  let oldestAnchor = null;
  for (const run of records.values()) {
    const { id } = run;
    slots += run.len;
    oldest = olderOf(oldest, id.ts, id.origin);
    if (run.aId === null) {
      roots.push(run);
      continue;
    }
    const e = run.aId;
    oldestAnchor = olderOf(oldestAnchor, e.ts, e.origin);
    if (belowBase(e.ts, e.origin, base)) {
      roots.push(run);
      continue;
    }
    const parent = records.get(e);
    if (parent === undefined || run.aOff >= parent.len) {
      const list = waiting.get(e);
      if (list) list.push(id);
      else waiting.set(e, [id]);
      pendingRuns++;
      continue;
    }
    const sides = run.side === 'L' ? lefts : rights;
    let gathered = sides.get(parent);
    if (gathered === undefined) {
      gathered = { entries: [], byOff: new Map() };
      sides.set(parent, gathered);
    }
    const entry = gathered.byOff.get(run.aOff);
    if (entry !== undefined) entry.ids.push(id);
    else {
      const made = new Child(run.aOff, [id]);
      gathered.entries.push(made);
      gathered.byOff.set(run.aOff, made);
    }
  }
  roots.sort(byRecordOrigin);
  for (const [parent, gathered] of lefts) parent.L = childrenList(gathered.entries);
  for (const [parent, gathered] of rights) {
    const { entries } = gathered;
    for (let k = 0; k < entries.length; k++) {
      const { off, ids } = entries[k];
      if (off + 1 >= parent.len) continue;
      for (let i = 0; i < ids.length; i++) if (byOrigin(parent.id, ids[i]) < 0) parent.tails++;
    }
    parent.R = childrenList(entries);
  }
  let pending = C.EMPTY;
  for (const [e, list] of waiting) {
    if (list.length > 1) list.sort(byIdKey);
    pending = C.set(pending, e.n, list, owner);
  }
  for (const map of ['cuts', 'ext', 'marks']) {
    const keys = keysOf(seq[map]);
    for (let i = 0; i < keys.length; i++) oldest = minStamp(oldest, stampOfKey(keys[i]));
  }
  for (const map of ['pos', 'vals']) {
    const keys = keysOf(seq[map]);
    for (let i = 0; i < keys.length; i++) oldest = minStamp(oldest, [seq[map][keys[i]][0], seq[map][keys[i]][1]]);
  }
  // The walk of every root and what hangs under it, the records placed in place.
  const w = new Walk(null, null, kind, pos, records, true, owner);
  const rootIds = [];
  for (let i = 0; i < roots.length; i++) {
    rootIds.push(roots[i].id);
    walkSubtree(w, roots[i].id);
  }
  // The id index: each record, then its spans, in the order of the records' numbers.
  const sorted = [];
  for (const run of records.values()) sorted.push(run);
  sorted.sort(byNumber);
  const keys = [];
  const values = [];
  for (let i = 0; i < sorted.length; i++) {
    const run = sorted[i];
    const { n } = run.id;
    keys.push(n * SPAN);
    values.push(run);
    if (run.segs === null) continue;
    for (let k = 0; k < run.segs.length; k++) {
      keys.push(keyOf(n, run.segs[k].off));
      values.push(run.segs[k]);
    }
    run.segs = null;
    run.rle = null;
  }
  st.base = base;
  st.root = R.fromSpans(w.items, owner);
  st.ids = I.fromSorted(keys, values, owner);
  st.runCount = sorted.length;
  st.roots = rootIds;
  st.pending = pending;
  st.pendingRuns = pendingRuns;
  st.slots = slots;
  st.oldest = oldest;
  st.oldestAnchor = oldestAnchor;
  st.ts = seq.ts;
  st.cuts = hasAny(seq.cuts) ? seq.cuts : null;
  st.ext = hasAny(seq.ext) ? seq.ext : null;
  st.pos = pos;
  st.vals = mapOf(seq.vals, owner);
  st.marks = mapOf(seq.marks, owner);
  return createBlock(st);
};
const byRecordOrigin = (a, b) => byOrigin(a.id, b.id);
const byNumber = (a, b) => a.id.n - b.id.n;
// One side's children from its entries as they were gathered: each list by origin, the entries by offset.
const byOff = (a, b) => a.off - b.off;
const childrenList = (entries) => {
  for (let i = 0; i < entries.length; i++) if (entries[i].ids.length > 1) entries[i].ids.sort(byOrigin);
  if (entries.length > 1) entries.sort(byOff);
  return C.listOf(entries);
};

const stampOfKey = (key) => {
  const { ts, origin } = parseRun(key);
  return [ts, origin];
};

// The engine's block of each plain block it was asked for, with the base it was built under.
const HYDRATED = new WeakMap();

// A block as the engine holds it, from whatever was given: a block of this engine (rebuilt under `base`
// when it was built under another), or plain JSON hydrated — once per plain block and base.
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
    return hydrate(plainOf(seq), base);
  }
  return seq;
};
const sameBase = (a, b) => a === b || (a !== null && b !== null && a[0] === b[0] && a[1] === b[1]);

/** What a reading reads through: the block itself, hydrated when plain. */
const buildIndex = (seq, base = null) => asBlock(seq, base);

// ---- drafts -----------------------------------------------------------------------------------------

// The state an op writes: the block it starts from frozen (O(1): every node of it is copied before it
// is written), a new owner, the fields shared until written.
const draft = (block) => {
  const st = STATE.get(block);
  st.frozen = true;
  const d = new State(st.doc, st.kind, nextOwner());
  d.base = st.base;
  d.root = st.root;
  d.ids = st.ids;
  d.runCount = st.runCount;
  d.roots = st.roots;
  d.pending = st.pending;
  d.pendingRuns = st.pendingRuns;
  d.slots = st.slots;
  d.oldest = st.oldest;
  d.oldestAnchor = st.oldestAnchor;
  d.ts = block.ts;
  d.cuts = block.cuts ?? null;
  d.ext = block.ext ?? null;
  d.pos = st.pos;
  d.vals = st.vals;
  d.marks = st.marks;
  // The index of the marks holds across an op that leaves them: the order of the slots their anchors
  // name never changes.
  d.marksIndex = st.marksIndex;
  d.tokens = st.tokens;
  return d;
};
/** The block of a draft. */
const finish = (d) => createBlock(d);

// The roots of a draft, its own to change.
const rootsOf = (d) => {
  if (!d.ownRoots) {
    d.roots = d.roots.slice();
    d.ownRoots = true;
  }
  return d.roots;
};

// A run's record set in a draft (a new one, or one replaced).
const setRun = (d, run) => {
  d.ids = I.set(d.ids, run.id.n * SPAN, run, d.owner);
  if (I.wasAdded()) d.runCount++;
  touchToken(d, run.id);
  return run;
};
// The record of run `id`, the draft's own to change: copied (and set) unless it is.
const writableRun = (d, id) => {
  const run = runById(d, id);
  if (run.owner === d.owner) {
    run.tuple = null;
    return run;
  }
  return setRun(d, copyRun(run, d.owner));
};
// The spans of run `id` in the id index: `added` set, `removed` taken where none of `added` stands at
// its offset; the record touched, as its JSON changed.
const setSpans = (d, id, removed, added) => {
  const { owner } = d;
  for (let i = 0; i < added.length; i++) d.ids = I.set(d.ids, keyOf(id.n, added[i].off), added[i], owner);
  for (let i = 0; i < removed.length; i++) {
    const { off } = removed[i];
    let kept = false;
    for (let k = 0; k < added.length && !kept; k++) kept = added[k].off === off;
    if (!kept) d.ids = I.remove(d.ids, keyOf(id.n, off), owner);
  }
  writableRun(d, id);
};

// ---- the rope: reading ------------------------------------------------------------------------------

// The span holding slot `off` of a placed run; undefined past its length.
const segOf = (st, run, off) => {
  const seg = I.floor(st.ids, keyOf(run.id.n, off));
  return seg instanceof Span && seg.run === run.id && off < seg.off + seg.len ? seg : undefined;
};
// The last span of a placed run.
const lastSegOf = (st, run) => I.floor(st.ids, keyOf(run.id.n, SPAN - 2));

// Whether the block holds the element `key` names: its run, long enough.
const holdsElem = (st, key) => {
  const e = parseElem(key);
  const run = runOf(st, e.run);
  return run !== undefined && e.offset < run.len;
};

// The character a text's embed sits in: U+FFFC; its value is the slot's entry in `vals`.
const EMBED = '\uFFFC';

/** How many visible elements the field reads as. */
const lengthOf = (block) => STATE.get(block).root.v;
/** Every slot of the walk, tombstones included. */
const totalOf = (block) => STATE.get(block).root.s;

/** What the slot at visible index `i` holds — before any value assigned to it. */
const heldAt = (block, i) => {
  const st = STATE.get(block);
  const found = R.spanAt(st.root, true, i);
  return found === null ? undefined : found.span.body[i - found.v];
};

// The value of slot `k` of `span`: what an assignment set, else what it holds.
const valueOf = (st, span, k) => {
  const held = span.body[k];
  if (st.vals.size === 0 || (isText(st.kind) && held !== EMBED)) return held;
  const run = runById(st, span.run);
  const assigned = C.get(st.vals, run.elem ?? elemKey(span.run.key, span.off + k));
  return assigned === undefined ? held : assigned[2];
};

const valueAt = (block, i) => {
  const st = STATE.get(block);
  const found = R.spanAt(st.root, true, i);
  if (found === null) return undefined;
  const { span, v } = found;
  return valueOf(st, span, i - v);
};

/** What visible [i, i + count) reads as, from the rope in O(log n + count). */
const valuesAt = (block, i, count) => {
  const st = STATE.get(block);
  const text = isText(st.kind);
  let out = text ? '' : [];
  const cursor = count > 0 ? R.locate(st.root, true, i) : null;
  if (cursor === null) return out;
  let k = i - cursor.v;
  for (let span = cursor.span; span !== null && out.length < count; span = R.next(cursor), k = 0) {
    if (!span.vis) continue;
    const n = Math.min(span.len - k, count - out.length);
    if (text) out += span.body.slice(k, k + n);
    else for (let j = k; j < k + n; j++) out.push(valueOf(st, span, j));
  }
  return out;
};

// The runs an element of which holds an assigned value.
const assignedRuns = (st) => {
  const out = new Set();
  const pairs = C.pairs(st.vals);
  for (let i = 0; i < pairs.length; i++) {
    const e = parseElem(pairs[i].key);
    if (e !== null) out.add(e.run);
  }
  return out;
};

// What the field reads as: the visible elements in order — kept per version; a text's from the rope's
// own cache, a list's made whole when nothing gave it from the version before (`derive`).
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
  if (isText(st.kind)) out = R.text(st.root);
  else {
    counters.listRenders++;
    out = [];
    const flagged = st.vals.size > 0 ? assignedRuns(st) : null;
    const cursor = R.first(st.root);
    for (let span = cursor === null ? null : cursor.span; span !== null; span = R.next(cursor)) {
      if (!span.vis) continue;
      const run = flagged === null ? null : runById(st, span.run);
      if (run === null || (run.elem === null && !flagged.has(span.run.key))) {
        for (let k = 0; k < span.len; k++) out.push(span.body[k]);
      } else for (let k = 0; k < span.len; k++) out.push(valueOf(st, span, k));
    }
  }
  st.rendered = out;
  return out;
};

/**
 * A list's reading after an op, derived from the reading before it and what the op changed instead of
 * made whole. Kept as the block's reading when its length is the block's; nothing when `before` was
 * never read.
 */
const derive = (before, block, changes) => {
  const st = STATE.get(block);
  const prev = STATE.get(before).rendered;
  if (isText(st.kind) || st.rendered !== null || prev === null || !Array.isArray(changes)) return;
  let out = prev;
  for (let c = 0; c < changes.length; c++) {
    const change = changes[c];
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

// A list's reading to be derived when it is read: kept only where the reading before was made.
const deriveLater = (before, block, changes) => {
  const st = STATE.get(block);
  if (isText(st.kind) || st.rendered !== null || !Array.isArray(changes)) return;
  if (STATE.get(before).rendered === null) return;
  st.derivedFrom = { before, changes };
};

// The names of the visible elements in order, kept per version.
const elems = (block) => {
  const st = STATE.get(block);
  if (st.elems !== null) return st.elems;
  counters.elemLists++;
  const out = [];
  const cursor = R.first(st.root);
  for (let span = cursor === null ? null : cursor.span; span !== null; span = R.next(cursor)) {
    if (!span.vis) continue;
    const run = runById(st, span.run);
    for (let k = 0; k < span.len; k++) out.push(run.elem ?? elemKey(span.run.key, span.off + k));
  }
  st.elems = out;
  return out;
};

/**
 * Where the element `key` shows in the reading, or -1: its showing slot — the position run the newest
 * move named, else its own — read from the rope, O(log n).
 */
const indexOfElem = (block, key) => {
  const st = STATE.get(block);
  const e = parseElem(key);
  if (e === null) return -1;
  const winner = C.get(st.pos, key);
  const run = runOf(st, winner === undefined ? e.run : winner[2]);
  const off = winner === undefined ? e.offset : 0;
  if (run === undefined || run.elem !== (winner === undefined ? null : key) || !run.placed || off >= run.len) {
    return -1;
  }
  const at = positionOfSlot(st, run, off);
  return at.vis ? at.v : -1;
};
const hasElem = (block, key) => indexOfElem(block, key) !== -1;

// The element at visible index `i`: its name, or null out of range.
const elemAt = (block, i) => {
  const st = STATE.get(block);
  const found = R.spanAt(st.root, true, i);
  if (found === null) return null;
  const { span, v } = found;
  const run = runById(st, span.run);
  return run.elem ?? elemKey(span.run.key, span.off + (i - v));
};

// The slot visible index `i` shows at, as a cut range.
const slotAt = (block, i) => {
  const st = STATE.get(block);
  const found = R.spanAt(st.root, true, i);
  return found === null ? null : [found.span.run.key, found.span.off + (i - found.v), 1];
};

// The element at slot ordinal `s` of the walk.
const elemAtSlot = (st, s) => {
  const found = R.spanAt(st.root, false, s);
  return elemKey(found.span.run.key, found.span.off + (s - found.s));
};

// Where a local insertion of `len` elements at visible index `i` goes: the anchor of a new run, or the
// run of this origin to extend. Null when `i` is out of range. Fugue's rule, read off the rope.
const placeInsert = (block, i, origin, len = 1) => {
  const st = STATE.get(block);
  const length = st.root.v;
  if (!Number.isInteger(i) || i < 0 || i > length) return null;
  if (i === 0) return st.roots.length === 0 ? { at: HEAD } : { at: `<${elemAtSlot(st, 0)}` };
  const found = R.spanAt(st.root, true, i - 1);
  const { span } = found;
  const k = i - 1 - found.v;
  const s = found.s;
  const r = runById(st, span.run);
  const off = span.off + k;
  if (childrenAt(r.R, off) === undefined && off + 1 >= r.len) {
    if (r.id.origin === origin && r.elem === null && r.len + len <= MAX_RUN) return { run: r.id.key, from: r.len };
    return { at: `>${elemKey(r.id.key, off)}` };
  }
  return { at: `<${elemAtSlot(st, s + k + 1)}` };
};

// The visible elements [i, i + count) as cut ranges, grouped by run. Null when not within the field.
const rangesOf = (block, i, count) => {
  const st = STATE.get(block);
  const length = st.root.v;
  if (!Number.isInteger(i) || !Number.isInteger(count) || i < 0 || count < 0 || i + count > length) return null;
  const out = [];
  if (count === 0) return out;
  const cursor = R.locate(st.root, true, i);
  let span = cursor.span;
  let k = i - cursor.v;
  let left = count;
  while (left > 0) {
    if (span.vis) {
      const n = Math.min(left, span.len - k);
      const off = span.off + k;
      const last = out.length > 0 ? out[out.length - 1] : null;
      if (last !== null && last[0] === span.run.key && last[1] + last[2] === off) last[2] += n;
      else out.push([span.run.key, off, n]);
      left -= n;
    }
    span = R.next(cursor);
    k = 0;
  }
  return out;
};

// A place in the field that survives edits around it. Null out of range.
const cursorAt = (block, i, side) => {
  const st = STATE.get(block);
  const length = st.root.v;
  if (!Number.isInteger(i) || i < 0 || i > length) return null;
  const slot = (k) => {
    const found = R.spanAt(st.root, true, k);
    return elemKey(found.span.run.key, found.span.off + (k - found.v));
  };
  if (side === 'after') return i === 0 ? HEAD : `>${slot(i - 1)}`;
  return i === length ? END : `<${slot(i)}`;
};

// Where a slot of a placed run sits: the slots and visible slots before it, and whether it shows.
class Position {
  constructor(s, v, vis) {
    this.s = s;
    this.v = v;
    this.vis = vis;
  }
}
const positionOfSlot = (st, run, off) => {
  const seg = segOf(st, run, off);
  const at = R.positionOf(st, seg);
  const k = off - seg.off;
  return new Position(at.s + k, at.v + (seg.vis ? k : 0), seg.vis);
};

/**
 * The visible slots of `[off, off + len)` of run `run`, as the reading shows them: `{ index, count }`,
 * or null when the run is not placed here.
 */
const spanOf = (block, run, off, len) => {
  const st = STATE.get(block);
  const r = runOf(st, run);
  if (r === undefined || !r.placed || !Number.isInteger(off) || off < 0 || off >= r.len || !(len > 0)) return null;
  const last = Math.min(off + len, r.len) - 1;
  const a = positionOfSlot(st, r, off);
  const b = last === off ? a : positionOfSlot(st, r, last);
  return { index: a.v, count: b.v + (b.vis ? 1 : 0) - a.v };
};

/**
 * The visible slots of `[off, off + len)` of run `run` as the reading shows them, one `{ index, count }`
 * per stretch, merged where two meet; ascending; null when the run is not placed here.
 */
const spansOf = (block, run, off, len) => {
  const st = STATE.get(block);
  const r = runOf(st, run);
  if (r === undefined || !r.placed || !Number.isInteger(off) || off < 0 || off >= r.len || !(len > 0)) return null;
  const end = Math.min(off + len, r.len);
  const out = [];
  const { id } = r;
  const first = segOf(st, r, off);
  const cursor = I.seek(st.ids, keyOf(id.n, first.off));
  for (let seg = cursor.value; seg instanceof Span && seg.run === id; I.next(cursor), seg = cursor.value) {
    if (seg.off >= end) return out;
    const lo = Math.max(off, seg.off);
    const hi = Math.min(end, seg.off + seg.len);
    if (!seg.vis || hi <= lo) continue;
    const index = R.positionOf(st, seg).v + (lo - seg.off);
    const prev = out.length > 0 ? out[out.length - 1] : null;
    if (prev !== null && prev.index + prev.count === index) prev.count += hi - lo;
    else out.push({ index, count: hi - lo });
  }
  return out;
};

// Where a cursor is now. Null once the slot is gone — its run not here, or dropped by a reset.
const indexOfCursor = (block, token) => {
  if (token === HEAD) return 0;
  if (token === END) return lengthOf(block);
  const anchor = parseAnchor(token);
  if (anchor === null) return null;
  const st = STATE.get(block);
  const run = runOf(st, anchor.elem.run);
  if (run === undefined || !run.placed || anchor.elem.offset >= run.len) return null;
  const at = positionOfSlot(st, run, anchor.elem.offset);
  return at.v + (anchor.side === 'R' && at.vis ? 1 : 0);
};

// Where an anchor falls in the walk: the ordinal before the element for `<e`, after it for `>e`; the
// head for `^`, an anchor below the base, or an element dropped by it; the end for `$`; null while the
// element has not arrived.
const anchorOrdinal = (block, token, base = null) => {
  if (token === HEAD) return 0;
  if (token === END) return STATE.get(block).root.s;
  const { side, elem } = parseAnchor(token);
  if (belowBase(elem.ts, elem.origin, base)) return 0;
  const st = STATE.get(block);
  const run = runOf(st, elem.run);
  if (run === undefined || !run.placed || elem.offset >= run.len) return null;
  return positionOfSlot(st, run, elem.offset).s + (side === 'L' ? 0 : 1);
};

// What waits in a block: runs out of the walk, cuts and extensions of runs not here, registers of
// elements no run holds, marks switched off before they arrived.
const pendingCount = (block) => {
  const st = STATE.get(block);
  return waiting(st, block.cuts, block.ext);
};
const waiting = (st, cuts, ext) => {
  let n = st.pendingRuns;
  const cutKeys = keysOf(cuts);
  for (let i = 0; i < cutKeys.length; i++) n += cuts[cutKeys[i]].length;
  const extKeys = keysOf(ext);
  for (let i = 0; i < extKeys.length; i++) n += ext[extKeys[i]].length;
  const pos = C.pairs(st.pos);
  for (let i = 0; i < pos.length; i++) if (!holdsElem(st, pos[i].key)) n++;
  const vals = C.pairs(st.vals);
  for (let i = 0; i < vals.length; i++) if (!holdsElem(st, vals[i].key)) n++;
  const marks = C.pairs(st.marks);
  for (let i = 0; i < marks.length; i++) if (isPlaceholder(marks[i].value)) n++;
  return n;
};

// The index a run's arrival (placed, or grown) leaves: none when an anchor waited for it.
const arrived = (d, id) => {
  if (d.marksIndex !== null && d.marksIndex.waits.has(id.key)) d.marksIndex = null;
};

/**
 * The block of a sequence field as the engine reads it — the block itself, or, when the record holds
 * plain JSON, its hydration under the field's floor, made once per plain block.
 */
const indexOf = (entry, field) => {
  const seq = own(entry.meta.blocks ?? {}, field);
  if (seq === undefined) return null;
  if (STATE.has(seq)) return seq;
  return asBlock(seq, floorOf(entry.meta, field));
};

/** What the engine counted, and the rope: `rehints` (hints set again for a head), `walks`. */
const stats = () => {
  const rope = R.stats();
  return { ...counters, rehints: rope.rehints, walks: rope.walks };
};

/** The spans of placed run `run` of a block, in offset order — `[off, len, alive]`; null unplaced. */
const segmentsIn = (block, run) => {
  const st = STATE.get(block);
  const r = runOf(st, run);
  if (r === undefined || !r.placed) return null;
  const out = [];
  const { id } = r;
  const cursor = I.seek(st.ids, keyOf(id.n, 0));
  for (let seg = cursor.value; seg instanceof Span && seg.run === id; I.next(cursor), seg = cursor.value) {
    out.push([seg.off, seg.len, seg.body !== null]);
  }
  return out;
};

module.exports = {
  Span,
  RunId,
  Run,
  Child,
  STATE,
  counters,
  SPAN,
  keyOf,
  intern,
  copyRun,
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
  Walk,
  walkSubtree,
  hydrate,
  stampOfKey,
  asBlock,
  sameBase,
  buildIndex,
  draft,
  finish,
  rootsOf,
  setRun,
  writableRun,
  setSpans,
  runById,
  runOf,
  segOf,
  lastSegOf,
  holdsElem,
  EMBED,
  lengthOf,
  totalOf,
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
