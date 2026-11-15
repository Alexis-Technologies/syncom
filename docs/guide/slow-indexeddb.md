---
title: IndexedDB performance
description: Why IndexedDB is slow for many small writes, how syncom keeps the number of IndexedDB transactions down, and what to do when it is still too slow.
---

# IndexedDB performance

Someone types a paragraph into the notes of a task. Each keystroke is a write, and if each write were an
IndexedDB transaction of its own, the browser would schedule, commit and acknowledge one per key pressed. That is
where IndexedDB is slow: the cost is per transaction and per request, more than per byte. Every transaction is a
round of the browser's storage machinery, every request answers through an event, and every value is copied
with the structured clone algorithm on its way in and out. A store that reads by walking a cursor pays one
request per record.

syncom treats IndexedDB as a place to land work that is already batched. This page shows what a database spends
on IndexedDB for each pattern of writes, and what to change when it is still too much.

## OPFS first, IndexedDB by choice

In a browser a database opens on [OPFS](./storage-opfs) unless you choose another storage, so an app that never
picks one never pays IndexedDB's transaction costs. OPFS has costs of its own: each record is a file, and each
group of ops in the log is a small file, since OPFS cannot append to one. Choose
[IndexedDB](./storage-indexeddb) when several tabs open the same database, when a database holds many records,
or when OPFS is not available. The repository has no browser measurement of the two, so if speed decides,
measure your app on both ([Browser storage compared](./browser-storage)).

## What a write costs

<<< @/examples/slow-indexeddb.mjs#open

<<< @/examples/slow-indexeddb.mjs#typing

<FigIdbWritePath />

Every write is first an op appended to the [operation log](./operation-log), and an awaited write is durable once
its group of ops is in the log: on IndexedDB, one readwrite transaction over the `log` store. The record itself
waits for the [defer window](./performance-tips#let-the-defer-window-merge-writes-to-one-record) (16 ms by
default). Every write to the record within the window lands once, and every record due lands in the same write
set, which the IndexedDB engine writes as one readwrite transaction over the stores it touches. Ten awaited
keystrokes cost ten small log transactions and one record transaction; with `defer: 0` they cost twenty.

Inside a transaction the engine queues every request before its first `await`, so IndexedDB never commits it
early, and calls `commit()` where the browser has it instead of waiting for the transaction to go idle. A record
is stored as a structured clone of the object it was handed, with no JSON text made or parsed.

## Batch the writes you can

<<< @/examples/slow-indexeddb.mjs#batch

A [transaction](./transactions-conflicts) or a bulk call appends all its ops as one group and lands all its
records as one write set: two readwrite transactions however many records it holds. Writes to records already in
memory that you make without awaiting each one share log groups too, so a burst of edits costs a few log
transactions ([Performance tips](./performance-tips#keep-writes-in-flight-instead-of-awaiting-each-one)).

An insert also asks the engine whether its id is free, which on IndexedDB is at least one small read-only
transaction per new id, in a bulk call too. Keep that in mind for imports of many records: the batch saves the
writes, not those reads.

## Read from memory, not from IndexedDB

<<< @/examples/slow-indexeddb.mjs#catalog

syncom does not use IndexedDB's indexes or cursors for queries. Every record's id, collection and indexed values
live in the catalog in memory, recent records in a cache, and the retained log in memory too. `list()`, a
`count()` by indexed fields and a covered query read no store at all. A query that needs records reads the ones
not in the cache, up to sixteen at a time. Where the engine does list (the ids during a catalog rebuild, the log
at open, a tag's copies) it asks once for a whole key range with `getAll` or `getAllKeys`, never walking a cursor.

The catalog is saved back to IndexedDB as one value, off the write path: every 64 changes while it is small,
then every sixteenth of its size, and at `close()`, so a save costs each write a small share of a row.

## Relax durability where you can lose a write

<<< @/examples/slow-indexeddb.mjs#relaxed

`durability` is the hint every transaction of the engine passes to IndexedDB. `'relaxed'` lets the browser report
a transaction complete before its data reaches the disk, which is faster; a power cut can then lose the last
writes that had been reported done. `'strict'` asks for the disk every time. The default leaves it to the browser.

## Move the work into a worker

Even batched, IndexedDB work and the copying of records run on the thread that calls them. Serve the engine from a
[worker](./storage-worker), and the page keeps the database and its queries while every IndexedDB call runs in
the worker. Every engine call then crosses the port as a message, so measure with your data first.

## Trade-offs

- **An awaited write is still a transaction.** The log append is the commit point, so a write that you await
  costs one log transaction even when its record waits for the window.
- **The window is a lag, not a loss.** A record lands up to `defer` ms after its write resolved. A crash in
  between is replayed from the log at the next open; a tab following the database read-only sees the write once
  the record has landed.
- **The file store is the slow way in.** `createIdbFsi()` keeps each file of the files engine as a row and spends a
  transaction per file. A memory layer above it with [`layered()`](./storage-layered) answers reads from memory
  and can write back from a queue, but what the queue holds is lost with the tab; prefer `idbEngine()`.

## Coming from RxDB

RxDB's article on slow IndexedDB lists the remedies of its Premium IndexedDB storage: batched cursors, sharding,
custom indexes, relaxed durability, explicit commits and a memory layer. syncom's engine is free and covers most of
them by design: it reads key ranges whole instead of walking cursors, keeps its indexes in memory rather than in
IndexedDB, commits explicitly and takes a `durability` hint, while the catalog and the cache are the memory layer.
It does not shard one database across several IndexedDB databases.

<FromRxdb page="slow-indexeddb" :rows="['indexeddb', 'opfs', 'indexStorage', 'durability', 'worker']" />
