---
title: Worker
description: Run a database's storage engine in a Web Worker or a Node.js worker thread and open the database from the main thread over the worker's port.
---

# Worker

Reading and writing storage costs time on the thread that does it. In a browser, IndexedDB calls and the copying
of records are work the page could spend on rendering; in Node.js, SQLite through `node:sqlite` is synchronous and
blocks the event loop for every statement. Put the engine in a worker and that work runs there, while your code
and the database stay on the main thread and reach the engine over the worker's port. The mechanism is the
[remote engine](./storage-remote): the worker serves the engine, the main thread connects to it.

<FigRemoteEngine />

<div class="sc-steps">

### Serve the engine from the worker

In a browser, the worker opens the [IndexedDB engine](./storage-indexeddb) and serves it on `self`, its side of
the port:

<<< @/examples/storage-worker-browser.mjs#worker

### Open the database on the page

The page starts the worker, gets an engine from it with `connectEngine()`, and opens the database through it:

<<< @/examples/storage-worker-browser.mjs#page

From here the database works as it would over IndexedDB directly: collections, queries, live queries and sync all
run on the page, and every read and write of storage crosses to the worker.

### Do the same in Node.js

A Node.js worker thread is wired the same way, with `parentPort` in the worker and the `Worker` object on the main
thread. This is the reason to do it with the [SQLite engine](./storage-sqlite), whose calls would otherwise block
the event loop. The example file runs as both threads:

<<< @/examples/storage-worker.mjs#worker

<<< @/examples/storage-worker.mjs#main

### Close in order

<<< @/examples/storage-worker.mjs#close

Close the database before you stop the worker, so its last writes and the log reach the engine. A worker that
exits first fails every call still waiting with `ALX_ERR_ENGINE_UNREACHABLE`.

</div>

## Options that matter

`connectEngine(worker, { timeout })` fails a call that waits longer than `timeout` milliseconds; `engine.stats()`
reports the calls in flight and the age of the oldest. On the worker's side, `serveEngine(engine, port, { allow })`
limits the paths the main thread may open. The [Remote engine](./storage-remote) page covers each of them.

## Limitations

- **The database is still on the main thread.** Only storage work moves. Merging ops from peers, running queries
  and validating writes happen where the database is open.
- **Every engine call is a message.** Records a query has to load from storage come through the port, and so does
  every write. Measure with your data before you move a busy database behind a worker.
- **One database, one opener.** A worker serves the engine to the page that started it. Several tabs that should
  share one database need a [SharedWorker](./storage-shared-worker) instead.
- **The worker is a separate module.** In a browser it is a file of its own that imports the package, so your
  bundler has to emit it as a worker entry.

## Coming from RxDB

RxDB's Worker storage, a Premium plugin, moves the whole storage layer into a worker. In syncom the engines subpath
does this as part of the package: the engine moves into the worker, and the database, with its log and its merge
logic, stays on the thread that opened it.

<FromRxdb page="rx-storage-worker" :rows="['worker', 'remoteStorage']" />
