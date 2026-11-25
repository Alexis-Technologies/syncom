---
title: Performance tips
description: Practical ways to make syncom faster, from batching writes and the defer window to indexes, live queries, the cache, the chain, signing and log retention.
---

# Performance tips

Most apps never need to tune syncom: a local-first database holds the records of one user or one team, and the
defaults are chosen for that. When a screen feels slow or an import takes too long, the tips below are the ones
that change something, each with the reason it helps. The examples continue the task board of the
[Quickstart](./quickstart), opened with an index the queries below use:

<<< @/examples/performance-tips.mjs#open

Measured numbers on this page come from syncom's own benchmarks ([Engine performance](./storage-performance));
measure your own workload before and after a change, as the last section shows.

## Group related writes in a transaction

<<< @/examples/performance-tips.mjs#transact

Every write is an op appended to the [operation log](./operation-log) before its record lands in the storage. A
transaction appends all its ops as one group, lands its records as one write set (one storage transaction on
IndexedDB and SQLite, and on MongoDB with `transactions: true`) under one chain block, and writes each record
once (inside `transact()` every write goes through `tx`, and an insert names its collection with `$type`). The
same three inserts awaited one by one are three groups in the log. A transaction is also all or nothing, which
is usually the reason to reach for it; [Transactions and conflicts](./transactions-conflicts) covers that side.

## Write many records with one bulk call

<<< @/examples/performance-tips.mjs#bulk

`bulkInsert()`, `bulkUpsert()` and `bulkRemove()` are each one transaction with a verdict per row: the rows that
can be written are, and each refused row comes back in `error` with its index and the error it would have
thrown alone. One call takes at most 10,000 rows (a larger one is a `TypeError` before anything lands), so page
a larger import into calls of that size. [Collection](./collection) has the details.

## Keep writes in flight instead of awaiting each one

<<< @/examples/performance-tips.mjs#pipeline

Writes run in the order you make them, and each promise resolves once its write has landed. Awaiting every write
before making the next means each one waits for the one before it to reach the storage. Writes to records already
in memory, made without waiting, join the group the log is gathering while the previous group is written, so a
burst costs the storage a few writes instead of one each. New records are different: each insert first asks the
storage whether its id is free, so a burst of inserts belongs in a transaction or a bulk call. In the Write path
benchmark, keystrokes at the end of a text ran about 109,000 times a second awaited one by one and about 285,000
times a second with 1,024 in flight. Use `Promise.allSettled()` instead of `Promise.all()` when you need to know
which writes failed.

## Let the defer window merge writes to one record

<<< @/examples/performance-tips.mjs#defer

A write is durable once its op is in the log; the record and its chain block may follow. With `defer` (16 ms by
default, one frame) they wait that long, so all the writes of one record within the window land as one record
and one block, and every record due lands in the same write set. Reads see each write at once from memory, and a
crash before the landing is replayed from the log at the next open. `flush()` lands everything now; `close()` and
`tag()` do it first. In the Lists and text benchmark, one character pushed into a 10 KB text ran about 9,000
times a second with `defer: 0` and about 18,800 with the default window.

A longer window merges more writes but keeps record files behind the log for longer, which other tabs following
an [IndexedDB](./storage-indexeddb#open-the-same-database-in-several-tabs) database notice: they see a write
once its record has landed. `defer: 0` writes the record with every op, which only code that reads the record
files itself needs.

## Keep the write path free of what you do not need

A write to a record that is already in memory is made at once, without waiting for a turn of the database's
write queue, when nothing asynchronous stands in its way: no `beforeWrite` or `afterWrite` [hook](./hooks), no
signing, no telemetry, no `actor` function, no schema lens, a `defer` above 0, and a collection without a
validator or unique keys. Each of those is worth having where you need it, and each one sends every write
through the queue. `@alexify/syncom/all` registers signing, so register [only the plugins you
use](./install#pick-only-the-plugins-you-need) when writes are the hot path. `stats().commits` counts how
local writes were made: `fast` (at once), `queued`, and `coalesced` (a keystroke folded into the op before it).

## Know what signing costs

With the [signing](./signing) plugin, every op this node makes is signed with Ed25519 before it is appended,
and every signed op a peer sends is verified before it is applied (in Node.js, many at a time on the thread
pool). In the Apply benchmark one verification took about 28 µs. Keep signing on wherever nodes should not have
to trust each other or the network. A deployment where every node is yours can open with
`sync: { signatures: false }`, or leave the plugin out, and save that work.

## Skip the chain on a node nobody audits

<<< @/examples/performance-tips.mjs#hub

The [chain](./chain) adds a hash-linked block to every landing and verifies a record against its block when the
record is read cold. A hub that only replicates has nothing to audit: `chain: false` drops the block and the
chain's tail from every landing (two files fewer on the files engine, two rows fewer in the write set elsewhere),
and `validate()` rejects with `ALX_ERR_NO_CHAIN`. In the Apply benchmark, a peer's page of 100 field writes on cached
records applied at about 8,900 ops a second with the chain and about 10,200 without. The core alone, without
`@alexify/syncom/all` or the chain plugin, has no chain to turn off.

## Trust record files on a cold read

<<< @/examples/performance-tips.mjs#lazy

A cold read, of a record that is not in the cache, re-verifies the record against the chain block that committed
it: the block is read and hashed once for all the records of its batch, and each record is hashed once.
`integrity: 'lazy'` trusts the record file instead while keeping the chain, which suits a browser that rebuilds a
large catalog or reads many records cold. It changes nothing without the chain.

## Index the fields you filter and sort on

<<< @/examples/performance-tips.mjs#explain

A collection's `index` declares the keys the catalog keeps sorted in memory, on every engine. A query with
equalities on a key's first fields, then a range or a sort on the next one, reads only the window it returns
(`sortedByIndex`). A query no index serves reads every record of the collection, from the cache or the storage,
and tests each one. Put the equality fields first in a compound key, then the field you sort or range on.

<<< @/examples/performance-tips.mjs#covered

When the query's fields, its order and its projection are all indexed, the query is covered and the catalog
answers it alone, without reading a record. [Query optimizer](./query-optimizer) shows how the planner chooses.

## Find the indexes your queries need

<<< @/examples/performance-tips.mjs#advisor

`indexAdvisor()` from `@alexify/syncom/inspect` watches the plans of every query from the moment you start it
and suggests the keys that queries asked for and no index served, the most asked first. Run it in development or
in your tests, then add the suggestion to the collection's `index`. A changed index set rebuilds the catalog once,
at the next open.

## Watch a query instead of polling it

<<< @/examples/performance-tips.mjs#watch

A live query is kept, not run again: when a write lands, the record that changed is read once, matched and
placed in the result, and the listener hears only when the rows changed. Every `watch()` of the same query shares
one run, a `fetch()` of a watched query reads nothing, and up to a hundred results stay cached after their last
watcher stops, each for as long as its collection does not change. [Query cache](./query-cache) and
[Reactivity](./reactivity) cover both.

## Fit the cache to your working set

<<< @/examples/performance-tips.mjs#cache

The cache keeps the last `cache.max` records read or written (5,000 by default) and evicts the oldest; a record
with a live [document](./document) is never evicted. A read that misses goes to the storage, and with the chain
on it verifies the record as well. Raise `cache.max` when a session reads more records than that, and check
`stats().cache` for `size`, `max` and `pinned`. The memory it costs is the records themselves.

## Bound the log with retention

<<< @/examples/performance-tips.mjs#retention

The log keeps the ops it retains in memory, and an open reads them all. `sync.retention` sets the window
(`ops`, and `days` if you want an age limit), and the oldest segments go once the log holds more. A smaller
window means less memory and a faster open, but a peer that falls further behind than the window has to
[bootstrap](./replication), and a node that dials still keeps its own ops until its hosts have them.
`retention: 'all'` keeps every op for exact history and grows without bound. [Retention and
acknowledgements](./retention) explains the trade.

## Compact records with a long history

A record keeps what its fields merged from: a text typed from many places keeps a run per place, a list reordered
often keeps its old slots, a tree keeps every move. All of it is stored with the record and read back with it,
and the first edit after a cold read rebuilds the field from it. In the Lists and text benchmark, the first op on
a record with 20,000 edits behind it, read from its JSON, took about 62 ms. `compact(id)` rewrites the record as
it reads today; do it when nobody is editing the record, since cursors into its lists and texts read `null`
afterwards ([Health and maintenance](./health#rewrite-a-record-that-has-grown)).

## Keep large binary data out of records

A record is JSON, read and written whole. Images, PDFs and recordings belong in
[attachments](./attachments): the bytes go into the engine's blob store under their digest, the record carries a
small field naming them, and a peer fetches the bytes only when it reads them.

## Keep the open fast

An open reads the catalog back and catches up from the log, or rebuilds the catalog by reading every record
when it cannot. Close the database so the catalog is saved, keep the index set stable, and retain the log you
need. [Faster open](./open-cost#make-an-open-faster) shows how to measure an open and what each option saves.

## Move work off the page's thread

In a browser, the storage work can run in a [worker](./storage-worker) while the database stays on the page, or
the whole database can live in a worker ([OPFS](./storage-opfs#run-the-database-in-a-worker)). Several tabs
over one database share it through a [SharedWorker](./storage-shared-worker) or
[leader election](./leader-election) instead of each opening its own.

## Measure what a change buys

<<< @/examples/performance-tips.mjs#measure

`stats()` reads from memory and does no I/O. Besides `commits` and the engine's `writes` (and `ms`, the time its
write sets took), it reports the records waiting for the window (`deferred`), the writes between
the log and the storage (`inflight`) and the log's size; [Health and maintenance](./health) lists every field.
To compare storages or builds, run the repository's benchmarks ([Engine performance](./storage-performance)).

## Coming from RxDB

Several of RxDB's tips carry over unchanged: bulk writes, indexes that match the query with equalities first,
queries kept live instead of re-run, attachments for large data, work moved to a worker, and fewer hooks. What
syncom adds is the transaction, which batches writes across records, and the defer window, which merges writes to
one record without your help. What it lacks is a way to force an index; the planner picks the one expected to
read the fewest records, and `explain()` shows its choice.

<FromRxdb page="nosql-performance-tips" :rows="['bulk', 'transactions', 'coveredQueries', 'queryOptimizer', 'queryCache', 'liveIncremental']" />
