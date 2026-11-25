---
title: Versions and tags
description: "The rules of the past: what a version is, when the log can vouch for it, tags on disk, patches, the commit event, undo, branches and compact."
---

# Versions and tags

The specification of the `versions` plugin (`src/versions/`), the present's patches (`src/patches.js`,
`src/patch.js`), the undo stack (`src/undo/`) and branches (`src/branch/`). The guide's
[Versions and history](../guide/versions), [Undo and redo](../guide/undo) and [Branches](../guide/branches)
pages teach them; this page records the rules. The methods are in the [API reference](./api#database)
(`get(id, { at })`, `history()`, `tag()`, `at()`, `atVersion()`, `diff()`, `applyPatches()`, `restore()`,
`compact()`) and the subpaths' sections ([Versions](./api#versions-subpath), [Undo](./api#undo-subpath),
[Branch](./api#branch-subpath)).

Every op a node applies is in its log, so the past of a record is a fold of the log's entries of it — the same
`applyOp` that built the record the first time, stopped at a version. Nothing of the past is ever answered from
a record file or the catalog, a tag's copies aside.

## What a version is

A version is a cut through the record's ops, named one of three ways. They answer different questions, and the
difference shows after a partition.

| `at` | The cut | The question |
| --- | --- | --- |
| an event id (`'<epoch>.<seq>'`, what `history()` lists and the log's `lastEventId`) | every entry of this node's log up to that one | What did this node hold after that entry? — the arrival order here, which another node need not share |
| a stamp (a number or a `Date`) | every op stamped at or below it | What had been written by then, wherever? — the same answer on every node that holds the ops, whatever order they arrived in |
| `{ vector }` (a [version vector](./wire#the-log), such as `db.vector` at some moment) | every op the vector covers | What do exactly these ops make? — the one cut two nodes can agree on by name |

A fourth form, `{ tag }`, is not a cut of the log: it reads the record's file as a [tag](#tags) kept it.

`history()` on a node lists what that node applied, in its order. An op this node skipped — a `beforeApply`
that answered `false`, an op invalid under its schema — is no version here; one held for a newer schema version
becomes one, at its own event id, once the node runs that version. `history(id, { limit })` lists the newest
`limit` versions (50 by default, `Infinity` for all); `complete` is false when it leaves older ones out, and
`history(id, { limit, before })` with the oldest version's `eventId` pages back from it. `before` is an event id
of this log (another value is a `TypeError`, one of another incarnation `ALX_ERR_HISTORY_GONE` with `reason: 'epoch'`).
Each version carries the op's `eventId`, `seq`, `type`, `origin`, `actor`, `message` and `ts`, the `fields` it
changed (removed ones included), and `data` — the record as it read after the op, through the schema lens and
the `afterRead` hook, `null` once deleted. A read at a version runs `beforeRead` and `afterRead` with
`{ id, at }`, so what redacts the present redacts the past too; `history()` runs `beforeRead` once with
`{ id, history: true }` and `afterRead` per version it hands out, with that version's event id as `at`.

`atVersion(at)` is the whole database at a version: every id the log retains entries for and every catalog id
folded to the version, and the vector of the ops within it, per stream — a stream with nothing retained was
dropped whole below the floor and is inside the version; one retained only past the version is
`ALX_ERR_HISTORY_GONE` (`reason: 'compacted'`). Its `snapshot()` pages the result the way `snapshot()` pages the
present, which is what a [branch](#branches) forks from.

## What the log can vouch for

The fold is **exact** — the record as this node held it — while the log holds every op the node applied to the
record. Compaction drops the oldest segments, and `db.log.droppedTs` is the newest stamp among what went (or
among what an open could not read). From then on a version is exact only when a reset — a whole-record write
(`set()`, `insert()`), a `delete()` or a `purge()` — stamped above `droppedTs` is inside the cut: a reset
discards everything stamped below it, and everything dropped was stamped at or below `droppedTs`. `history()`
lists the versions from that reset on and reports `exact: false` (with whatever is retained) when there is none;
`get(id, { at })` rejects with `ALX_ERR_HISTORY_GONE` and `reason: 'compacted'` for a cut it cannot give exactly, and
for a cut before anything retained of a record that exists. A record that never existed here reads as `null` at
any version. Under `retention: 'all'` nothing is dropped and every version is exact.

One exception the reset rule has, the one [`repair()`](./api#database) has too: a counter slot alive across the
reset keeps a sum older increments went into, so the fold from the reset lacks them. With `droppedTs` above 0 the
fold of everything retained is compared with the record as it is, which shows the difference whenever the
present still carries it — `exact: false`, `ALX_ERR_HISTORY_GONE` — and the next reset ends it.

A node that joined through a snapshot holds the joined state as one `merge` op: a version by event id or vector
takes it as one op, but a stamp below the merge's cannot tell which of the joined ops were written by then and
rejects with `reason: 'merge'`. A purge scrubs the payload of every entry of the record: `history()` still lists
the ops, the purge among them, with `data: null`, `fields: []` and `scrubbed: true`, and a version before the
purge rejects with `reason: 'scrubbed'`; one after it is `null`. An encrypted record has no ops and no past:
`ALX_ERR_ENCRYPTED`. An event id from another incarnation of the log rejects with `reason: 'epoch'`; a seq the log has
not reached, or an `at` of the wrong shape, is a `TypeError` with `code: 'ALX_ERR_INVALID_VERSION'`.

`db.log.pin(keep)` holds the log's segments past retention for a reader that needs them — an undo stack, a
long-running comparison: an entry `keep(entry)` answers true for stays, with its segment and everything after
it, until the function `pin()` returns is called. Pins add up; `stats().log.pins` counts them.

## Tags

A tag names the whole database as it is, and keeps it on this node: the catalog of the moment — which records
existed, as what — plus a copy of each record's file taken **before its first change after the tag**. A tag
costs nothing per record until the record changes, and one copy per changed record after that, however many
times it changes. A copy lands in the newest tag only: had the record changed between two tags, the older one
took its copy while it was the newest. Reading a record at a tag walks the tags from it to the newest for a copy
and falls through to the record as it is — a record unchanged since the tag is its own copy — and a record that
was not there, or was a tombstone, at the tag reads as `null`. `untag()` moves to the next older tag the copies
it needs — those of records that did not change between the two — and drops the rest.

In the engine's stores (under `<path>/` on the files engine):

| Where | What |
| --- | --- |
| `tags.json` (the root kv namespace) | `{ format: 1, tags: [{ name, eventId, seq, ts, vector, createdAt }] }`, oldest first |
| `tags/<name>/index/catalog.json` (a kv namespace of its own) | The catalog as of the tag, stamped with its event id |
| `copies` by tag (`tags/<name>/data/<id>.json`) | A record's file as it was at the tag, copied before its first change |
| `tags.corrupt.json` (root) | An unreadable `tags.json`, kept aside for a repair by hand |
| `copies` under `.pending` (`tags/.pending/data/`) | The copies taken while `tags.json` is unreadable |

The order of writes: a tag's catalog, then `tags.json`, then the tag is registered; an untag moves the copies
the older tag needs, then rewrites `tags.json`, then removes the files. A `tags/<name>` left without its line in
`tags.json` — a crash in between — is unknown to every reader and is emptied when a tag of that name is taken
again. A name is of the record-id form (another is a `TypeError`; a name in use is `ALX_ERR_TAG_EXISTS`, with `tag`),
and so is every name `tags.json` holds — a line of another name is dropped at open, with a warning, never read
as a path.

A copy is the file as it was, chain block included: a tampered or torn copy fails its check at the tag
(`ALX_ERR_INTEGRITY`) and leaves the present alone; a sealed record's copy stays sealed for this node's key. The copy is
taken inside the write, in the write set ahead of the record, so a copy that cannot be written leaves the record
held — the op is logged, the record reported `ALX_ERR_UNPERSISTED` and kept in memory, its file untouched, so the tag
still reads the file — and the next write of it lands with the copy. For the same reason `tag()` refuses with
`ALX_ERR_UNPERSISTED` while a record is held: there is no file to copy from until it lands. Under
`createDatabase({ defer })` `tag()` lands the waiting files first, so the tag's catalog and the files agree; a
record written after the tag whose file still waits reads at the tag from that file — still the tag's state —
and the copy is taken when the file lands. A purge reaches the tags: every copy of the record goes and every
tag's catalog forgets its row, indexed values included. The read hooks run with `at: { tag }`.

A tag is the whole database: `at(name).list()` is every live id then, `at(name).collection(entity)` queries the
collection as it was — `select()` and `count()` over the tag's own catalog, each row read from its copy or from
the record as it is — and `at(name).snapshot()` pages the database as it was, so another database can
`mergeSnapshot()` the pages and `adoptVector()` the vector and stand at the tag. A cursor at a tag has no
`watch()` (it throws) and no `$text` (its catalog carries no text index; a `TypeError`). Tags are this node's:
they name a position in this node's log and do not replicate. `tag()` runs in the mutation queue, so no write
lands between the catalog and the position it names.

An open reads `tags.json` and the newest tag's catalog — the one the write path copies into — and an older tag's
catalog when the tag is first read, so an open costs one catalog however many tags there are. `at(name)` reads
nothing: it throws `ALX_ERR_TAG_NOT_FOUND` for a name this node has not, and the view's first read reads the catalog,
which is why `has()` and `list()` are promises. A tag whose catalog is gone is dropped then (the newest at open)
as `untag()` would drop it, with a warning (`tags.dropped`), and the read that found it gone rejects with
`ALX_ERR_TAG_NOT_FOUND`. An unreadable `tags.json` does not stop the open — the tags' names cannot be listed back from the
disk — so the file is kept as `tags.corrupt.json`, the database runs without tags (`stats().tags.corrupt`),
`tag()` refuses with `ALX_ERR_CORRUPT` so nothing overwrites the names, and every record changed meanwhile has its file
kept under `.pending`; the next open with a repaired file hands those copies to the newest tag, so it reads as it
did. A directory that holds tags is refused at `createDatabase()` without the `versions` plugin.

## Patches

`diff(id, from, to)` is the list of **patches** that turn the record at `from` into the record at `to` (the
present when `to` is left out); `restore(id, at)` is `applyPatches()` of `diff(id, undefined, at)` — new ops
that lead back, so the step is a version of its own and merges like any write. A patch is plain JSON in the
terms of the write API, one per field by its kind:

| `action` | Fields | Means |
| --- | --- | --- |
| `put` | `field`, `value` | A register's new value — a `set` |
| `unset` | `field` | A field removed, of any kind |
| `write` | `data` | The registers as a whole — a reset, the other kinds made again after it; only for a record that was not there |
| `inc` | `field`, `value` | A counter's delta |
| `add` | `field`, `elements` | Set elements added |
| `remove` | `field`, `elements` (and `own`) or `removals` | Set elements removed: with `elements` the adds this node observed, with `own: true` this node's adds alone (the way an undo revokes its own add and leaves a peer's), with `removals` exactly the tags named, `[[element, { origin: addTs }]]` |
| `splice` | `field`, `index`, `count`, `content`, `vals?` | A list's or text's edits, by Myers; `vals` the markers of the embed slots it inserts |
| `setAt` | `field`, `index`, `value` | A list element's value, or a text slot's marker |
| `mark` | `field`, `start`, `end`, `name`, `value`, `expand?`, `many?` | A text's style over `[start, end)` (what `compact()` lays again; `diff()` does not diff marks) |
| `treeMove` | `field`, `node`, `parent`, `after?` | A tree node placed |
| `treeRemove` | `field`, `node` | A tree node removed with its subtree |
| `delete`, `purge` | — | The record deleted, purged |

A field that is gone is an `unset`. One that changed kind is an `unset` and then the field made again whole as
what it is at `to`: a counter by an `inc` of its sum, a set by an `add`, a list or a text by a `splice`, a tree by
its moves, and a register by a `put` of its value. The `unset` is not optional: on the op path a register outranks
every other kind, but no local write lands on a field of another kind (`ALX_ERR_FIELD_KIND`), so the name is freed first.
For the same reason every `unset` of a diff comes ahead of everything it makes, whatever the order of the fields:
a text at `profile` is gone before `profile/city` is put under it. A field that was not there is made the same
way, so a counter that reads `0` comes back as an `inc` of `0`. One thing a diff cannot make: a set, a list, a
text or a tree that reads empty — no op makes an empty one — so where `to` holds such a field and `from` holds
another kind, or none, the field is left out. And a list made again names its elements anew, so a diff that makes
one again and also holds fields under its old elements is refused whole by `applyPatches()` (`ALX_ERR_NOT_FOUND`, nothing
written): a diff does not rename them. A text's marks are not diffed. The diff reads both versions through the
schema lens, raw, without the read hooks, and rejects as `get(id, { at })` would for either version.

`applyPatches(id, patches, { actor, source, message })` realizes a list as one transaction and resolves to how
many ops it took. A patch is checked as the method of its name checks its arguments — the wrong shape is a
`TypeError` and nothing is written — and every patch is first resolved and applied over a scratch record, so an
index out of range, a kind clash, a cycle, a sibling not there or a type change refuses the whole list with the
error the method would have thrown (`ALX_ERR_OUT_OF_RANGE`, `ALX_ERR_FIELD_KIND`, `ALX_ERR_CYCLE`, `ALX_ERR_NOT_FOUND`, `ALX_ERR_TYPE_IMMUTABLE`), before
anything is appended: a restore lands whole or not at all. The hooks and the validator run on each op as it is
made, and one that throws on a later op leaves nothing written — no version in `history()`, no op on its way to
the peers. A `restore()` whose diff is a reset makes texts again without their marks.

## The commit event

Every local write — a call of the write API, a `Document`'s `save()`, `transact()`, `applyPatches()`,
`restore()`, `compact()`, a schema migration — raises `commit` once its op is durable, with the op, its `seq`,
`txn` (the seq of the first op of its transaction), `source`, the record `before` and `after` as copies in the op
model's terms (every path a field of its own, no lens), every field's `kinds` (one kind a field: what `after`
holds it as, or what `before` held a field that is gone), `was` where the op left a field of another kind than it
found it (the kind before, by field; absent otherwise), its
[changes](./events#changes) and, where a text holds embed slots, `embeds` (the markers on each side). It is what
an undo stack keeps; the copies are made at their first read, and the event only while something listens. A
peer's op raises `change`, not `commit`, and so do the `merge` and `advance` ops a joined snapshot leaves; an
encrypted write makes no op and raises neither — nor does a tree move to where the node already is. The payload
is in [Database events](./events#database-events).

## Undo

`createUndo(db, options)` (`@alexify/syncom/undo`) keeps an undo stack over one node's own writes. Every commit of
the database's own joins the current step — per record, how the step found it and how it left it; the patches
that take it back are made when it is undone. Commits within `mergeInterval` (500 ms) of a step's first merge
into it, a transaction's commits are one step whatever the interval, `group(fn)` (or `groupStart()` …
`groupEnd()`) makes one of everything committed meanwhile, `mark()` closes a step by hand, a new write clears the
redo stack, and `limit` (100) steps are kept, the oldest dropped first.

An undo applies a step's patches through `applyPatches()` — new ops, so it merges like any write and a peer sees
it as one — and what those ops commit is the redo step. A step may leave a field of another kind than it found it
(an `unset`, then the field made again): the way back reads each side by its own kinds — how the step's first
commit found the fields, how its last left them — so the field comes back as the kind it was with its value, and
the redo makes it the kind it became. The rule is Yjs's, refuse to overwrite: a field anything
but the step's own ops changed since — a peer's write, a write of this node's the stack does not hold — is left
alone and counted in `skipped`, and a step whose way back is the whole record (an `insert()`, whose way back is a
delete; a `delete()`, whose way back writes the record again) is skipped whole when anything else changed the
record since; `undo({ force: true })` overrides. A skipped patch goes with its step — the redo step holds only what
was applied — so `force` is chosen up front, not as a retry. A write at a prefix of a step's field, or under it,
counts as a change of the field.

What commutes is no conflict: a peer's increment of the same counter, or add to or remove from the same set,
leaves the undo free; a peer's edit of the same list or text does not (the undo's positions are stale by then). A
field the step created is `unset` again when nothing else changed it since; with a peer's change beside it the
undo takes a counter down, removes this node's set elements, or leaves a list, a text or a tree alone instead, so
the peer's change stays. An undone `add` removes this node's adds of the element alone, so a peer's concurrent add
of it survives; an undone `inc` is the increment back; a text comes back as new characters. A text's marks are not
undone. An undo that fails partway — a hook refusing one record's inverse — leaves the records it took back taken
back, with their way back on the redo stack, and the rest on the undo stack for another try, so a record is never
inverted twice; within one record a refused op leaves nothing of that record applied.

`scope` keeps the stack to one scope's ops (`'*'` the global one), `exclude(op)` leaves ops out, `actor` is the
actor the undo's own ops carry; `trackedSources` keeps it to commits whose `source` is one of them, `records` to
these ids (or a predicate on the id), `paths` to these fields and what hangs under them — a step's inverse then
keeps to those fields, and a whole-record change is none of the manager's business. Every step carries `meta`, the
application's object, the same on every event of the step and carried to its redo step and back (a selection kept
as cursor tokens, restored through `position()`). The stack is this process's: nothing of it is written, a peer's
ops are never undone from here, and a purge forgets its record on every step. The manager pins the log from its
oldest step (conflicts are read from the log's entries), so a long stack holds segments past retention until
`clear()` or `stop()`.

## Branches

`branch(parent, { path, from, ...options })` (`@alexify/syncom/branch`) forks a database into a new directory — a
new identity, its own keys and log — standing at the parent's state, at a tag of it (`from: { tag }`), or at any
version its log can still give exactly (`from: { at }`, through `atVersion()`; a record compacted past it, or a
stream cut with nothing of it inside, is `ALX_ERR_HISTORY_GONE`, never under `retention: 'all'`). It is opened with the
options given, on the parent's `fsi` unless they name another; its `sync` gets `retention: { ops: 0 }`, so every op
stays for the merge back, and `autoStart: false`. The fork pages the parent's snapshot (or the tag's, or the
version's) into the branch and adopts the parent's vector, so the branch knows what it holds; what lands on the
parent while the pages go out is caught up as ops, so a branch of the present stands at one cut. `branch.json`
(`{ format: 1, parent, forkedAt: { eventId, vector, ts, tag, at }, createdAt }`, the root kv namespace; `at` the version as given, `null` for a fork of the present or of a tag) names the
parent and the position — what `branchInfo()` reads back, `null` for a database that is no branch.

`merge(source, { into })` hands `into` the ops after its vector, of every stream the source holds, through
`applyRemote` — the way a peer's push lands — so concurrent edits of one record converge by the usual rules and a
second merge has nothing to hand over. The ops keep their origin: a merge into a parent that dials peers reaches
them as the branch's own ops. A source whose log no longer holds what the other needs, of any stream it carries —
a third node's included — is joined as state instead, its snapshot pages then its vector, and the result says
`joined: true`: a merge never reports success over a gap. A `signatures: 'require'` parent takes a branch's ops:
they are signed by the branch's own key.

`branch()` opens a new directory only: a path that holds files already is `ALX_ERR_BRANCH_EXISTS`, and a fork that fails
halfway leaves nothing behind. `drop(branch)` closes it and removes every file of the known layout, the tags'
included; the empty directories stay. It takes only what `branch()` made: a database with no `branch.json` is
refused with a `TypeError` and keeps its files, an unreadable one with `ALX_ERR_CORRUPT`. A branch is a branch only here:
nothing of it replicates as such, and a peer sees merged ops like any other.

## Compact

A record whose past has grown — a tree moved thousands of times keeps every move, a text typed into from many
places keeps a run per place, a field deleted from keeps its tombstones — is rewritten by `compact(id, { actor,
source, message })`: a whole-record write of the registers and one op per field of another kind (an `inc`, an
`add`, a text or a list as one run, a tree as one move per node), so what lies under it goes by the reset rule on
every node, and the fields read as they did. It resolves to how many ops it took — `0` for a record that is not
there, `ALX_ERR_ENCRYPTED` for an encrypted one — and is a whole-record write like any other: a peer's op stamped before
it and arriving after it is dropped by the reset, and a peer's typing stamped above it that was anchored in the old
runs reads from the head (see [How a list or text merges](./text#how-a-list-or-text-merges)). A text's marks are
laid again over the new run, in the order they were made and with the expand rule their anchors had, so `spans()`
reads the same; a counter at `0` stays a counter; a text or a list longer than one run (1 048 576 elements) is
made again in runs of that size. It names every element anew: the cursors into its texts and lists read `null`
after, and a stacking mark has a new id. A list, a text, a set or a tree that reads empty is left out: no op makes
an empty one.

## Costs

A version is a fold of the record's retained entries — as many `applyOp` calls as the record has ops in the log,
read from memory — plus the comparison with the present once compaction has run. `history()` folds them all,
whatever its `limit`, and reads through the lens and `afterRead` only the versions it hands out: paging saves the
reads, not the fold. A record edited ten thousand times is a record to compact now and then. A tag costs one
catalog when taken and one copy per record changed after it; every catalog read since the open stays in memory, so
a hundred tags over a hundred thousand records is a cost to feel, ten is not. A purge reads every tag's catalog, to
forget the record there.
