'use strict';

// The `list` and `text` kinds as a plugin (@alexify/syncom/text): the Fugue
// sequence engine (./sequence.js, ./rle.js) behind a record's lists and
// texts — what the core calls to apply a splice, an assign, a move or a
// mark, to normalize and join a peer's block, to read the field, to resolve
// a local call's indices into anchors inside the queue, to diff two readings
// into patches and realize them — and the storage methods the plugin adds
// (splice, push, updateText, mark, unmark, unmarkById, spans, cursor, index,
// setAt, move, insertEmbed, splitBlock, joinBlock, updateBlock, block,
// blocks). Registered per instance with `open({ plugins: [text] })`;
// src/plugin.js names the contract.
//
// A text's embeds and blocks (Automerge's model): a slot holding U+FFFC,
// the object replacement character, whose value — a MARKER `{ type,
// parents, attrs, isEmbed }` — is a register of the block (`vals`, as a
// list element's). `isEmbed: false` is a block marker: a paragraph or a
// heading boundary, the text after it up to the next marker its content,
// `parents` the nesting (a list item's `['ordered-list']`). `isEmbed: true`
// is an inline object — an image, a mention — a character wide. The field
// still reads as the plain string, slots and all; `spans()` tells them
// apart, `blocks()` reads the document by block. An editor's whole document
// is one text, one Fugue tree: cursors, marks and presence count the slots
// like any character.
//
// A block is its own index (the rope of ./sequence.js): a reading, a
// position or a place to insert is answered from it in O(log n), and an op
// hands back a new block that shares what it did not touch.
//
// The plugin is this object; its parts are modules of their own: ./kind.js
// what the core calls (the op path, the resolution of an index, the seam of
// a list's members, the embed markers), ./diffs.js the patches (diff,
// realize, migrate, compact, who wrote it), ./methods.js the storage
// methods, ./deltas.js the Quill deltas.

const {
  apply,
  normalize,
  join,
  resolve,
  nest,
  KINDS,
  CODES,
  HINTS,
  takes,
  kindOfOp,
  prune,
  render,
  pieces,
  NESTS,
  LAZY,
  members,
  holds,
  pick,
} = require('./kind.js');
const { diff, realize, recreate, migrate, compact, values, editors } = require('./diffs.js');
const {
  splice,
  move,
  mark,
  block,
  push,
  updateText,
  unmark,
  unmarkById,
  spans,
  revision,
  cursor,
  index,
  setAt,
  insertEmbed,
  splitBlock,
  joinBlock,
  updateBlock,
  blocks,
  position,
  elementName,
  elements,
  positions,
  editorOf,
} = require('./methods.js');
const { toDelta, applyDelta } = require('./deltas.js');

/** The list and text kinds: register with `open({ plugins: [text] })`. */
const text = Object.freeze({
  name: 'text',
  kinds: KINDS,
  codes: CODES,
  types: Object.freeze(['splice', 'assign', 'move', 'mark']),
  actions: Object.freeze(['splice', 'mark', 'setAt']),
  hints: HINTS,
  takes,
  kindOfOp,
  normalize,
  apply,
  join,
  prune,
  render,
  pieces,
  resolve,
  diff,
  recreate,
  realize,
  migrate,
  compact,
  values,
  editors,
  nests: NESTS,
  lazy: LAZY,
  members,
  holds,
  pick,
  nest,
  methods: Object.freeze({
    splice,
    push,
    updateText,
    mark,
    unmark,
    unmarkById,
    spans,
    revision,
    cursor,
    index,
    setAt,
    move,
    elementAt: elementName,
    elements,
    insertEmbed,
    splitBlock,
    joinBlock,
    updateBlock,
    block,
    blocks,
    position,
    positions,
    toDelta,
    applyDelta,
    editorOf,
  }),
});

module.exports = { text };
