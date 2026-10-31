'use strict';

// A peer's block (or any plain one) of the v2 sequence engine checked into the canonical plain shape
// (./sequence.js holds the design): every key of a known form, every run a canonical RLE of the block's
// kind anchored at an element older than itself, every anchor and register well-formed, the whole within
// the bounds — and the newest stamp a plain block holds. Plain JSON in, plain JSON out: nothing here
// touches a rope. Requires ./keys.js and ./rle.js only.

const { isText, present, isGap, rleLength, normalizeRle, MAX_RUN } = require('./rle.js');
const {
  END,
  MAX_FIELD,
  MAX_MARKS,
  isElemKey,
  isJson,
  isOrigin,
  isRunKey,
  isStamp,
  keysOf,
  parseAnchor,
  parseRun,
} = require('./keys.js');

// The runs: a canonical RLE each, anchored at an element older than the run; a run of no slots is
// nobody's (and has no last span); a position run (a third slot, lists only) holds one element. Counted
// in `count.slots` against MAX_FIELD — false past it.
const normalizeRuns = (raw, kind, seq, count) => {
  const runKeys = keysOf(raw.runs);
  for (let i = 0; i < runKeys.length; i++) {
    const key = runKeys[i];
    const run = raw.runs[key];
    const made = parseRun(key);
    if (made === null || !Array.isArray(run) || run.length < 2 || run.length > 3) continue;
    const anchor = parseAnchor(run[0]);
    if (anchor === null || run[0] === END || (anchor.elem !== null && anchor.elem.ts >= made.ts)) continue;
    const content = normalizeRle(kind, run[1]);
    if (content === null || rleLength(content) === 0) continue;
    if (run.length === 3 && (kind !== 'l' || !isElemKey(run[2]) || rleLength(content) !== 1)) continue;
    count.slots += rleLength(content);
    if (count.slots > MAX_FIELD) return false;
    seq.runs[key] = run.length === 3 ? [run[0], content, run[2]] : [run[0], content];
    count.runs++;
  }
  return true;
};

// The cuts waiting for a run not here: `[offset, length]` each, under a run key.
const normalizeCuts = (raw, seq) => {
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
};

// The extensions parked ahead of their run: `[offset, content]` each, under a run key. One that would
// take its run past MAX_RUN never lands and is left out, as the op would be refused; the kept ones count
// in `count.slots` against MAX_FIELD as landed slots do — false past it.
const normalizeExt = (raw, kind, seq, count) => {
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
      if (content === null || item[0] + content.length > MAX_RUN) continue;
      count.slots += content.length;
      if (count.slots > MAX_FIELD) return false;
      list.push([item[0], content]);
    }
    if (list.length > 0) (seq.ext ??= {})[key] = list;
  }
  return true;
};

// A register map (`pos`, `vals`): `[ts, origin, value]` under an element key, the value as `check` says.
// Null where nothing is left.
const normalizeRegister = (raw, check) => {
  const out = {};
  let n = 0;
  const keys = keysOf(raw);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const v = raw[key];
    if (isElemKey(key) && Array.isArray(v) && v.length === 3 && isStamp(v[0]) && isOrigin(v[1]) && check(v[2])) {
      out[key] = [v[0], v[1], v[2]];
      n++;
    }
  }
  return n > 0 ? out : null;
};

// The marks of a text: `[from, to, key, value, flags]` under the mark's key, its anchors at elements older
// than the mark, its flags within MANY | OFF. More than MAX_MARKS is a block no peer could have built
// through ops — false.
const normalizeMarks = (raw, seq) => {
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
    if (n > MAX_MARKS) return false;
  }
  if (n > 0) seq.marks = marks;
  return true;
};

/**
 * A peer's block (or any plain one), checked into the canonical plain shape. Anything malformed is
 * dropped; a block with nothing left, or past a bound (MAX_FIELD over its runs and parked extensions,
 * MAX_MARKS), is null.
 */
const normalizeJson = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.k === 't' || raw.k === 'l' ? raw.k : null;
  if (kind === null) return null;
  const seq = { k: kind, ts: 0, runs: {} };
  const count = { slots: 0, runs: 0 };
  if (!normalizeRuns(raw, kind, seq, count)) return null;
  normalizeCuts(raw, seq);
  if (!normalizeExt(raw, kind, seq, count)) return null;
  if (kind === 'l') {
    const pos = normalizeRegister(raw.pos, isRunKey);
    if (pos) seq.pos = pos;
  }
  const vals = normalizeRegister(raw.vals, isJson);
  if (vals) seq.vals = vals;
  if (kind === 't' && !normalizeMarks(raw, seq)) return null;
  const empty = count.runs === 0 && !seq.cuts && !seq.ext && !seq.marks && !seq.pos && !seq.vals;
  return empty ? null : seq;
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

module.exports = { normalizeJson, stampsMax };
