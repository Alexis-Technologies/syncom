'use strict';

// The sequence engine, v2: the same names as src/text/sequence.js, the same blocks — their JSON, their
// readings, their refusals and counts, op for op (tests/sequence.differential.test.js holds the two
// together) — over other structures. The ordering rule (Fugue with runs), the run-length content, the
// pending ops, the movable list, the marks, embeds, resets and joins are v1's: its header says them and
// is not repeated here. What differs is how a block is kept:
//
// - NAMES ONCE. A run's key (`ts:origin`) is parsed where it enters and interned per lineage (`Doc`, a
//   hydration's, shared by every op and fork after it): a `RunId` with its number, stamp, origin and
//   key. Keys are printed only for what the JSON, a cursor or a register spells.
// - A COPY-ON-WRITE ROPE (./rope.js) of spans and fences with two measures, and the ID INDEX (./ids.js)
//   from (run, offset) to a run's record and its spans; registers, marks and what waits in hash tries
//   (./cow.js) — in place of v1's persistent tree, map and lists. Every node carries the owner that made
//   it. An op reads first what it will do and every bound it meets — a refusal, its count, an op that
//   changes nothing, all known before anything is written (v1 laid cuts and then refused or dropped
//   them: its results are kept, not its writes) — then FREEZES the block it starts from (O(1)) and
//   writes a draft under a new owner: each node it touches copied once, edited in place after, the
//   measures handed up the parents as deltas. A version handed out never changes.
// - HINTS that are checked: a span's leaf and a node's parent — by a handle a node shares with its
//   copies, so a copy moves one pointer — are right for the version written last; a climb checks each
//   step, a head sets them again once when they fail, a frozen version reads its places from one walk of
//   its own and writes none.
// - The block's face is v1's: a plain object — `k`, `ts`, `runs` made when read, `cuts`, `ext`, the
//   registers and the marks made when read — and its state a private field it is stamped with (no
//   property: it reads, serializes and compares as plain JSON; a WeakMap entry per version cost more
//   than the rest of the face). A large block's pieces are the 32 buckets of the run keys' hash, each
//   with a token a write to it replaces.
//
// Nothing requires this module yet: the plugin stands on v1 until the switch (E2b).

const { PENDING_MAX } = require('../../plugin.js');
const { MAX_RUN, rleLength, rleAppend, rleCut, rleMerge, normalizeRle } = require('../rle.js');
const {
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
  isPlaceholder,
  MANY,
  OFF,
} = require('../keys.js');
const {
  indexOf,
  createSeq,
  hydrate,
  asBlock,
  buildIndex,
  EMBED,
  heldAt,
  spanOf,
  spansOf,
  lengthOf,
  totalOf,
  render,
  elems,
  hasElem,
  indexOfElem,
  valueAt,
  valuesAt,
  derive,
  deriveLater,
  elemAt,
  placeInsert,
  rangesOf,
  anchorOrdinal,
  slotAt,
  cursorAt,
  indexOfCursor,
  pendingCount,
  stats,
  SEG_MAX,
  segmentsIn,
  PIECES_MIN,
  piecesOf,
} = require('./state.js');
const { applySplice, applyAssign, applyMove } = require('./splice.js');
const { markOf, applyMark, markAnchors, marksIn, spans, styleAt, newerRanges, REVERSED } = require('./marks.js');
const { normalizeSeq, prune, join } = require('./join.js');

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
  asBlock,
  buildIndex,
  EMBED,
  heldAt,
  spanOf,
  spansOf,
  isPlaceholder,
  lengthOf,
  totalOf,
  render,
  elems,
  hasElem,
  indexOfElem,
  valueAt,
  valuesAt,
  derive,
  deriveLater,
  markOf,
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
  styleAt,
  newerRanges,
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
  SEG_MAX,
  segmentsIn,
  PIECES_MIN,
  piecesOf,
};
