---
title: Undo and redo
description: Give users undo and redo over their own writes that never overwrite what another node changed meanwhile, with steps, groups and editor selections.
---

# Undo and redo

In a collaborative app, undo has to mean "take back what I did", not "go back to how it was": a peer may
have changed the same record since, and an undo must not wipe their work. `@alexify/syncom/undo` keeps a
stack of this node's own writes and takes a step back with new ops, so the undo syncs and merges like any
other write, and it leaves alone every field someone else changed meanwhile.

## Undo and redo a step

<<< @/examples/undo.mjs#basic

`createUndo(db, options)` listens to the database's [`commit` event](./versions#react-to-writes-made-on-this-node)
from the moment you create it. Writes made within `mergeInterval` (500 ms by default) of a step's first
write join that step, a [transaction](./transactions-conflicts) is always one step, and `mark()` closes the
current step by hand. A new write clears the redo stack, and the stack keeps `limit` steps (100 by default),
dropping the oldest first.

`undo()` and `redo()` resolve to how many ops they made (`applied`) and how many patches they left alone
(`skipped`). Under the hood an undo is [`applyPatches()`](./versions#compare-versions-and-restore-one) with
the patches that lead back, so a peer sees it as one change.

## What an undo leaves alone

The laptop ticks a task and votes on it; the phone then unticks it and votes too. The laptop undoes:

<<< @/examples/undo.mjs#conflict

The rule is the one Yjs uses: an undo refuses to overwrite. A field that anything other than the step's own
ops changed since, a peer's write or a write of this node the stack does not track, is skipped. What
commutes is no conflict: the laptop's increment comes back off the counter while the phone's stays, and the
same holds for adds to and removes from a set. A step whose way back is the whole record (undoing an
`insert()` deletes the record, undoing a `delete()` writes it again) is skipped whole when anything else
changed the record since.

`undo({ force: true })` overrides the rule and takes the step back regardless. Decide up front: a skipped
patch goes with its step, so the redo holds only what was applied and a retry with `force` finds nothing.

How each kind comes back:

- A field the step created is removed again when nothing else changed it.
- An undone `inc` is the opposite increment; an undone `add` removes this node's adds of the element, so a
  peer's concurrent add of it survives.
- An undone edit of a list or a text is a new edit, and a text comes back as new characters. A peer's edit
  of the same list or text since makes the step's positions stale, so the field is skipped. Marks are not
  undone.

## Make several writes one step

<<< @/examples/undo.mjs#group

`group(fn)` makes one step of everything committed while `fn` runs, however long it takes;
`groupStart()` and `groupEnd()` do the same across calls you cannot wrap in one function.

## Undo in an editor

An editor wants its own stack: only its own edits, only its field, and the caret put back where it was.

<<< @/examples/undo.mjs#editor

`trackedSources` keeps the stack to commits whose `source` is one of them, the `source` of a transaction or
of a document's `save()`; `records` keeps it to some ids, and `paths` to some fields and what hangs under
them. Every step carries `meta`, an object of your own: fill it in `onPush`, read it in `onPop`, and it
travels to the redo step and back. Keep the caret there as a [cursor token](./text#keep-a-caret-where-it-belongs),
which survives the edits in between. The [ProseMirror and CodeMirror adapters](./editors) wire all of this
into undo and redo commands for you.

## What to know

- The stack is this process's own: nothing of it is stored, it is gone when the process ends, and a peer's
  ops are never undone from here.
- The manager is an emitter: `push` when a write joins the stack, `pop` when an undo or redo is done, and
  `change` after either. `steps` lists the steps each way.
- The manager pins the log from its oldest step, because it reads conflicts from the log's entries. A long
  stack keeps old log segments past [retention](./retention) until you call `clear()` or `stop()`.
  `db.close()` stops it too.
- An undo that fails partway (a hook refusing one record's way back) leaves the records it took back taken
  back, with their redo, and the rest on the undo stack for another try. Within one record the inverse is one
  transaction, so a record is never half undone.
- A [purge](./purge) forgets its record on every step.

## Coming from RxDB

RxDB has no undo. An app built on it keeps its own stack of previous document states and writes them back,
which overwrites whatever another client wrote in between. A syncom undo is made of patches checked against
what changed since, so it takes back only what this user did.
