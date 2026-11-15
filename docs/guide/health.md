---
title: Health and maintenance
description: Read a node's health with stats(), check storage room and eviction, land pending writes, repair a damaged record and rewrite one that has grown.
---

# Health and maintenance

A syncom database looks after itself in normal operation: the log rolls and compacts, files land after the
log, the catalog is saved in the background. This page covers what you check when something seems off, and
the few things you do by hand: reading the node's numbers, asking for storage room, repairing a record that
fails its check, and rewriting a record whose history has grown heavy.

## Read the node's numbers

<<< @/examples/health.mjs#stats

`stats()` answers from memory, with no I/O, so you can call it as often as you like, from a health endpoint
or a debug panel. The numbers worth knowing:

| Field | What it tells you |
| --- | --- |
| `queue` | Writes waiting on, or running in, the write queue. A number that keeps growing means writes come faster than they land. |
| `inflight` | Local writes appended to the log and not on disk yet. |
| `deferred`, `held` | Records whose file lags the log: `deferred` within the [deferred window](#land-what-waits), `held` also after a file write that failed. |
| `log` | The log's length, segments and floor; `appendFailures` and `rollFailures` since the open; `droppedTs`, the newest stamp the log no longer holds; `pins`, readers holding old segments (an undo stack, mostly). |
| `cache`, `catalog` | The record cache (`size`, `max`, `pinned` by live documents) and the catalog's rows, tombstones included. |
| `tags` | How many [tags](./versions#name-the-whole-database-with-a-tag), and `corrupt` when `tags.json` could not be read at open. |
| `chain` | The audit chain's tail hash, or `null` without a [chain](./chain). |
| `lock` | How the database is held, and `lost` once a MongoDB lease went to another instance (the database is read-only from then on). |
| `engine` | The storage engine's name, capabilities and the count, failures and time of its write sets. |

The sync manager adds its own view: `db.sync.peers()` reports each dialed peer (connected, `pending` ops,
`behind`, `stuck`, `lastError`), and `db.sync.hosted()` the peers that follow this node. The
[telemetry](./telemetry) gauges carry the same numbers to a dashboard.

## Land what waits

A local write is durable once its op is in the log; the record file comes after. By default a record's file
waits up to 16 ms (the `defer` option), so a burst of writes to one record lands as one file:

<<< @/examples/health.mjs#flush

`flush()` lands the writes in flight and then the deferred files. `close()` does the same before it closes.
Every read sees a write right away regardless; the window only delays the file. `defer: 0` writes every
file at once, for a process that may be killed between a write and the next frame.

When a file write fails (a full disk, a quota), the write is not undone, since it replicates from the log
already. The record is held in memory until the next open, which replays it onto the file, and the
database emits an `error` event with `code: 'UNPERSISTED'` and the `ids`. `stats().held` counts such
records.

## See how much room is left

<<< @/examples/health.mjs#quota

`quota()` asks the storage medium: the memory, SQLite and IndexedDB engines estimate their own `usage`, the
files engine reports the volume's `quota`, and either is `null` where the medium says nothing. In a browser,
`persist()` asks the browser to keep this origin's storage out of eviction (`navigator.storage.persist()`)
and resolves to whether it will; where there is nothing to ask, as in Node.js, it resolves `true`. An
`UNPERSISTED` error that carries `quota: true` means the medium is full: the moment to check `quota()`.

## Repair a record that fails its check

A record file whose data no longer hashes to what its [chain](./chain) block recorded, or that no longer
parses (a write torn by a crash), rejects every read with `INTEGRITY`. It stays that way until you act,
because a file that changed under the chain is evidence first:

<<< @/examples/health.mjs#repair

`repair(id)` rebuilds the record from this node's own log: it replays the retained entries of the id from
the first whole-record op among them (a `write`, a `merge`, a `delete` or a `purge`), and writes the result
the usual way, with a chain block of its own. The result is what a peer replaying this log would hold, the
same fold [`history()`](./versions) reads. A record the log cannot rebuild, because its whole-record op was
compacted away, it was never written here, or it is encrypted (an encrypted record has no ops), rejects with
`UNRECOVERABLE`; a peer that still holds the record is the way back then, through a
[bootstrap](./replication).

## Rewrite a record that has grown

A record keeps what its fields merged from: a text typed into from many places keeps a run per place, a list
reordered often keeps its old slots, a tree keeps every move of every node, a deleted range leaves
tombstones. `compact(id)` rewrites the record as it reads today:

<<< @/examples/health.mjs#compact

It writes the record's registers as one whole-record write, then one op per field of another kind (an `inc`
per counter, an `add` per set, one `splice` per list or text, one move per tree node), so everything under it
goes by the reset rule, on this node and on every peer the ops reach. The record reads the same, and a
text's marks are laid again so `spans()` reads the same too.

What it cannot keep is the identity of the elements: every [cursor](./text#keep-a-caret-where-it-belongs)
taken before reads `null` afterwards, and a stacking mark gets a new id. A list, a text, a set or a tree that
reads empty is left out, because no op makes an empty one. And like any whole-record write, it drops a
peer's op stamped before it that arrives after it; a peer's typing stamped after it but anchored in the old
runs reads from the start of the field. So compact a record when it is quiet, not while people are editing
it. `compact()` resolves to how many ops it took, `0` for a record that is not there, and rejects with
`ENCRYPTED` for an encrypted record.

## Check the audit chain

`validate()` walks the [audit chain](./chain) and answers whether every block still hashes to what links
it; `validate({ last })` bounds the walk. Run it on a schedule if your data is an audit trail.

## Coming from RxDB

RxDB leaves these checks to the storage underneath it, and its cleanup plugin removes old deleted documents.
syncom keeps its own numbers in `stats()`, can tell a damaged record from a good one through the chain, and
rebuilds it from the log; tombstone cleanup is the [cleanup](./cleanup) plugin.
