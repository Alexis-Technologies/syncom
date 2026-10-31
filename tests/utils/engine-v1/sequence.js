'use strict';

// A frozen copy of the v1 engine: the oracle of tests/sequence.differential.test.js — do not fix.
// Copied from src/text/ at 5ebfb35 as it was; only the requires of modules outside src/text/ point back at
// src/. Removed with the differential test at the end of E2.

// The sequence engine behind the `list` and `text` field kinds: where an
// element goes, what a field reads as, and how two nodes' pictures of one
// field join. The block Storage keeps in a record's meta (`meta.blocks[field]`)
// reads as plain JSON — `{ k, ts, runs, cuts, ext, pos, vals, marks }` — and
// serializes as such, but is a ROPE underneath: the walk of the Fugue tree
// kept as a persistent B+-tree of segments (./btree.js), the run records, the
// registers and the marks in persistent maps (./pmap.js), so a keystroke, a
// cut, an assign, a move, a mark, a cursor and a reading are O(log n) and
// never walk the field or copy a map again. No requires beyond ../vector.js,
// ../plugin.js, ./rle.js and those three.
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
// kept for that version; its key order is the walk's. A body grows by
// SEG_MAX slots at most: a run typed long is what was typed, sealed flat,
// and the end being typed (`sealText`), a list's run segments of SEG_MAX;
// the JSON joins them, one RLE a run. The registers and the marks (`pos`, `vals`, `marks`) are the
// engine's maps too, the plain objects the block shows made from them when
// read; the marks in force are also indexed in walk order (the index of the
// marks, below), so the style at a character is read from O(log m) of
// their anchors. A list's reading is derived from the one before and what
// the op changed (`derive`); a block read from a file is hydrated once per
// plain block (`HYDRATED`).
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
// src/text/kind.js reads it; the splice's marker is a register like an
// assign's, so the newer of the two wins whichever arrives first). A `move`
// cuts the slot the element showed at and adds a one-element POSITION run
// (`[at, [[value]], elem]`) that names the element; the register then points
// at that run. A position run holds its element alone: nothing extends it
// (an extension of one is malformed, a longer one in a peer's block is left
// out), or every slot it took would show as that element. A slot shows
// iff it is alive and it is the position its element's register names (its
// own slot, when no move has named one), so two concurrent moves leave the
// element once, at the newer one's place, and a move concurrent with a cut
// of the old slot brings the element back at the new one. An `assign` sets
// the value register; a cut element keeps neither.
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
//
// The engine is split by what it does, this file its design and its public
// names: ./keys.js the names (keys, anchors, refusals), ./state.js the block
// and every reading of it, ./splice.js what an op does (and the registers),
// ./marks.js the marks and their index, ./join.js a block as a snapshot
// carries it (normalized, pruned, joined).

const { PENDING_MAX } = require('../../../src/plugin.js');
const { MAX_RUN, rleLength, rleAppend, rleCut, rleMerge, normalizeRle } = require('./rle.js');
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
} = require('./keys.js');
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
