---
title: Versions and history
description: Read a record as it was, list its history, compare and restore versions, name the whole database with a tag, and find who wrote what.
---

# Versions and history

Every write is an op in the node's log, so the past of a record is already on disk. syncom reads it back
by folding the record's ops up to a point: you can list a record's versions, read it as it was at any of
them, see what changed between two versions, and restore an old one with new ops that sync like any write.
A tag names the whole database at a moment, so you can query it as it was.

The past is the `versions` plugin, which `@alexify/syncom/all` registers. Without it, `history()`, `diff()`,
`restore()`, `get(id, { at })` and the tag methods reject with `PLUGIN_MISSING`.

## List a record's history and read an old version

<<< @/examples/versions.mjs#history

`history(id)` lists the versions newest first, one per op this node applied to the record, each with the
op's `eventId`, `type`, `origin`, `actor`, `ts`, the `fields` it changed and the record as it read after it
(`data`). It returns the newest 50 by default; pass `{ limit }`, and page back with `{ before }` set to the
oldest `eventId` you have. `complete` is false when versions were left out, and `exact` is false when the
log can no longer vouch for them (see [below](#when-the-past-is-gone)).

`get(id, { at })` reads one version. A version can be named three ways, and they answer different questions:

| `at` | The record with | Use it to ask |
| --- | --- | --- |
| an event id from `history()` or `db.log.lastEventId` | every op this node applied up to that entry | What did this node hold after that write? |
| a stamp (a number or a `Date`) | every op stamped at or before it, wherever it was made | What had been written by then? The answer is the same on every node that holds the ops |
| `{ vector }`, such as a copy of `db.vector` | every op the vector covers | What do exactly these ops make? The one cut two nodes can agree on by name |

<<< @/examples/versions.mjs#vector

The difference shows after nodes were apart. Ops arrive in a different order on each node, so an event id
describes this node's history, while a stamp or a vector describes the same set of ops everywhere.

<FigVersions />

A read at a version goes through your schema's lens and the read hooks, with `at` in their context, so
whatever redacts the present redacts the past too.

## Name the whole database with a tag

<<< @/examples/versions.mjs#tag

`tag(name)` names the database as it is now: every record, every collection. `at(name)` reads it back as
it was: `get()`, `has()`, `list()`, a collection's `select()` and `count()`, and `snapshot()` pages to seed
another database at that point. A cursor at a tag has no `watch()`, since a tag never changes.

A tag costs nothing when you take it. The first time a record changes after a tag, syncom copies the
record's file for the tag; a record that never changes is its own copy. So a tag costs one file per record
changed after it, however many times it changes. Tags are this node's own: they do not replicate, and a peer
that needs the same version takes its own tag. `untag(name)` drops one. A name already in use rejects with
`TAG_EXISTS`, and `at()` of an unknown name throws `TAG_NOT_FOUND`.

## Compare versions and restore one

<<< @/examples/versions.mjs#diff

`diff(id, from, to)` lists the patches that turn the record at `from` into the record at `to` (the present
when you leave `to` out). A patch is plain JSON in the terms of the write API: `put` for a field's new value,
`inc` for a counter, `add` and `remove` for a set, `splice` for a list or a text, `treeMove` and
`treeRemove`, `unset`, and `write`, `delete` or `purge` for the whole record. Marks are not compared.

`restore(id, at)` applies the patches that lead back, as new ops of this node: the restore is a version of
its own and merges with what peers write meanwhile. `applyPatches(id, patches)` applies any list of
patches you build yourself. Both check every patch first and land as one
[transaction](./transactions-conflicts): a patch that would be refused (an index out of range, a field of
another kind) refuses the whole list before anything is written.

## React to writes made on this node

<<< @/examples/versions.mjs#commit

The `commit` event fires once for every local write when its op is durable: the op, its position in the
log (`seq`), the transaction it was part of (`txn`), the `source` you passed to `transact()` or
`applyPatches()`, the record `before` and `after`, every field's kind, and the `changes` it made. A peer's
op fires `change`, not `commit`. The event is what the [undo stack](./undo) keeps, and the full list of
events is in the [events reference](../reference/events).

## Find who wrote what

<<< @/examples/versions.mjs#blame

`lastEditorOf(id, field)` is the node and the stamp behind a field's current value (the newest increment
of a counter, the newest run, mark or move of a list, text or tree; `null` for a set). `editorsOf(id)`
lists every node whose writes the record still carries, and `editorOf(id, key, index)` who inserted one
element of a list or one character of a text. They read the record's metadata, not the log, so they are
cheap and survive compaction. An origin is a node id, the node's signing key when ops are
[signed](./signing), not a person: map nodes to people in your app, or read the `actor` each op carries in
`history()`.

## When the past is gone

<<< @/examples/versions.mjs#gone

The log does not keep everything forever. Once [retention](./retention) drops old ops, a version is exact
only from a whole-record write (an `insert()`, a `set()`, a `delete()`) newer than what was dropped:
`history()` says `exact: false` and `get(id, { at })` rejects with `HISTORY_GONE` and `reason: 'compacted'`
for a version it cannot give. A [purge](./purge) takes the payload of every op of the record, so versions
before it reject with `reason: 'scrubbed'`. A node that joined through a snapshot holds the joined state as
one op, so a stamp before it rejects with `reason: 'merge'`.

To keep the log for a reader that needs it, such as a long comparison, `db.log.pin(keep)` holds the entries
`keep(entry)` answers true for past retention until you call the function it returns. An undo stack pins
the log the same way.

## Costs

A version is a fold of the record's ops held in memory: as many steps as the record has ops in the log.
That is fine for a record with hundreds of ops; `history()` folds all of them whatever its `limit`. A record
written ten thousand times is a record to [rewrite](./health#rewrite-a-record-that-has-grown) now and then.
A tag costs one catalog file when taken and one copied file per record changed after it; an open reads the
newest tag's catalog only.

## Coming from RxDB

An RxDB document holds its latest state and a revision. There is no API that reads an earlier state or
lists a document's changes, so an app that needs history keeps its own copies. In syncom the history is a
reading of the log the node already keeps for replication, and tags name the whole database cheaply.
