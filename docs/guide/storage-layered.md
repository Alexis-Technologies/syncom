---
title: Memory over disk
description: Stack a memory layer over the disk with layered(), so reads come from memory and writes reach the disk either before or after they resolve.
---

# Memory over disk

`@alexify/syncom/layered` turns several backends into one: a memory layer over the disk, or the disk over another
store. A read is answered by the first layer that has the file, from the top down, and a write lands on every
layer. Choose it when the files a database reads should come from memory after the first time, or when a write
should not wait for the disk at all.

syncom already keeps recent records and its catalog in memory on its own. A memory layer adds every other file the
database reads, such as records past the cache, and with write-back it takes the disk off the write path.

<div class="sc-steps">

### Stack the layers

Pass the layers top first. A [backend](./storage-filesystem) is any object with `read`, `write`, `exists`,
`remove` and `list`; the platform's own files are exported by the package, and `memory()` is a backend in memory:

<<< @/examples/storage-layered.mjs#through

With the default `write: 'through'`, a write resolves once the last layer has it, so the database is exactly as
durable as the disk. Reads that miss memory are answered by the disk and copied up (`fill: true` by default), so the
next read of that file is a memory hit.

### Open the disk alone

The layers hold the same files in the same layout, so the disk on its own is a complete database:

<<< @/examples/storage-layered.mjs#bottom

You can add or drop the memory layer at any open without migrating anything.

### Write back from a queue

With `write: 'back'`, a write resolves as soon as the top layer has it, and the layers below are written from a
queue, one call at a time:

<<< @/examples/storage-layered.mjs#back

`pending` counts the calls queued or running. `flush()` waits for the queue to empty and rejects with the first
queued call that failed. `close()` flushes, then closes the layers that have a `close()` of their own; `sync()`,
present when a layer can sync, flushes before it syncs them. Each failed call is also passed to `onError` and counted in `failed`. A read never throws a
queued failure, even when it had to wait for the queue.

</div>

<FigLayered />

## Choose through or back

Write-through costs a disk write on every write and loses nothing that resolved. Write-back answers from memory, and
what the queue holds is lost if the process dies: writes your code saw resolve, operations in the log included, may
never reach the disk. Use it for a node that can afford to lose its last moments, such as a client that receives
the same data again from a server when it syncs, and not for a node whose disk is the only copy.

Write-back never shows you stale data. Before anything consults a lower layer (a read that misses the top,
`exists()`, `list()`, the lock's exclusive create, `sync()`), the queue drains, so a lower layer is only read once it
has every write. A read that hits the top never waits.

## Keep the disk encrypted

The layers can be any backends, including wrapped ones. Put [`atRest()`](./encryption) under the memory layer and
the disk holds only ciphertext while memory holds the files as the database wrote them:

<<< @/examples/storage-layered.mjs#sealed-disk

In a browser the same works with `createIdbFsi()` from `@alexify/syncom/idb` as the bottom layer.

## Limitations

- **Everything stays in memory.** The memory layer keeps every file written or read through it, and nothing is
  evicted. Use it for databases that fit in the memory of the process.
- **Backends, not engines.** `layered()` stacks backends under the files engine. The memory, IndexedDB, SQLite and
  MongoDB engines are not layers; each is a complete engine of its own ([Storage](./storage)).
- **The exclusive create spans every layer.** The lock file on the disk counts even when the memory above it is
  empty, so two processes over one disk still exclude each other.
- **Appending needs every layer to append.** When a layer cannot append to a file, the log writes a file per group
  of ops instead of appending lines to one journal.

## Coming from RxDB

RxDB's memory-mapped storage, a Premium plugin, keeps the data in memory and persists it to a parent storage in its
own block format, resolving writes before they persist unless you ask it to wait. In syncom, `layered()` waits for
the disk by default (`'back'` is the opt-in), and the disk keeps the ordinary layout, so it opens on its own and no
migration is needed to add or remove the memory layer.

<FromRxdb page="rx-storage-memory-mapped" :rows="['memoryMapped', 'memoryBackend', 'docCache']" />

The options and every rule of the layers are in the [engines reference](../reference/engines#layers).
