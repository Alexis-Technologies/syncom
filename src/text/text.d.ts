// The list and text kinds as a plugin: `open({ plugins: [text] })` adds
// splice(), push(), updateText(), mark(), unmark(), unmarkById(), spans(),
// cursor(), index(), setAt() and move() to the storage (TextMethods). The
// op, block and payload types live in the root's index.d.ts and are
// re-exported here for convenience.

import type {
  Plugin,
  TextMethods,
  SequenceBlock,
  SplicePayload,
  AssignPayload,
  MovePayload,
  MarkPayload,
  MarkExpand,
  TextSpan,
  CursorSide,
} from '../../index.js';

export type {
  Plugin,
  TextMethods,
  SequenceBlock,
  SplicePayload,
  AssignPayload,
  MovePayload,
  MarkPayload,
  MarkExpand,
  TextSpan,
  CursorSide,
};

/** The list and text kinds — Fugue runs, marks, cursors — registered per storage. */
export declare const text: Plugin<TextMethods>;
