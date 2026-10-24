'use strict';

// The sequence engine behind the `list` and `text` field kinds: where an
// element goes, what a field reads as, and how two nodes' pictures of one
// field join. Pure functions over the plain JSON block Storage keeps in a
// record's meta (`meta.seqs[field]`); no requires beyond ./vector.js, so it
// ships to the browser as it is.
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

const PENDING_MAX = 4096;

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

// ---- run-length content -------------------------------------------------

const isText = (kind) => kind === 't';
const present = (kind, seg) => (isText(kind) ? typeof seg === 'string' : Array.isArray(seg));
const isGap = (seg) => Number.isInteger(seg) && seg > 0;
const segLength = (seg) => (typeof seg === 'number' ? seg : seg.length);

// Builds a canonical RLE: adjacent gaps add up, adjacent present items join.
const builder = (kind) => {
  const out = [];
  return {
    push(seg) {
      if (segLength(seg) === 0) return;
      const last = out.length - 1;
      if (last < 0) out.push(typeof seg === 'number' ? seg : isText(kind) ? seg : [...seg]);
      else if (typeof seg === 'number') typeof out[last] === 'number' ? (out[last] += seg) : out.push(seg);
      else if (typeof out[last] === 'number') out.push(isText(kind) ? seg : [...seg]);
      else if (isText(kind)) out[last] += seg;
      else out[last].push(...seg);
    },
    done: () => out,
  };
};

const rleLength = (rle) => {
  let n = 0;
  for (const seg of rle) n += segLength(seg);
  return n;
};

// Expands to one entry per element: the value, or GAP for a tombstone.
const GAP = Symbol('gap');
const rleExpand = (rle) => {
  const out = [];
  for (const seg of rle) {
    if (typeof seg === 'number') for (let i = 0; i < seg; i++) out.push(GAP);
    else for (let i = 0; i < seg.length; i++) out.push(seg[i]);
  }
  return out;
};
const rleCollapse = (kind, items) => {
  const b = builder(kind);
  for (const item of items) b.push(item === GAP ? 1 : isText(kind) ? item : [item]);
  return b.done();
};

const rleAppend = (kind, rle, content) => {
  const b = builder(kind);
  for (const seg of rle) b.push(seg);
  b.push(content);
  return b.done();
};

// Marks [offset, offset + length) as gone; what lies past the end is not here.
const rleCut = (kind, rle, offset, length) => {
  const b = builder(kind);
  let at = 0;
  const end = offset + length;
  for (const seg of rle) {
    const n = segLength(seg);
    if (typeof seg === 'number' || end <= at || offset >= at + n) b.push(seg);
    else {
      const from = Math.max(offset, at) - at;
      const to = Math.min(end, at + n) - at;
      if (from > 0) b.push(seg.slice(0, from));
      b.push(to - from);
      if (to < n) b.push(seg.slice(to));
    }
    at += n;
  }
  return b.done();
};

// Two pictures of one run: the longer one's length, an element alive only
// where both have it alive (a cut seen anywhere happened).
const rleMerge = (kind, a, b) => {
  const x = rleExpand(a);
  const y = rleExpand(b);
  const n = Math.max(x.length, y.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    if (i >= x.length) out[i] = y[i];
    else if (i >= y.length) out[i] = x[i];
    else out[i] = x[i] === GAP || y[i] === GAP ? GAP : x[i];
  }
  return rleCollapse(kind, out);
};

// Whether a run's content is well-formed for its kind; returns the
// canonical form, or null.
const normalizeRle = (kind, rle) => {
  if (!Array.isArray(rle)) return null;
  const b = builder(kind);
  for (const seg of rle) {
    if (isGap(seg)) b.push(seg);
    else if (present(kind, seg) && seg.length > 0) b.push(seg);
    else return null;
  }
  return b.done();
};

// ---- the block -----------------------------------------------------------

const createSeq = (kind) => ({ k: kind, ts: 0, runs: {} });
const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
const keysOf = (object) => (object && typeof object === 'object' ? Object.keys(object) : []);

const isStamp = (value) => Number.isSafeInteger(value) && value > 0;
const isJson = (value) => value === null || ['string', 'number', 'boolean', 'object'].includes(typeof value);

// A peer's block, rebuilt into the trusted shape: every key of a known
// form, every run a canonical RLE of the block's kind, every anchor and
// register well-formed. Anything else is dropped; a block with nothing left
// is null.
const normalizeSeq = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.k === 't' || raw.k === 'l' ? raw.k : null;
  if (kind === null || !Number.isSafeInteger(raw.ts) || raw.ts < 0) return null;
  const seq = createSeq(kind);
  seq.ts = raw.ts;
  for (const key of keysOf(raw.runs)) {
    const run = raw.runs[key];
    if (!isRunKey(key) || !Array.isArray(run) || run.length < 2 || run.length > 3) continue;
    const anchor = parseAnchor(run[0]);
    if (anchor === null || run[0] === END) continue;
    const content = normalizeRle(kind, run[1]);
    if (content === null) continue;
    if (run.length === 3 && (kind !== 'l' || !isElemKey(run[2]))) continue;
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
      if (
        isElemKey(key) &&
        Array.isArray(v) &&
        v.length === 3 &&
        isStamp(v[0]) &&
        isOrigin(String(v[1])) &&
        check(v[2])
      ) {
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
      if (!isRunKey(key) || !Array.isArray(m) || m.length !== 5) continue;
      if (!isAnchor(m[0]) || !isAnchor(m[1]) || typeof m[2] !== 'string' || !isJson(m[3])) continue;
      if (!Number.isInteger(m[4]) || m[4] < 0 || m[4] > 3) continue;
      marks[key] = [m[0], m[1], m[2], m[3], m[4]];
    }
    if (Object.keys(marks).length > 0) seq.marks = marks;
  }
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

const pendingCount = (seq, index) => {
  let n = index.pending.size;
  for (const key of keysOf(seq.cuts)) n += seq.cuts[key].length;
  for (const key of keysOf(seq.ext)) n += seq.ext[key].length;
  return n;
};

// ---- the tree and its walk ----------------------------------------------

const byOrigin = (a, b) => (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : a.ts - b.ts);
const CONT = Symbol('continuation');

// Reads the block into an index: the runs with their children by element,
// the walk in order (every element, tombstones too) and the visible
// elements, with each element's walk ordinal and visible position.
const buildIndex = (seq, base = null) => {
  const keys = Object.keys(seq.runs);
  const runs = [];
  const byKey = new Map();
  for (const key of keys) {
    const parsed = parseRun(key);
    const [at, content, elem] = seq.runs[key];
    const len = rleLength(content);
    const items = rleExpand(content);
    const r = {
      key,
      ts: parsed.ts,
      origin: parsed.origin,
      at,
      content,
      items,
      len,
      elem: elem ?? null,
      L: null,
      R: null,
    };
    runs.push(r);
    byKey.set(key, r);
  }
  const root = [];
  const pending = new Set();
  for (const r of runs) {
    const anchor = parseAnchor(r.at);
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
  // The walk.
  const total = runs.reduce((n, r) => n + r.len, 0);
  const ordRun = new Int32Array(total);
  const ordOff = new Int32Array(total);
  const visRun = new Int32Array(total);
  const visOff = new Int32Array(total);
  for (const r of runs) {
    r.ordAt = new Int32Array(r.len).fill(-1);
    r.visAt = new Int32Array(r.len).fill(-1);
  }
  const runIndex = new Map(runs.map((r, i) => [r.key, i]));
  let n = 0;
  let v = 0;
  const emit = (r, off) => {
    const i = runIndex.get(r.key);
    ordRun[n] = i;
    ordOff[n] = off;
    r.ordAt[off] = n;
    r.visAt[off] = v;
    n++;
    if (r.items[off] !== GAP) {
      visRun[v] = i;
      visOff[v] = off;
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
    length: v,
    total: n,
  };
};

// What the field reads as: the visible elements in order.
const render = (index) => {
  const { runs, visRun, visOff, length } = index;
  if (index.kind === 't') {
    let out = '';
    for (let i = 0; i < length; i++) out += runs[visRun[i]].items[visOff[i]];
    return out;
  }
  const out = new Array(length);
  for (let i = 0; i < length; i++) out[i] = runs[visRun[i]].items[visOff[i]];
  return out;
};

const elemAt = (index, i) =>
  i >= 0 && i < index.length ? elemKey(index.runs[index.visRun[i]].key, index.visOff[i]) : null;

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
    if (r.origin === origin) return { run: r.key, from: r.len };
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

const addRange = (seq, key, offset, length) => {
  const list = (seq.cuts ??= {})[key] ? [...seq.cuts[key]] : [];
  list.push([offset, length]);
  seq.cuts[key] = list;
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
  const hasContent = content !== undefined;
  if (hasContent && !(present(seq.k, content) && content.length > 0)) {
    return { seq, changed: false, reason: 'malformed' };
  }
  if (cut !== undefined && !Array.isArray(cut)) return { seq, changed: false, reason: 'malformed' };
  if (!hasContent && (cut === undefined || cut.length === 0)) return { seq, changed: false, reason: 'malformed' };
  if (hasContent && (at === undefined) === (run === undefined)) return { seq, changed: false, reason: 'malformed' };
  if (at !== undefined) {
    const anchor = parseAnchor(at);
    if (anchor === null || at === END || (anchor.elem !== null && anchor.elem.ts >= ts)) {
      return { seq, changed: false, reason: 'malformed' };
    }
  }
  if (run !== undefined && (!isRunKey(run) || !Number.isInteger(from) || from < 0)) {
    return { seq, changed: false, reason: 'malformed' };
  }
  let next = null;
  const mutable = () => (next ??= cloneSeq(seq));
  let changed = false;
  let index = null;
  const indexOf = () => (index ??= buildIndex(next ?? seq, base));
  const pendingLeft = () => pendingMax - pendingCount(next ?? seq, indexOf());
  if (cut !== undefined) {
    for (const range of cut) {
      const shape = Array.isArray(range) && range.length === 3 && isRunKey(range[0]);
      if (!shape) return { seq, changed: false, reason: 'malformed' };
      const [, offset, length] = range;
      if (!Number.isInteger(offset) || offset < 0 || !isGap(length)) {
        return { seq, changed: false, reason: 'malformed' };
      }
    }
    for (const [key, offset, length] of cut) {
      const target = own(seq.runs, key);
      if (target === undefined || offset >= rleLength(target[1])) {
        if (pendingLeft() <= 0) return { seq, changed: false, reason: 'bound' };
        addRange(mutable(), key, offset, length);
        changed = true;
        continue;
      }
      const m = mutable();
      const before = m.runs[key];
      const len = rleLength(before[1]);
      const inside = Math.min(length, len - offset);
      const after = rleCut(m.k, before[1], offset, inside);
      if (after.length !== before[1].length || after.some((seg, i) => seg !== before[1][i])) {
        m.runs[key] = before.length === 3 ? [before[0], after, before[2]] : [before[0], after];
        changed = true;
      }
      if (offset + length > len) {
        if (pendingLeft() <= 0) return { seq, changed: false, reason: 'bound' };
        addRange(m, key, len, offset + length - len);
        changed = true;
      }
    }
  }
  if (hasContent) {
    if (at !== undefined) {
      const key = runKey(ts, origin);
      if (own((next ?? seq).runs, key) === undefined) {
        const anchor = parseAnchor(at);
        const parent = anchor.elem === null ? null : own((next ?? seq).runs, anchor.elem.run);
        const resolved =
          anchor.elem === null ||
          (base !== null && compareClock([anchor.elem.ts, anchor.elem.origin], base) < 0) ||
          (parent !== undefined && anchor.elem.offset < rleLength(parent[1]));
        if (!resolved && pendingLeft() <= 0) return { seq, changed: false, reason: 'bound' };
        const m = mutable();
        m.runs[key] = [at, isText(m.k) ? [content] : [[...content]]];
        settle(m, key);
        changed = true;
      }
    } else {
      const target = own((next ?? seq).runs, run);
      if (target !== undefined) {
        const len = rleLength(target[1]);
        if (from === len) {
          const m = mutable();
          m.runs[run] =
            target.length === 3
              ? [target[0], rleAppend(m.k, target[1], content), target[2]]
              : [target[0], rleAppend(m.k, target[1], content)];
          settle(m, run);
          changed = true;
        } else if (from > len) {
          if (pendingLeft() <= 0) return { seq, changed: false, reason: 'bound' };
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
  next.ts = Math.max(next.ts, ts);
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
  for (const key of Object.keys(seq.runs)) if (below(key, base)) delete mutable().runs[key];
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
  return empty ? null : out;
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
      else if (theirs[4] !== mine[4]) out.marks[key] = [mine[0], mine[1], mine[2], mine[3], mine[4] | theirs[4]];
    }
  }
  for (const key of Object.keys(out.runs)) settle(out, key);
  return out;
};

module.exports = {
  PENDING_MAX,
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
  render,
  elemAt,
  placeInsert,
  rangesOf,
  applySplice,
  prune,
  join,
  pendingCount,
};
