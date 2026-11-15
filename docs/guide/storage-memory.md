---
title: Memory
description: Keep a database in memory with memoryEngine() for tests, server-side rendering and benchmarks, and see a database's files with the memory() backend.
---

# Memory

The memory engine keeps a database in the process and writes nothing anywhere. Use it for tests, for
server-side rendering, for a node that must not touch a disk, for a cache you can rebuild, and for benchmarks of
syncom itself. Nothing survives the process, so it is never the storage of record for data you cannot get back
from a peer.

<div class="sc-steps">

### Create the engine and open a database

`memoryEngine()` comes from `@alexify/syncom/memory` (the [testing](./testing) subpath exports it too).

<<< @/examples/storage-memory.mjs#engine

### Reopen it through the same engine

A database outlives its instance for as long as the engine object lives, so a test can close a database and
open it again. `engine.remove(path)` deletes it for good.

<<< @/examples/storage-memory.mjs#reopen

### Open several databases on one engine

One engine holds a database per path. Two databases that [sync](./replication) with each other in one process
are a mesh you can test without a network.

<<< @/examples/storage-memory.mjs#paths

</div>

## Why it is fast

The memory engine keeps a record as the object it was handed, never as a JSON text, and the op log as rows: no
string is made or parsed on the way in or out, and a write set lands in one step. syncom copies values at its
own boundary (what `get()` returns and what a write takes are copies), so changing an object you read never
changes the stored record. [Benchmarks](./benchmarks) has measured numbers.

## See the files a database writes

`memory()` is a backend rather than an engine: a `Map` of file names to text, which the files engine writes
exactly as it would write to disk. Use it when a test should see the files, or as the top layer of a
[memory-over-disk](./storage-layered) stack.

<<< @/examples/storage-memory.mjs#fsi

`files.dump()` returns every file as `{ 'dir/name': text }` and `files.size` counts them. Two databases opened
over one `memory()` with different paths share it, like two directories on one disk.

## Check its size

<<< @/examples/storage-memory.mjs#quota

`quota()` adds up what the database holds (texts, records as JSON, attachments' bytes) and says nothing of a
limit: the limit is the process's memory.

## Limitations

- **Gone with the process.** A crash or a restart loses every database the engine held. Replicate to a node
  with a disk if the data matters.
- **One process.** Two processes never share a memory engine; to reach one from a worker, serve it over a
  port ([Worker](./storage-worker)).
- **Held, not streamed.** The whole database lives in memory at once.

## Coming from RxDB

RxDB's memory storage keeps its state in a module-level map that outlives a closed database for the life of
the process. Here the state belongs to the engine object: a new `memoryEngine()` starts empty, and the one you
keep reopens what it holds. Nothing else changes between the two: the database has the same API on every
storage.

<FromRxdb page="rx-storage-memory" :rows="['memoryBackend', 'deleteDatabase']" />
