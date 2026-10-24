# Versions and history

Every op a node applies is in its log, so the past of a record is a fold of
the log's entries of it — the same `applyOp` that built the record the first
time, stopped at a version. `history(id)` lists the versions, `get(id, { at })`
reads one back, and both say when the log can no longer vouch for what they
give.

```js
const id = await storage.insert({ title: 'Draft' });
await storage.update(id, { title: 'Final' });
await storage.inc(id, 'views', 1);

const { versions, complete, exact } = await storage.history(id);
// versions, newest first:
// [{ eventId: 'mvm…6.3', seq: 3, ts: 1792…, origin: '…', actor: null, type: 'inc',
//    fields: ['views'], data: { title: 'Final', views: 1 } },
//  { …, type: 'set',   fields: ['title'], data: { title: 'Final' } },
//  { …, type: 'write', fields: ['title'], data: { title: 'Draft' } }]
// complete: true — the list reaches the first op this node applied to the record
// exact: true    — the versions are what this node held

await storage.get(id, { at: versions[1].eventId }); // { title: 'Final' }
await storage.get(id, { at: versions[2].ts });      // { title: 'Draft' } — by stamp
await storage.get(id, { at: { vector: storage.vector } }); // the present
```

## What a version is

A version is a cut through the record's ops, named one of three ways. They
answer different questions, and the difference shows after a partition.

| `at` | The cut | The question |
| --- | --- | --- |
| an event id (`'<epoch>.<seq>'`, what `history()` lists and the log's `lastEventId`) | every entry of this node's log up to that one | *What did this node hold after that entry?* — the arrival order here, which another node need not share |
| a stamp (a number or a `Date`) | every op stamped at or below it | *What had been written by then, wherever?* — the same answer on every node that holds the ops, whatever order they arrived in |
| `{ vector }` (a [version vector](./sync#the-log), such as `storage.vector` at some moment) | every op the vector covers | *What do exactly these ops make?* — the one cut two nodes can agree on by name |

Two nodes apart write to one record; A's own write lands in A's log before
B's does. On A, the event id from before B's write arrived gives A's write
alone; the stamp between the two writes gives B's alone (B wrote first by
the clock); A's vector from that moment gives A's write alone, and B's vector
gives both. `history()` on each node lists what that node applied, in its
order.

`history(id, { limit })` lists the newest `limit` versions (50 by default);
`complete` is then false. Each version carries the op's `type`, `origin`,
`actor` and `ts`, the `fields` it changed (removed ones included), and `data`
— the record as it read after the op, through the schema lens and the
`afterRead` hook, `null` once deleted. A read at a version runs
`beforeRead` and `afterRead` with `{ id, at }`, so what redacts the present
redacts the past too; `history()` runs `beforeRead` once with `{ id,
history: true }` and `afterRead` per version.

## What the log can vouch for

The fold is exact — the record as this node held it — while the log holds
every op the node applied to the record. Compaction drops the oldest
segments ([retention](./sync#the-log)), and `storage.log.droppedTs` is the
newest stamp among what went. From then on a version is exact only when a
reset — a whole-record write (`set()`, `insert()`), a `delete()` or a
`purge()` — stamped above `droppedTs` is inside the cut: a reset discards
everything stamped below it, and everything dropped was stamped at or below
`droppedTs`. `history()` lists the versions from that reset on and reports
`exact: false` (with whatever is retained) when there is none; `get(id, {
at })` rejects with `HISTORY_GONE` and `reason: 'compacted'` for a cut it
cannot give exactly, and for a cut before anything retained of a record that
exists. A record that never existed here reads as `null` at any version.

One exception the reset rule has, the same one [`repair()`](./storage#repair)
has: a counter slot that was alive across the reset keeps a sum older
increments went into, so the fold from the reset lacks them. The fold of
everything retained is compared with the record as it is, which shows the
difference whenever the present still carries it — `exact: false`,
`HISTORY_GONE` — and the next reset ends it.

A node that joined through a [snapshot](./sync#bootstrap) holds the joined
state as one `merge` op: a version by event id or vector takes it as one op,
but a stamp below the merge's cannot tell which of the joined ops were
written by then and rejects with `reason: 'merge'`. A purge scrubs the
payload of every entry of the record: `history()` still lists the ops, with
`data: null`, no `fields` and `scrubbed: true`, and a version before the
purge rejects with `reason: 'scrubbed'`; one after it is `null`. An
encrypted record has no ops and no past: `ENCRYPTED`. An event id from
another incarnation of the log rejects with `reason: 'epoch'`; a seq the
log has not reached, or an `at` of the wrong shape, is `INVALID_VERSION`.

`storage.log.pin(keep)` holds the log's segments past retention for a reader
that needs them — an undo stack, a long-running comparison — until the
function it returns is called.

## Tags

A tag names the whole storage as it is now, and keeps it on this node:

```js
const id = await storage.insert({ title: 'Draft' });
const tag = await storage.tag('v1');
// { name: 'v1', eventId: 'mvm…1', seq: 1, ts: 1792…, vector: { '…': 1 }, createdAt: 1792… }
await storage.update(id, { title: 'Final' });
const later = await storage.insert({ title: 'Another' });

const v1 = storage.at('v1');
await v1.get(id);                              // { title: 'Draft' }
await v1.get(later);                           // null — not there yet
v1.has(id);                                    // true
await storage.get(id, { at: { tag: 'v1' } }); // { title: 'Draft' }
storage.tags();                                // [tag]
await storage.untag('v1');
```

A tag is the catalog of the moment — which records existed, as what — plus
a copy of each record's file taken **before its first change after the
tag**, so a tag costs nothing per record until the record changes, and one
file per changed record after that, however many times it changes. A copy
lands in the newest tag only: had the record changed between two tags, the
older one took its copy while it was the newest. Reading a record at a tag
walks the tags from it to the newest for a copy and falls through to the
record as it is — a record unchanged since the tag is its own copy — and a
record that was not there, or was a tombstone, at the tag reads as `null`.
`untag()` moves to the next older tag the copies it needs — those of
records that did not change between the two — and drops the rest; the
empty directory stays (`fsi` has no rmdir).

A copy is the file as it was, chain block included: a tampered or torn copy
fails its check at the tag (`INTEGRITY`) and leaves the present alone; a
sealed record's copy stays sealed for this node's key. The copy is taken
inside the write, before the record's file changes, so a copy that cannot
be written leaves the record held — the op is logged, the record is
reported `UNPERSISTED` and kept in memory, its file untouched, so the tag
still reads the file — and the next write of it lands with the copy. For
the same reason `tag()` refuses with `UNPERSISTED` while a record is held:
there is no file of it to copy from until it lands. A purge reaches the tags: every copy of the record goes and every
tag's catalog forgets its row, indexed values included, so
`at(name).has(id)` is false and `get` is `null`. The read hooks run with
`at: { tag }`.

A tag is the whole storage, not one record: `at(name).list()` is every live
id then, `at(name).collection('Post')` queries the collection as it was —
`select()` and `count()` over the tag's own catalog, each row read from its
copy or from the record as it is — and `at(name).snapshot()` pages the
storage as it was, the way [`snapshot()`](./sync#bootstrap) pages the
present, so another storage can `mergeSnapshot()` them and stand at the tag.
A cursor at a tag has no `watch()` (a tag does not change) and no `$text`
(its catalog carries no text index).

```js
const posts = storage.at('v1').collection('Post');
await posts.select({ n: { $gte: 2 } }).order('n').fetch(); // as of v1
await posts.count();                                         // as of v1
storage.at('v1').list();                                     // every live id as of v1
const page = await storage.at('v1').snapshot();              // { records, cursor, eventId, vector }
await other.mergeSnapshot(page.records);                     // another storage, now at v1
await other.adoptVector(page.vector);
```

Tags are this node's: they live under `tags/` next to the data, name a
position in this node's log, and do not replicate — a peer that needs the
same version takes its own tag. `tag()` runs in the mutation queue, so no
write lands between the catalog and the position it names; a name is of the
record-id form. A directory a crash left under `tags/` without its line in
`tags.json` is unknown to every reader and is swept when a tag of that name
is taken again; a tag whose catalog file is gone is dropped at open with a
warning. An unreadable `tags.json` does not stop the open: the tags are
auxiliary, and their names cannot be listed back from the disk, so the file
is kept aside as `tags.corrupt.json` for a repair by hand, the storage runs
without tags (`stats().tags.corrupt`), `tag()` refuses with `CORRUPT` so
nothing overwrites the names, and every record changed meanwhile has its
file kept under `tags/.pending/` — the next open with a repaired file hands
those copies to the newest tag, so it reads as it did.

## Diff and restore

`diff(id, from, to)` is the list of **patches** that turn the record as it
was at `from` into how it is at `to` (the present when `to` is left out),
and `restore(id, at)` applies the list the other way round — new ops that
lead back, so the step is a version of its own and merges like any write:

```js
await storage.diff(id, { tag: 'v1' });
// [{ action: 'put', field: 'title', value: 'Final' },
//  { action: 'inc', field: 'views', value: 1 }]
await storage.applyPatches(id, [{ action: 'inc', field: 'views', value: -1 }]); // one op
await storage.restore(id, { tag: 'v1' });     // one op — a write, since the counter has to go
```

A patch is plain JSON in the terms of the write API, one per field by its
kind: `put` (a register's new value — a `set`), `inc` (a counter's delta),
`add` and `remove` (a set's elements — `remove` with `elements` takes the
adds this node observed, with `own: true` this node's adds alone, the way an
undo revokes its own add and leaves a peer's concurrent one, with `removals`
exactly the tags named), `splice` (a text's
or a list's edits, by Myers), `treeMove` and `treeRemove`, `delete`,
`purge`. No op removes one field, so a register that is gone, or a field
that changed kind, makes the diff a `write` of the registers followed by
the other kinds made again whole. A text's marks are not diffed. The diff
reads both versions through the schema lens, raw, without the read hooks.
`applyPatches(id, patches, { actor, source })` realizes a list in one turn
of the mutation queue and resolves to how many ops it took. A patch is
checked as the method of its name checks its arguments — the wrong shape is
a `TypeError` and nothing is written — and every patch is first resolved and
applied over a scratch record, so an index out of range, a kind clash, a
cycle or a type change refuses the whole list before anything is appended:
a restore lands whole or not at all. (A hook or a validator that throws on
a later op still leaves the earlier ones committed; those run on the real
writes.)

## The commit event

```js
storage.on('commit', ({ op, seq, source, before, after, kinds }) => { … });
```

Every op this node makes raises `commit` once it is durable: the op, its
seq in the log, the `source` (the `Record` whose `save()` it was, or what
`applyPatches()` was given), the record `before` and `after` as copies, and
every field's `kinds` (`register`, `counter`, `set`, `list`, `text`, `tree`
— of the fields there before and after). It is what an undo stack keeps;
the copies are made only while something listens. A peer's op raises
`change`, not `commit`.

## Undo and redo

`@alexify/syncom/undo` is an undo stack over one node's own writes, built
on the [commit event](#the-commit-event) and [patches](#diff-and-restore):

```js
import { createUndo } from '@alexify/syncom/undo';

const undo = createUndo(storage, { mergeInterval: 500, limit: 100 });
await storage.update(id, { title: 'Final' });
await storage.inc(id, 'views', 1);          // within 500 ms of the update: one step
await undo.undo();                           // { applied: 2, skipped: 0 } — both taken back
await undo.redo();                           // done again
undo.mark();                                 // the next write starts a new step
undo.canUndo; undo.canRedo; undo.size;       // { undo, redo }
undo.stop();                                 // also on storage.close()
```

Every commit of the storage's own joins the current step — per record,
how the step found it and how it left it; the patches that take it back are
made when it is undone — commits within `mergeInterval` of the step's first
merge into it, `mark()` closes a step by hand, a new write clears the redo
stack, and `limit` steps are kept. An undo applies a step's patches through
`applyPatches()` — new ops, so it merges like any write and a peer sees it
as one — and what those ops commit is the redo step. The rule is Yjs's,
refuse to overwrite: a field anything but the step's own ops changed since
— a peer's write, a later step of this node's — is left alone and counted
in `skipped`, and a whole-record step (a `set()` that added a field, a
`delete()`) with such a conflict is skipped whole; `undo({ force: true })`
overrides. What commutes is no conflict: a peer's increment of the same
counter, or add to or remove from the same set, leaves the undo free; a
peer's edit of the same list or text does not (the undo's positions are
stale by then). A field the step created is gone again when nothing else
changed since — a whole-record write; with a peer's change beside it the
undo empties the field instead, so the peer's change stays. An undone
`add` removes this node's adds of the element alone, so a peer's concurrent
add of it survives; an undone `inc` is the increment back; a text comes
back as new characters. A text's marks are not undone. An undo that fails
partway — a hook refusing one record's inverse, say — leaves the records
it took back taken back, with their way back on the redo stack, and the
rest on the undo stack for another try: a record is never inverted twice.

The stack is this process's: nothing of it is written, a peer's ops are
never undone from here, a `purge` forgets its record on every step, `scope`
keeps to the ops of one scope and `exclude(op)` leaves ops out. The
manager pins the log from the oldest step it holds (conflicts are read
from the log's entries), so a long stack holds segments past retention
until `clear()` or `stop()`.

## Branches

`@alexify/syncom/branch` forks a storage into another directory — a new
identity, its own keys and log, standing at the parent's state or at a tag
of it — and merges the two as ops, either way:

```js
import { branch, merge, branchInfo, drop } from '@alexify/syncom/branch';

const draft = await branch(storage, { path: './data-draft', schema });      // at the present
const fromV1 = await branch(storage, { path: './data-v1', from: { tag: 'v1' } });
await draft.update(id, { title: 'Reworked' });                          // a storage like any other
await merge(draft, { into: storage });   // { ops: 1, pages: 1, joined: false }
await merge(storage, { into: draft });   // the parent's news, the other way
await branchInfo(draft);                 // { parent, forkedAt: { eventId, vector, ts, tag }, createdAt }
await drop(draft);                       // closed, files removed
```

A branch is opened with the options you give it (the schema it should run
with, hooks, a logger); its `sync` gets `retention: { ops: 0 }`, so every
op stays for the merge back, and `autoStart: false`, so it dials nobody
until told. The fork pages the parent's [snapshot](./sync#bootstrap) (or
the tag's) into the branch and adopts the parent's vector, so the branch
knows what it already holds; `branch.json` in its directory names the
parent and the position.

`merge(source, { into })` hands `into` what `source` has that it lacks —
the ops after `into`'s vector, through `applyRemote`, the way a peer's push
lands, so concurrent edits of one record converge by the usual rules and a
second merge has nothing to hand over. The ops keep their origin: a merge
into a parent that dials peers reaches them as the branch's own ops, and a
branch that merged from the parent holds the parent's ops under the
parent's name. A source whose log no longer holds what the other needs
(compaction) — of any stream it carries, a third node's included: a merge
is the other side's one way to those ops — is joined as state instead, its
snapshot pages, then its vector, and the result says `joined: true`; a
merge never reports success over a gap. A `signatures: 'require'` parent
takes a branch's ops: they are signed by the branch's own key.

`branch()` opens a new directory only: a path that holds files already —
another storage, say — is refused (`BRANCH_EXISTS`), and a fork that fails
halfway leaves nothing behind. `drop(branch)` closes it and removes every
file of the known layout, the tags' included; the empty directories stay
(no backend has rmdir). It is the one call here that deletes data, so it
takes only what `branch()` made: a storage with no `branch.json` is refused.
A branch is a branch only here: nothing of it replicates as such, and a
peer sees merged ops like any other.

## Costs

A version is a fold of the record's retained entries: as many `applyOp`
calls as the record has ops in the log, read from memory — the log is held
there — plus the comparison with the present when compaction has run. Fine
for a record with hundreds of ops; a record edited ten thousand times is a
record to reset now and then. A tag costs one catalog file when taken and one
copied record file per record changed after it; the catalog of every tag is
held in memory, so a hundred tags over a hundred thousand records is a cost
to feel, ten tags is not.
