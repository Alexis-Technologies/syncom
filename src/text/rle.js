'use strict';

// Run-length content — the form a sequence run's content takes in a block
// (src/sequence.js): `["ab", 3, "c"]` alternates present items (a string of
// a text, an array of a list) with gaps, tombstones collapsed to a length
// (Yjs's deleted content; list-positions' form — THIRD_PARTY_NOTICES.md). A
// gap keeps the place, so an anchor, a mark or a cursor into a deleted
// element still resolves. Pure functions over plain JSON, no requires; the
// engine is the one caller, and sequence.js re-exports what its tests read.

// A run holds at most MAX_RUN slots, tombstones included: the index
// allocates per slot, so a gap is the one thing a peer could make expensive
// for nothing (a `[3e8]` in a snapshot block would be expanded element by
// element) — `normalizeRle` refuses a longer run, `applySplice` refuses the
// op that would make one, and a node typing past it starts a new run
// (`placeInsert`). The cap on a whole field is sequence.js's MAX_FIELD.
const MAX_RUN = 1 << 20;

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
      else {
        const held = out[last];
        for (let i = 0; i < seg.length; i++) held.push(seg[i]);
      }
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

// Segment by segment: gaps by length, texts by value, list items by their JSON.
const sameSeg = (a, b) =>
  typeof a === 'number' || typeof a === 'string'
    ? a === b
    : Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b);
const sameRle = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameSeg(a[i], b[i])) return false;
  return true;
};

// The part of a piece from slot `from` on.
const restOf = (seg, from) => (typeof seg === 'number' ? seg - from : seg.slice(from));

// Two pictures of one run: the longer one's length, an element alive only
// where both have it alive (a cut seen anywhere happened). Both are walked
// piece by piece, never slot by slot: a gap of a million slots is one step.
const rleMerge = (kind, a, b) => {
  const out = builder(kind);
  let i = 0;
  let j = 0;
  // The slots of a[i] and b[j] already taken.
  let x = 0;
  let y = 0;
  for (;;) {
    while (i < a.length && x >= segLength(a[i])) {
      i++;
      x = 0;
    }
    while (j < b.length && y >= segLength(b[j])) {
      j++;
      y = 0;
    }
    if (i >= a.length) {
      if (j >= b.length) break;
      out.push(restOf(b[j], y));
      y = segLength(b[j]);
      continue;
    }
    if (j >= b.length) {
      out.push(restOf(a[i], x));
      x = segLength(a[i]);
      continue;
    }
    const segA = a[i];
    const segB = b[j];
    const n = Math.min(segLength(segA) - x, segLength(segB) - y);
    out.push(typeof segA === 'number' || typeof segB === 'number' ? n : segA.slice(x, x + n));
    x += n;
    y += n;
  }
  return out.done();
};

// Whether a run's content is well-formed for its kind and within MAX_RUN;
// returns the canonical form, or null.
const normalizeRle = (kind, rle) => {
  if (!Array.isArray(rle)) return null;
  const b = builder(kind);
  let n = 0;
  for (const seg of rle) {
    if (isGap(seg)) b.push(seg);
    else if (present(kind, seg) && seg.length > 0) b.push(seg);
    else return null;
    n += segLength(seg);
    if (n > MAX_RUN) return null;
  }
  return b.done();
};

module.exports = {
  MAX_RUN,
  GAP,
  isText,
  present,
  isGap,
  segLength,
  rleLength,
  rleExpand,
  rleAppend,
  rleCut,
  sameRle,
  rleMerge,
  normalizeRle,
};
