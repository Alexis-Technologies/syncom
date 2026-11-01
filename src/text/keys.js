'use strict';

// The names of the sequence engine (src/text/sequence.js holds its design): run
// and element keys, anchors, the checks a peer's block is read through, the
// refusals an op reports and a mark's flags. No state.

const { compareClock } = require('../vector.js');

// Pending work — runs waiting for their anchor, cuts and extensions waiting
// for their run, registers and switched-off marks for elements and marks not
// here — is bounded per field (PENDING_MAX, src/plugin.js), on the op path
// and on the snapshot path alike: beyond it an op is refused (`bound`) and a
// peer's block is dropped.
// A field holds at most MAX_FIELD slots, tombstones included (and a run
// MAX_RUN, src/text/rle.js's): a gap is the one thing a peer could make expensive
// for nothing. A field at MAX_FIELD takes nothing more until a reset.
const MAX_FIELD = 1 << 22;
// One splice cuts at most MAX_CUTS ranges — a range per stretch of a run
// `rangesOf` lays, so a delete across more runs than that is refused (in
// parts, or after `compact()`, it goes). Read before any range is, so a
// peer's cut costs what its length says and never more than this. The
// coalescing of cuts (src/text/kind.js) has a bound of its own on an op's
// growth, much lower; this one is the engine's.
const MAX_CUTS = 1 << 16;
// A text holds at most MAX_MARKS marks, the placeholders of marks switched
// off before they arrived among them (those PENDING_MAX bounds first): one
// more is refused, a peer's block holding more is dropped. A mark switched
// off, or filling its placeholder, adds none.
const MAX_MARKS = 1 << 16;

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
const JSON_TYPES = new Set(['string', 'number', 'boolean', 'object']);
const isJson = (value) => value === null || JSON_TYPES.has(typeof value);
const byOrigin = (a, b) => (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : a.ts - b.ts);
const minStamp = (a, b) => (a === null || compareClock(b, a) < 0 ? b : a);
// The older of a stamp and `[ts, origin]`: the stamp itself while it is not newer.
const olderOf = (a, ts, origin) => (a === null || ts < a[0] || (ts === a[0] && origin < a[1]) ? [ts, origin] : a);

// A refusal for work past a bound: which bound, the count and the limit.
const refused = (seq, detail, count, max) => ({ seq, changed: false, reason: 'bound', detail, count, max });
const malformed = (seq) => ({ seq, changed: false, reason: 'malformed' });
const unchanged = (seq) => ({ seq, changed: false, reason: null });
// A mark's flags (./marks.js): MANY stacks with every other mark of its
// key, OFF is switched off.
const MANY = 1;
const OFF = 2;
// What an `off` leaves for a mark not here yet: no anchors, no key, no value, switched off.
const PLACEHOLDER = [HEAD, HEAD, '', null, OFF];
const isPlaceholder = (m) => m[0] === HEAD && m[1] === HEAD && m[2] === '' && m[3] === null && (m[4] & OFF) !== 0;
// Whether run `key` is stamped below `base` (the reset rule's test).
const below = (key, base) => {
  const parsed = parseRun(key);
  return compareClock([parsed.ts, parsed.origin], base) < 0;
};

module.exports = {
  MAX_FIELD,
  MAX_CUTS,
  MAX_MARKS,
  isOrigin,
  runKey,
  elemKey,
  parseRun,
  parseElem,
  isRunKey,
  isElemKey,
  HEAD,
  END,
  parseAnchor,
  isAnchor,
  own,
  keysOf,
  isStamp,
  isJson,
  byOrigin,
  minStamp,
  olderOf,
  refused,
  malformed,
  unchanged,
  MANY,
  OFF,
  PLACEHOLDER,
  isPlaceholder,
  below,
};
