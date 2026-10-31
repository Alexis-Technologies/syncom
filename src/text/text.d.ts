// The list and text kinds as a plugin: `open({ plugins: [text] })` adds
// splice(), push(), updateText(), mark(), unmark(), unmarkById(), spans(),
// cursor(), index(), setAt(), move(), insertEmbed(), splitBlock(),
// joinBlock(), updateBlock(), block(), blocks() and openText() to the storage (TextMethods,
// TextHandleMethods). The
// op, block and payload types live in the root's index.d.ts and are
// re-exported here for convenience.

import type {
  Plugin,
  TextMethods,
  TextHandleMethods,
  TextHandle,
  TextHandleOptions,
  TextHandleEvent,
  SequenceBlock,
  SplicePayload,
  AssignPayload,
  MovePayload,
  MarkPayload,
  MarkExpand,
  TextSpan,
  TextMarks,
  BlockMarker,
  TextBlock,
  TextEmbeds,
  CursorSide,
  CursorPosition,
  DeltaOp,
} from '../../index.js';

export type {
  Plugin,
  TextMethods,
  TextHandleMethods,
  TextHandle,
  TextHandleOptions,
  TextHandleEvent,
  SequenceBlock,
  SplicePayload,
  AssignPayload,
  MovePayload,
  MarkPayload,
  MarkExpand,
  TextSpan,
  TextMarks,
  BlockMarker,
  TextBlock,
  TextEmbeds,
  CursorSide,
  CursorPosition,
  DeltaOp,
};

/** The list and text kinds — Fugue runs, marks, cursors — registered per storage. */
export declare const text: Plugin<TextMethods & TextHandleMethods>;
