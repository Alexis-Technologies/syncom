---
title: Remote engine
description: Serve a storage engine over a MessagePort and open a database through it from another thread, worker or process with serveEngine and connectEngine.
---

# Remote engine

A database and the storage it writes to do not have to live in the same thread. `@alexify/syncom/engines` serves
an [engine](./storage) over a message port on one side and hands you an engine on the other: every call of the
engine becomes one message and its answer. Choose it when the storage belongs somewhere else than your code, such
as an engine that does synchronous I/O and should stay off your event loop, an IndexedDB opened in a worker, or a
store that Electron's main process owns while a window runs the app. The [Worker](./storage-worker) and
[Electron](./electron) pages build on this one.

The database itself stays where you open it: its log, its queue of writes and its sequence numbers live on your
side, and only the bytes of its records and log cross the port.

<div class="sc-steps">

### Serve the engine

On the side that owns the storage, pass an engine and one end of a port to `serveEngine()`. `allow` lists the
database paths the other side may open:

<<< @/examples/storage-remote.mjs#serve

The port can be a `MessagePort` (from a `MessageChannel`, in Node.js or a browser), a worker, or anything with
`postMessage` and either `on('message')` or `addEventListener('message')`.

### Connect and open a database

On the other side, `connectEngine()` asks what the served engine is (its name and what it can do) and returns an
engine you pass to `createDatabase()` like any other:

<<< @/examples/storage-remote.mjs#connect

Everything the database does goes through the port: the lock, every record read and written, every group of the
log appended. Errors come back with their codes (`LOCKED`, `INTEGRITY`, a file's `EEXIST`), and a served engine's
change stream and the loss of its lease are pushed back as they happen, so the database behaves as it would over
the engine directly.

### Close both sides

<<< @/examples/storage-remote.mjs#unreachable

When the port closes or the worker behind it exits, every call waiting and every call after rejects with
`ENGINE_UNREACHABLE` and `reason: 'closed'`, and the serving side lets go of what that port held: its leases, its
subscriptions, its databases. `engine.close()` closes your end and leaves the served databases open;
`server.close()` stops answering and closes every database opened through that port.

</div>

## Restrict what the other side can do

The serving side trusts the port as much as it trusts the code on its other end, and no further. A call can only
name a store and a method of the engine contract; every key, id, tag and path is checked before the engine sees it,
because a key becomes a file name in the files engine and a filter in MongoDB. `remove(path)` deletes only what that
port opened, and with `allow` the port opens nothing else:

<<< @/examples/storage-remote.mjs#allow

Give a less trusted side, such as a window that renders remote content, its own port and its own `allow` list.

## Know when the other side is slow or gone

`timeout` (in milliseconds, none by default) fails a call that waits longer as `ENGINE_UNREACHABLE` with
`reason: 'timeout'`. `engine.stats()` says how the port is doing:

<<< @/examples/storage-remote.mjs#stats

`inflight` and `oldestMs` are the calls waiting now and the age of the oldest; `calls` and `failures` count since
the start (a refused call, like the `allow` one above, counts as a failure); `closed` turns true once the port is
gone.

## Skip the question when you know the answer

`connectEngine()` costs one round trip to learn the served engine's name and capabilities. When you started the
other side yourself, pass them to `remoteEngine()` instead:

<<< @/examples/storage-remote.mjs#remote-engine

## Limitations

- **One database, one side.** The database is opened on one side of the port, and the usual
  [one instance per directory](./database) rule holds across it: a second side opening the same path gets `LOCKED`.
  For several windows or tabs over one database, see [SharedWorker](./storage-shared-worker).
- **Every call is a round trip.** A query that reads many records from the engine reads them through the port.
  Measure it for your data before moving a hot path behind one.
- **A port, not a network.** Messages are structured clones between threads or processes of one machine. A database
  on another machine is a peer you sync with: see [Sync engine](./replication) and [Server](./server).

## Coming from RxDB

RxDB's remote storage takes a function that builds a message channel as an observable and a `send()`, and adds a
WebSocket variant on top. syncom takes the port itself, and has no WebSocket engine: a database on another machine
replicates instead of reading through a remote engine.

::: code-group

<<< @/examples/storage-remote.mjs#serve [syncom: serve]

<<< @/examples/storage-remote.mjs#connect [syncom: connect]

<<< @/examples/rxdb/storage-remote.mjs#remote [RxDB]

:::

<FromRxdb page="rx-storage-remote" :rows="['remoteStorage', 'exclusiveOpen']" />

Every rule of the served side and the calling side is in the [engines reference](../reference/engines#an-engine-over-a-port).
