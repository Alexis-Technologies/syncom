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

## Costs

A version is a fold of the record's retained entries: as many `applyOp`
calls as the record has ops in the log, read from memory — the log is held
there — plus the comparison with the present when compaction has run. Fine
for a record with hundreds of ops; a record edited ten thousand times is a
record to reset now and then.
