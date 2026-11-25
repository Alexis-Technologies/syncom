---
title: Editors
description: Bind ProseMirror, CodeMirror, Quill or your own editor to a text field, so several people edit one document with carets, selections and undo.
---

# Editors

An editor holds its own document and a syncom [text field](./text) holds another. `@alexify/syncom/editor`
keeps the two the same: what the user types is made on the field at once and logged a moment later, and
every other writer's change, a peer's or your own code's, reaches the editor as a delta it applies. Nothing
is lost and nothing lands twice. The ProseMirror and CodeMirror adapters are built on that binding, and any
editor that reports its edits as deltas can use it directly.

The adapters take the editor's own modules as arguments, so `@alexify/syncom` bundles none of them:
install `prosemirror-*` or `@codemirror/*` next to it as you would anyway.

## Bind any editor

`createTextBinding(db, id, field, adapter)` asks three functions of the editor: replace its document,
apply a delta without reporting it back, and report its own edits as deltas.

<<< @/examples/editors.mjs#binding

A delta is in Quill's form, `[{ retain }, { insert, attributes }, { delete }]`, over the document as it was.
Marks travel as attributes, and an embed or a block marker as `{ insert: { embed: marker } }`. For Quill
itself the adapter is a few lines of glue:

<<< @/examples/editors-browser.mjs#quill

The binding opens a [text handle](./text#edit-from-a-keystroke-handler) on the field and loads the editor
from it. An edit the editor reports is applied to the handle at once, so it is never refused as stale and
never rebased, and the handle logs a window of edits (the database's `defer`, 16 ms by default) as one
transaction. `flush()` resolves once everything typed so far is logged; `stop()` logs what is left and
stops.

A change no delta can describe, the record written whole, the field removed, the record deleted, reloads
the editor from the field, and `onReset` tells you. So does a flush that cannot be logged because a hook or
a validator refused it: what was not logged is dropped. An editor that throws on a change is reloaded the
same way, and after five failures in a row the binding stops (`onError` hears each one, `onStop` the last).

## Bind ProseMirror

<<< @/examples/editors.mjs#prosemirror

In the browser the target is a real `EditorView` with the binding's plugin in its state:

<<< @/examples/editors-browser.mjs#prosemirror

The whole ProseMirror document is one text field with [block markers](./text#add-embeds-and-blocks): every
block-level node (a paragraph, a heading, a list, a list item, a quote, a rule) is a marker holding its
attributes and the containers it sits in, a textblock's text follows its marker with its marks, and an
inline node is an embed. Lists and quotes read back as they were. `db.blocks()` and `db.spans()` read the
same document from any node, with or without an editor.

Leave ProseMirror's history plugin out. `pm.commands(undo)` gives you undo and redo commands over an
[undo stack](./undo) that tracks the binding's `source`, so an undo takes back this editor's edits and leaves
a peer's alone. `pm.cursorPlugin(presence)` shows the carets and selections of a
[presence](./presence) room as decorations (a `span.syncom-caret` with `data-node`, and `.syncom-selection`)
and publishes this editor's selection.

Opening an editor writes nothing. When the field holds something the schema cannot (a mark or a node type it
lacks), or lacks something the schema needs (the paragraph an empty document must have), the editor shows
the schema's version and the difference goes out with the user's next edit, never as an answer to a peer.
Without an `onUnfit` option that is logged once as `editor.unfit`. Bind one field to one schema.

## Bind CodeMirror

<<< @/examples/editors.mjs#codemirror

<<< @/examples/editors-browser.mjs#codemirror

A CodeMirror document is the field's text as it is. A transaction's changes leave as exact splices, and a
peer's delta arrives as changes annotated so they are not sent back and stay out of the editor's history.
Marks are not CodeMirror's and are left alone; an embed reads as U+FFFC. CodeMirror reads `\r\n` and `\r`
as line breaks, so a field holding them comes to hold `\n` with the editor's next edit. As for ProseMirror,
leave CodeMirror's history out and use `cm.commands(undo)`, whose `keys` go into `keymap.of()`, and
`cm.cursors(presence)` for the room's carets.

## Two editors, two nodes

Each binding sees the other's edits as deltas, whatever the order they arrive in:

<<< @/examples/editors.mjs#converge

Concurrent inserts at one spot each land whole, in the order the [text](./text#two-people-typing-at-once)
merge gives them, so every editor ends with the same document.

## Keep a selection across edits

A selection stored as indices is wrong after the next edit around it. Stored as cursor tokens it survives:

<<< @/examples/editors.mjs#selection

`selectionToTokens()` turns `{ anchor, head }` into tokens and `tokensToSelection()` reads them back as
indices now, or `null` once a place is gone. `transformIndex(index, delta)` moves an index through a delta
synchronously, for an editor that does not move its own selection when you apply a change.

## Show other people's carets

Tokens are what a [presence](./presence) state carries. On the node that renders them,
`presenceCursors()` resolves a room's cursors on one field to indices:

<<< @/examples/editors.mjs#presence

The ProseMirror and CodeMirror adapters do this for you with `cursorPlugin()` and `cursors()`. For another
editor, publish `selectionToTokens()` on every selection change and draw what `presenceCursors()` returns.

## Edit a whole document of blocks

An editor that hands over its whole document rather than deltas can still send minimal edits. Read the
field as blocks, change them, and let `diffBlocks()` find the delta:

<<< @/examples/editors.mjs#blocks

`diffBlocks()` (and `diffSpans()` over spans) returns cuts and inserts, changed markers and changed marks as
one delta, and `applyDelta()` applies it as one transaction. With `expect`, the text you read, it is
refused with `ALX_ERR_STALE` instead of landing in the wrong place when the field changed meanwhile.
`spansToDelta()`, `deltaToSpans()`, `spansToBlocks()` and `blocksToSpans()` convert between the forms, and
`compose()`, `transform()` and `applyToText()` are the delta algebra the binding is built from, written here
so the subpath needs no dependency.

To write an adapter for another editor, the three helpers the ProseMirror and CodeMirror adapters share are
exported: `createFit()` holds what an editor's document differs from the field by, `undoSteps()` turns an
undo stack into commands, and `failureReporter()` routes an adapter's own failures. The
[reference](../reference/api#editor-subpath) lists their signatures.

## Limits

- The binding is for a text field. A list is read and written through the [list methods](./lists).
- A ProseMirror document is rebuilt from the field on every peer's edit, which costs time linear in the
  document's size. Typing in one textblock is sent from the editor's steps directly; a split, a join, a mark
  or a changed node is a diff of the two documents, linear again.
- A reset, and a flush that could not be logged, drop what was not logged yet.
- A delta of many pieces is many ops in one transaction; keystrokes typed one after another are one op.
- A stacking mark (`many: true`) is not a delta's; the binding leaves such marks as they are.
- The binding touches one field. The record's other fields and its deletion are the database's as ever.
