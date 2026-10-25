# Versions and history

Every op a node applies is in its log, so the past of a record is a fold of
the log's entries of it — the same `applyOp` that built the record the first
time, stopped at a version. `history(id)` lists the versions, `get(id, { at })`
reads one back, and both say when the log can no longer vouch for what they
give. The past is the `versions` plugin — `@alexify/syncom/versions`,
registered by `@alexify/syncom/all`: `get(id, { at })`, `history()`, `diff()`
between versions, `restore()` and the tags; without it those throw
`PLUGIN_MISSING`, `stats().tags` is null, and a directory that holds tags
is refused at `open()` (their copies would not be kept). `applyPatches()`
and `compact()` — the present and its patches — are the core's. The examples
on this page assume `open({ plugins: [versions] })`.

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

A fourth form, `{ tag }`, is not a cut of the log: it reads the record's
file as a [tag](#tags) kept it.

Two nodes apart write to one record; A's own write lands in A's log before
B's does. On A, the event id from before B's write arrived gives A's write
alone; the stamp between the two writes gives B's alone (B wrote first by
the clock); A's vector from that moment gives A's write alone, and B's vector
once the two have synced gives both. `history()` on each node lists what
that node applied, in its order. An op this node skipped — a `beforeApply`
that answered `false`, an op invalid under its schema — is no version here;
one held for a newer schema version becomes one, at its own event id, once
the node runs that version.

`history(id, { limit })` lists the newest `limit` versions (50 by default,
`Infinity` for all); `complete` is false when it leaves older ones out, and
`history(id, { limit, before })` with the oldest version's `eventId` pages
back from it — the versions older than that entry. `before` is an event id
of this log (another value is a `TypeError`, one of another incarnation
`HISTORY_GONE` with `reason: 'epoch'`). Each version carries the op's
`eventId`, `seq`, `type`, `origin`, `actor` and `ts`, the `fields` it
changed (removed ones included), and `data` — the record as it read after
the op, through the schema lens and the `afterRead` hook, `null` once
deleted. A read at a version runs `beforeRead` and `afterRead` with `{ id,
at }`, so what redacts the present redacts the past too; `history()` runs
`beforeRead` once with `{ id, history: true }` and `afterRead` per version
it hands out, with that version's event id as `at`.

## What the log can vouch for

The fold is exact — the record as this node held it — while the log holds
every op the node applied to the record. Compaction drops the oldest
segments ([retention](./sync#the-log)), and `storage.log.droppedTs` is the
newest stamp among what went (or among what an open could not read). From
then on a version is exact only when a
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
payload of every entry of the record: `history()` still lists the ops, the
purge among them, with `data: null`, `fields: []` and `scrubbed: true`, and
a version before the purge rejects with `reason: 'scrubbed'`; one after it
is `null`. An encrypted record has no ops and no past: `ENCRYPTED`. An event
id from another incarnation of the log rejects with `reason: 'epoch'`; a seq
the log has not reached, or an `at` of the wrong shape, is a `TypeError`
with `code: 'INVALID_VERSION'`.

`storage.log.pin(keep)` holds the log's segments past retention for a reader
that needs them — an undo stack, a long-running comparison: an entry
`keep(entry)` answers true for stays, with its segment and everything after
it, until the function `pin()` returns is called.

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
await v1.has(id);                              // true
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
there is no file of it to copy from until it lands. Under
[`open({ defer })`](./storage), where a local write's file waits for the
window, `tag()` lands the waiting files first, so the tag's catalog and the
files agree; a record written after the tag whose file still waits reads at
the tag from that file — still the tag's state — and the copy is taken when
the file lands. A purge reaches the tags:
every copy of the record goes and every tag's catalog forgets its row,
indexed values included, so `at(name).has(id)` is false and `get` is `null`.
The read hooks run with `at: { tag }`.

A tag is the whole storage, not one record: `at(name).list()` is every live
id then, `at(name).collection('Post')` queries the collection as it was —
`select()` and `count()` over the tag's own catalog, each row read from its
copy or from the record as it is — and `at(name).snapshot()` pages the
storage as it was, the way [`snapshot()`](./sync#bootstrap) pages the
present, so another storage can `mergeSnapshot()` them and stand at the tag.
A cursor at a tag has no `watch()` (a tag does not change; it throws) and
no `$text` (its catalog carries no text index; `select()` with one is a
`TypeError`).

```js
// storage and other opened with schema: { entities: { Post: { index: ['n'] } } }
const posts = storage.at('v1').collection('Post');
await posts.select({ n: { $gte: 2 } }).order('n').fetch(); // as of v1
await posts.count();                                         // as of v1
await storage.at('v1').list();                               // every live id as of v1
const page = await storage.at('v1').snapshot();              // { records, cursor, eventId, vector }
await other.mergeSnapshot(page.records);                     // another storage, now at v1
await other.adoptVector(page.vector);
```

Tags are this node's: they live under `tags/` next to the data, name a
position in this node's log, and do not replicate — a peer that needs the
same version takes its own tag. `tag()` runs in the mutation queue, so no
write lands between the catalog and the position it names; a name is of the
record-id form (another is a `TypeError`; a name in use is `TAG_EXISTS`,
with `tag`), and so is every name `tags.json` holds — a line of another
name is dropped at open, with a warning, never read as a path. A directory
a crash left under `tags/` without its line in `tags.json` is unknown to
every reader and is swept when a tag of that name is taken again.

An open reads `tags.json` and the newest tag's catalog — the one the write
path copies into — and an older tag's catalog when the tag is first read,
so an open costs one catalog however many tags there are. `at(name)` reads
nothing: it throws `TAG_NOT_FOUND` for a name this node has not, and the
view's first read — `get`, `has`, `list`, a cursor's `fetch` or `count`,
`snapshot` — reads the catalog, which is why `has()` and `list()` are
promises. A tag whose catalog file is gone is dropped then (the newest at
open) as `untag()` would drop it — the copies the older tag needs move there
— with a warning, and the read that found it gone rejects with
`TAG_NOT_FOUND`. An unreadable `tags.json` does not stop the open: the tags are
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
const id = await storage.insert({ title: 'Draft' });
await storage.tag('v1');
await storage.update(id, { title: 'Final' });
await storage.inc(id, 'views', 1);

await storage.diff(id, { tag: 'v1' });
// [{ action: 'put', field: 'title', value: 'Final' },
//  { action: 'inc', field: 'views', value: 1 }]
await storage.applyPatches(id, [{ action: 'inc', field: 'views', value: -1 }]); // 1 — one op
await storage.restore(id, { tag: 'v1' });     // 1 — a write, since the counter has to go
await storage.get(id);                        // { title: 'Draft' }
```

A patch is plain JSON in the terms of the write API, one per field by its
kind: `put` (a register's new value — a `set`), `inc` (a counter's delta),
`add` and `remove` (a set's elements — `remove` with `elements` takes the
adds this node observed, with `own: true` this node's adds alone, the way an
undo revokes its own add and leaves a peer's concurrent one, with `removals`
exactly the tags named), `splice` (a text's
or a list's edits, by Myers), `treeMove` and `treeRemove`, `unset` (a field
removed, of any kind), `write` (the registers as a whole — a reset; only for
a record that was not there), `delete`, `purge`. A field that is gone is an
`unset`; one that changed kind an `unset` and the kind made again whole. A
text's marks are not diffed. The diff reads both versions through the schema
lens, raw, without the read hooks, and rejects as `get(id, { at })` would
for either version.

`applyPatches(id, patches, { actor, source })` realizes a list in one turn
of the mutation queue and resolves to how many ops it took; `restore(id, at,
{ actor, source })` is `applyPatches()` of `diff(id, undefined, at)`. A patch
is checked as the method of its name checks its arguments — the wrong shape
is a `TypeError` and nothing is written — and every patch is first resolved
and applied over a scratch record, so an index out of range, a kind clash, a
cycle, a sibling not there or a type change refuses the whole list, with the
error the method would have thrown (`OUT_OF_RANGE`, `FIELD_KIND`, `CYCLE`,
`NOT_FOUND`, `TYPE_IMMUTABLE`), before anything is appended: a restore lands
whole or not at all. The patches then land as one
[transaction](./storage#transactions): the hooks and the validator run on
each op as it is made, and one that throws on a later op rejects the call
with its error and leaves nothing written — no version in `history()`, no
op on its way to the peers.

## Changes

Every op announced — a `change` event's third argument, a `commit` event's
`changes`, a `transaction` event's `changes` tagged by record — carries what
the reading shows of it, in the write API's terms and the reading's indices:

```js
storage.on('change', (op, via, { changes }) => { … });
// a keystroke:     [{ action: 'splice', field: 'body', index: 5, count: 0, content: 'x' }]
// a cut:           [{ action: 'splice', field: 'body', index: 3, count: 2 }]
// update():        [{ action: 'put', field: 'title', value: 'Final' }]
// inc():           [{ action: 'inc', field: 'hits', value: 1 }]
// add():           [{ action: 'add', field: 'tags', elements: ['x'] }]
// setAt(), move(): [{ action: 'setAt', field: 'items', index: 1, value: 'b' }], [{ action: 'move', field: 'items', from: 0, to: 2 }]
// mark():          [{ action: 'mark', field: 'body', start: 0, end: 5, name: 'bold', value: true, markId }]
// treeMove():      [{ action: 'treeMove', field: 'outline', node: 'b', parent: 'r', after: 'a' }]
// set():           [{ action: 'put', … }, { action: 'unset', field: 'old' }]
// delete():        [{ action: 'delete' }]
```

A splice's cuts are in the indices before the op (last first), its insert in
the indices after; a mark over the indices its anchors fall at; a tree move
names the node, its parent and the sibling before it, and the nodes that
followed it where it was and where it is. A field changed another way — reset
by a whole-record write, outranked by another kind, pruned under a prefix,
joined from a snapshot — reads as `{ action: 'reset', field, kind, value }`
with its whole value, or `{ action: 'unset', field }` when it went. Applied
to the reading before the op, in order, the changes give the reading after —
what a view or an editor binding updates itself by without re-reading the
record. They are computed as the op is applied, from the block it lands in
(a splice's indices in O(log n)), never by diffing two readings; a peer's op
reports what it changed *here*, which is less than it changed where it was
made when a concurrent op had already taken part of it.

## The commit event

```js
storage.on('commit', ({ op, seq, txn, source, before, after, kinds, changes }) => { … });
```

Every local write — a call of the write API, a `Record`'s `save()`,
`applyPatches()`, `restore()`, `compact()` — raises `commit` once its op is
durable: the op, its seq in the log, `txn` (the seq of the first op of the
transaction it was made in — its own for a single write), the `source` (the
`Record` whose `save()` it was, or what `transact()`/`applyPatches()` was
given; `null` otherwise), the record `before` and `after` as copies of what
is stored (no lens), every field's `kinds` (`register`, `counter`, `set`,
`list`, `text`, `tree` — of the fields there before and after) and its
[`changes`](#changes). It is what an undo stack keeps; the
copies are made only while something listens. A peer's op raises `change`,
not `commit`, and so do the `merge` and `advance` ops a joined snapshot
leaves (`mergeSnapshot()`, `adoptVector()`); an encrypted write makes no op
and raises neither — nor does a tree move to where the node already is,
which makes no op.

## Undo and redo

`@alexify/syncom/undo` is an undo stack over one node's own writes, built
on the [commit event](#the-commit-event) and [patches](#diff-and-restore):

```js
import { createUndo } from '@alexify/syncom/undo';

const id = await storage.insert({ title: 'Draft' });
await storage.inc(id, 'views', 1);
const undo = createUndo(storage, { mergeInterval: 500, limit: 100 });
await storage.update(id, { title: 'Final' });
await storage.inc(id, 'views', 1);          // within 500 ms of the update: one step
await undo.undo();                           // { applied: 2, skipped: 0 } — { title: 'Draft', views: 1 }
await undo.redo();                           // { applied: 2, skipped: 0 } — { title: 'Final', views: 2 }
undo.mark();                                 // the next write starts a new step
undo.canUndo; undo.canRedo; undo.size;       // true, false, { undo: 1, redo: 0 }
undo.stop();                                 // also on storage.close()
```

Every commit of the storage's own joins the current step — per record,
how the step found it and how it left it; the patches that take it back are
made when it is undone — commits within `mergeInterval` of the step's first
merge into it, `mark()` closes a step by hand, a new write clears the redo
stack, and `limit` steps are kept, the oldest dropped first. An undo applies
a step's patches through `applyPatches()` — new ops, so it merges like any
write and a peer sees it as one — and what those ops commit is the redo
step. The rule is Yjs's, refuse to overwrite: a field anything but the
step's own ops changed since — a peer's write, a write of this node's the
stack does not hold — is left alone and counted in `skipped`, and a step
whose way back is the whole record (an `insert()`, whose way back is a
delete; a `delete()`, whose way back writes the record again) is skipped
whole when anything else changed the record since; `undo({ force: true })`
overrides. A skipped patch goes with its step — the
redo step holds only what was applied — so `force` is chosen up front, not
as a retry. What commutes is no conflict: a peer's increment of
the same counter, or add to or remove from the same set, leaves the undo
free; a peer's edit of the same list or text does not (the undo's positions
are stale by then). A field the step created is `unset` again when nothing
else changed it since; with a peer's change beside it the undo takes a
counter down, removes this node's set elements, or leaves a list, a text or
a tree alone instead, so the peer's change stays. An undone `add` removes this node's adds of the element
alone, so a peer's concurrent add of it survives; an undone `inc` is the
increment back; a text comes back as new characters. A text's marks are not
undone. An undo that fails partway — a hook refusing one record's inverse,
say — leaves the records it took back taken back, with their way back on the
redo stack, and the rest on the undo stack for another try, so a record is
not inverted twice. Within one record a hook or a validator that refuses a
later op of its inverse leaves nothing of that record applied (the
[`applyPatches()`](#diff-and-restore) rule: one transaction per record), so
the record waits on the undo stack whole, for another try.

`createUndo(storage, options)` also takes `scope` — only the ops of that
scope (`'*'` the global one) — `exclude(op)` — ops to leave out — and
`actor`, the actor the undo's own ops carry. The manager is an emitter:
`push` (`{ direction: 'undo', records }`) when a commit joins the stack,
`pop` (`{ direction, applied, skipped }`) when an undo or a redo is done,
`change` after either. The stack is this process's: nothing of it is
written, a peer's ops are never undone from here, and a `purge` forgets its
record on every step. The manager pins the log from the oldest step it holds
(conflicts are read from the log's entries), so a long stack holds segments
past retention until `clear()` or `stop()`.

A [transaction](./storage#transactions)'s commits are one step whatever the
interval, and `group(fn)` — or `groupStart()` … `groupEnd()` — makes one of
everything committed while `fn` runs. Every step carries `meta`, an object
of the application's: put there on `push`, read back on `pop`, carried to
the redo step and back — the way an editor keeps its selection across an
undo, as [cursor tokens](./lists#cursors) that `position()` restores:

```js
let selection = null;                                 // the caret, as a cursor token, before each edit
const undo = createUndo(storage, {
  trackedSources: ['editor'],                         // the editor's transactions alone
  paths: ['body'],                                    // its field alone: a title change is not undone here
  onPush: ({ step }) => { step.meta.selection ??= selection; },
  onPop: async ({ step }) => {
    const at = await storage.position(id, 'body', step.meta.selection);
    if (at !== null) editor.setSelection(at.index);
  },
});
selection = await storage.cursor(id, 'body', editor.getSelection().index);
await storage.transact((tx) => tx.splice(id, 'body', 5, 0, ' there'), { source: 'editor' });
```

`trackedSources` keeps the stack to commits whose `source` is one of them (a
transaction's, a `Record`'s save), `records` to these ids (or a predicate on
the id), `paths` to these fields and what hangs under them: a step's inverse
then keeps to those fields, and a whole-record change — an insert, a delete
— is not the manager's business. A write at a prefix of a step's field, or
under it, counts as a change of the field. `steps` lists the steps each
way, `{ id, meta, records, at, source, message, txn }` each.

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
with, hooks, a logger), on the parent's `fsi` unless they name another; its
`sync` gets `retention: { ops: 0 }`, so every op stays for the merge back,
and `autoStart: false`, so it dials nobody until told. The fork pages the
parent's [snapshot](./sync#bootstrap) (or the tag's) into the branch and
adopts the parent's vector, so the branch knows what it already holds; what
lands on the parent while the pages go out is caught up as ops, so a branch
of the present stands at one cut. `branch.json` in its directory names the
parent and the position — what `branchInfo()` reads back, and `null` for a
storage that is no branch.

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
takes only what `branch()` made: a storage with no `branch.json` is refused
with a `TypeError` and keeps its files. `merge()` of a storage into itself
is a `TypeError` too.
A branch is a branch only here: nothing of it replicates as such, and a
peer sees merged ops like any other.

## Costs

A version is a fold of the record's retained entries: as many `applyOp`
calls as the record has ops in the log, read from memory — the log is held
there — plus the comparison with the present when compaction has run.
`history()` folds them all too, whatever its `limit`, and reads through the
lens and `afterRead` only the versions it hands out: paging saves the reads,
not the fold. Fine for a record with hundreds of ops; a record edited ten
thousand times is a record to reset now and then. A tag costs one catalog
file when taken and one copied record file per record changed after it; an
open reads the newest tag's catalog alone, and every catalog read since —
the newest, and each older tag a reader used — stays in memory, so reading
a hundred tags over a hundred thousand records is a cost to feel, ten tags
is not. A purge reads every tag's catalog, to forget the record there.

A record whose past has grown — a tree moved thousands of times keeps every
move, a text typed into from many places keeps a run per place, a field
deleted from keeps its tombstones — is rewritten by `compact(id, { actor,
source })`: a whole-record write of the registers and one op per field of
another kind (an `inc`, an `add`, a text or a list as one run, a tree as one
move per node), so what lies under it goes by the reset rule on every node,
and the record's fields read as they did. It resolves to how many ops it
took — `0` for a record that is not there, `ENCRYPTED` for an encrypted
one — and is a whole-record write like any other: a peer's op stamped
before it and arriving after it is dropped by the reset, and a peer's typing
stamped above it that was anchored in the old runs reads from the head (see
[How it merges](./lists#how-it-merges)). A text's marks are laid again over
the new run, in the order they were made and with the expand rule their
anchors had, so `spans()` reads the same; a counter at `0` stays a counter;
a text or a list longer than one run (1 048 576 elements) is made again in
runs of that size. Two things it cannot keep, because it names every
element anew: the cursors into its texts and lists, which named the old
elements and read `null` afterwards, and the ids of stacking marks, which
are new (`spans()` hands them out). And a list, a text, a set or a tree that
reads empty is left out of the record: no op makes an empty one. A
`restore()` whose diff is a reset makes texts again without their marks —
`diff()` does not diff marks.
