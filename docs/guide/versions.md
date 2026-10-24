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
is taken again; an unreadable `tags.json` refuses the open (`CORRUPT`), and a
tag whose catalog file is gone is dropped at open with a warning.

## Costs

A version is a fold of the record's retained entries: as many `applyOp`
calls as the record has ops in the log, read from memory — the log is held
there — plus the comparison with the present when compaction has run. Fine
for a record with hundreds of ops; a record edited ten thousand times is a
record to reset now and then. A tag costs one catalog file when taken and one
copied record file per record changed after it; the catalog of every tag is
held in memory, so a hundred tags over a hundred thousand records is a cost
to feel, ten tags is not.
