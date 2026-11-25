---
title: Text and rich text
description: Type into a text field from several nodes at once, style it with marks, add embeds and blocks, and keep carets in place across edits.
---

# Text and rich text

A text field is a string that several nodes type into at the same time. Each node edits by index, every
keystroke merges, and two people typing at the same spot both keep what they typed, each word in one piece.
On top of the characters a text carries marks (bold, a link, a comment), embeds (an image, a mention) and
block markers (a heading, a list item), so one field can hold a rich document.

A record with a text field is still a record: it has a schema, it is queried, indexed and searched like any
other, and its ops travel in the same log. Text comes with the `text` plugin, which `@alexify/syncom/all`
registers. The merge rule is the one [lists](./lists) use, applied to characters.

## Type into a text field

<<< @/examples/text.mjs#type

`splice(id, key, index, count, content)` removes `count` characters at `index` and inserts the string
`content` there, and `push(id, key, content)` appends. The first write that names a field with a string
makes it a text. Indices are UTF-16 code units, the way `String#slice` counts them.

When you have the whole new string rather than the edit, hand it to `updateText()`:

<<< @/examples/text.mjs#update-text

`updateText()` compares the field with the new string inside the write queue, so no peer's op can land
between the comparison and the edit, and writes one splice per place that changed. It resolves to how many
ops it took. It is how you write a text from a plain string: edits made as splices keep what a peer typed
meanwhile, where writing the whole record would drop it.

## Two people typing at once

<LiveText />

The laptop and the phone hold "Ship on Friday." and go offline. The laptop appends a word after "Friday";
the phone replaces "Friday" with "Monday":

<<< @/examples/text.mjs#concurrent

Both edits survive. The phone's cut took only the characters it named, and the laptop's word was anchored
to a character, not to an index, so it lands after where "Friday" was. Two nodes that type at the very same
spot both keep their text, one run after the other in the order of their node ids, never letter by letter.
[Lists](./lists#insert-at-the-same-spot-on-two-nodes) explains the tree that gives this order.

## Edit from a keystroke handler

The methods above each return a promise. An editor that handles keystrokes wants to edit and read back at
once; `openText()` gives it a handle that does:

<<< @/examples/text.mjs#handle

A handle reads the field as the database last announced it, with what was typed through the handle on top,
and every edit applies to that reading synchronously. The edits are logged a window later (the database's
`defer`, 16 ms by default, or the `window` option), as one transaction, and keystrokes typed one after
another become one op. Until then nothing reaches a peer. `flushed` settles once everything typed so far is
logged, and the database's `flush()` and `close()` flush open handles first.

Another writer's changes, a peer's or a write through the database, reach the handle's observers as a delta
in the handle's indices. A flush that cannot be logged, because a hook or a validator refused it, drops what
was not logged: `flushed` rejects with `ALX_ERR_UNLOGGED`, the handle reads the field as announced again, and its
observers hear `reset`. [Editors](./editors) builds a full editor binding on this handle.

## Style text with marks

<<< @/examples/text.mjs#marks

`mark(id, key, start, end, name, value)` styles a range and `spans(id, key)` reads the text back as runs of
equal style, which is what an editor renders. The field itself still reads as the plain string.

Whether text typed at the edge of a range takes its style is the mark's `expand` option: `'after'` (the
default, so bold grows as you type on), `'before'`, `'both'` or `'none'` (a link does not grow). The rule
holds for concurrent typing too, because a mark is anchored to characters: a peer's text typed right after
the bold word is bold on every node or on none. Per name, the newest mark over a character wins, and a mark
with a `null` value takes the style off.

Comments and suggestions need several marks of one name over the same range. Pass `many: true` and each
mark stacks instead of replacing the last; `spans()` lists them as `{ id, value }` and you remove one by
the id `mark()` resolved to:

<<< @/examples/text.mjs#comments

`unmark()` removes a style by name over a range, the way a toolbar button does. Marks are not compared by
`diff()` and are not undone by [undo](./undo); they replicate and merge like everything else.

## Add embeds and blocks

A document is one text. What is not a character, an image, a mention, the start of a paragraph or a
heading, is a slot: one position that reads as U+FFFC, the object replacement character, and holds a
marker `{ type, parents, attrs, isEmbed }`:

<<< @/examples/text.mjs#blocks

`splitBlock()` starts a block: the text after its marker, up to the next marker, is the block's content,
`attrs` holds what the type needs (a heading's level) and `parents` the containers it sits in (a list item's
`['ordered-list']`). `insertEmbed()` inserts an inline embed one character wide, which takes marks like any
character. `block(id, key, index)` reads one marker, `blocks()` the field by block, and `spans()` types every
span as `'text'`, `'embed'` or `'block'`.

A slot merges like a character: a peer's insert next to it lands as next to any character, and cursors and
indices count it. Its marker changes with `updateBlock()`, last writer wins, and `joinBlock()` removes a
block marker, joining its content to the block before. You cannot type U+FFFC into the field with `splice()`
or `updateText()`; a slot only enters with its marker.

## Keep a caret where it belongs

An index is right only until someone types in front of it. A cursor is a place that survives edits:

<<< @/examples/text.mjs#cursor

`cursor(id, key, index)` resolves to a string you can keep, store in the record, or send to a peer in a
[presence](./presence) state. By default it stays before the character at `index`, so text typed at the
cursor pushes it right; `{ side: 'after' }` keeps it after the character before, so typed text lands after
it. `index()` says where it is now and `position()` adds the side; `positions()` reads several at once. A
cursor into a deleted character reads at the next visible one, and one into a field that was reset reads
`null`.

## Follow changes as deltas

To keep a view of the field without reading it again after every change, observe the record and turn the
changes into a delta, then send your own edits back the same way:

<<< @/examples/text.mjs#delta

`observe(id, path, listener)` hands you each turn's changes for one field, a peer's as much as a local
one, in the field's indices. `toDelta()` composes them into a delta in Quill's form (`retain`, `insert`
with attributes, `delete`), or `null` when the change is one a delta cannot say, such as a reset: read the
field again then. `applyDelta()` makes a delta the field's edits as one transaction, so a peer sees them
land together; with `expect`, the text you made the delta over, it rejects with `ALX_ERR_STALE` before any op if the
field changed in between. The [editor binding](./editors) does all of this for you.

## Characters outside the Basic Multilingual Plane

An emoji takes two UTF-16 units, and an index between them would split it:

<<< @/examples/text.mjs#surrogate

`splice()`, `mark()`, `unmark()` and `cursor()` refuse such an index with `ALX_ERR_SURROGATE`. `updateText()` diffs
by code point around such characters, so its edits never split one.

## Costs and limits

- A text lives three times on a node: as the field's string, as runs in the record's metadata, and as ops in
  the log. Keep a text to what a record is for, a note, a description, a document of a few pages; split a
  book across records.
- An edit costs the same whether the text is short or long: the field is held as a balanced tree of runs, so
  an insert, a cut or a peer's run lands in logarithmic time. What grows with the text is the record file
  written after each op and the load of the field once per open. Measured numbers are on the
  [benchmarks](./benchmarks) page.
- Batch keystrokes where you can: a word or a pause in one call, or a [handle](#edit-from-a-keystroke-handler),
  which folds a burst into one op.
- A splice larger than a host's `bytesPerPush` is refused for the whole page it travels in. Paste megabytes
  in several calls.
- A text keeps the runs of every place it was typed into and the tombstones of what was deleted.
  [`compact(id)`](./health#rewrite-a-record-that-has-grown) rewrites the record as it reads today and lays
  the marks again, but every cursor taken before it reads `null` after.
- A text holds at most 65 536 marks and a field 2²² slots, deleted ones included; the full list is in the
  [wire reference](../reference/wire#bounds).

## Coming from RxDB

RxDB has no text type: a string field is one value, and two clients that edit it at once produce a conflict
the conflict handler resolves by keeping one string, or by merging the two by hand. Its CRDT plugin merges
update operators, not characters. In syncom a text field merges keystroke by keystroke, with marks, embeds
and cursors, so a collaborative editor needs no separate CRDT library next to the database.
