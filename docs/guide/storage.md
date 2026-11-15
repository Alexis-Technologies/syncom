---
title: Storage overview
description: Where syncom keeps your data, which storage to pick in the browser, in Node.js, on servers and in tests, and how to switch storages or write one.
---

# Storage overview

A syncom database keeps its bytes in a storage you choose with one option. The storage is only a medium:
queries, indexes, the [operation log](./operation-log), conflict resolution and replication are syncom's own
code and behave the same on every storage. Switching storages changes where the bytes live and how they reach
the disk, never what your code can do.

## Pick a storage

| You are building | Use | Why |
| --- | --- | --- |
| A browser app | [OPFS](./storage-opfs), the default | Nothing to configure: files in the origin's private file system |
| A browser app with several tabs, or with many records | [IndexedDB](./storage-indexeddb) | One transaction per write; other tabs can follow the writer |
| A Node.js app, a CLI, a desktop app | [Filesystem](./storage-filesystem), the default | JSON files you can read, back up and diff |
| A Node.js service with many records | [SQLite](./storage-sqlite) | One file, one transaction per write |
| Several instances of a server | [MongoDB](./storage-mongodb) | A lease keeps one writer per database; other instances follow it |
| Tests, server-side rendering, benchmarks | [Memory](./storage-memory) | Nothing touches a disk |

React Native is not a target syncom tests, but the SQLite engine takes a driver, and [Expo](./storage-expo) shows
one over expo-sqlite.

## Choose the storage when you open the database

Leave the `engine` option out and the database writes JSON files under its `path`: on the file system in
Node.js, in the Origin Private File System in a browser. Pass an engine and the same database lives there
instead.

<<< @/examples/storage.mjs#pick

Everything after `createDatabase()` is the same code on every storage:

<<< @/examples/storage.mjs#same-code

The query runs over syncom's catalog, an index syncom keeps in memory and saves through the storage, so it
answers the same whatever holds the records. A storage that can do more (a transaction per write, a stream of
another instance's writes) makes the database faster or safer, never different.

## Engines and backends

An **engine** is the storage contract: a factory that opens a database as a set of stores (small named texts,
the records, the op log's medium, the attachments' bytes) and lands each write as one write set. The memory,
IndexedDB, SQLite and MongoDB engines keep rows in their own structures.

The **files engine** turns a **backend**, an `fsi` of five functions over a directory and a file name (`read`,
`write`, `exists`, `remove`, `list`), into an engine. Node's file system and the browser's OPFS are the two
defaults; `memory()`, `createIdbFsi()`, [`layered()`](./storage-layered) and [`atRest()`](./encryption) are
backends too, given with `createDatabase({ fsi })`. A database takes an `engine` or an `fsi`, never both: the
pair is a `TypeError`.

## What each storage can do

| | Files on disk | Files in OPFS | Memory | IndexedDB | SQLite | MongoDB |
| --- | --- | --- | --- | --- | --- | --- |
| Runs in | Node.js | Browsers | Anywhere | Browsers | Node.js | Node.js |
| A write lands whole | No: in crash order | No: in crash order | Yes | Yes | Yes | With `transactions: true` |
| Read-only followers | No | No | Yes | Yes | No | Yes |
| Hears another instance's writes | No | No | Yes | Yes | No | Yes |
| `durable: true` | fsync per file | No effect | No effect | No effect | `synchronous = FULL` | No effect |
| `quota()` answers | Free disk space | The Storage API | Bytes held | The Storage API | File size, free space | Nothing |

A storage that cannot land a write whole is still safe. Every storage writes the op log first, and a crash
between the log and the records is replayed at the next open; [Filesystem](./storage-filesystem#what-a-crash-can-and-cannot-break)
walks through it. A [follower](./leader-election) is a second instance that reads what the writer lands and
writes nothing, which only a storage several instances may open at once can serve.

## Recipes

- **Survive a power loss on a server.** `durable: true` fsyncs every file before a write resolves
  ([Filesystem](./storage-filesystem#survive-a-power-loss)).
- **Answer reads from memory, keep the disk.** [`layered()`](./storage-layered) puts a memory layer over the
  disk.
- **Encrypt everything at rest.** [`atRest()`](./encryption) wraps any backend or engine.
- **Keep storage work off the main thread.** [Worker](./storage-worker) serves an engine from a worker.
- **Share a database between tabs.** [Leader election](./leader-election) runs one writer and lets the other
  tabs write through it.
- **Run several server instances on one database.** [MongoDB](./storage-mongodb#follow-the-writer-from-another-instance)
  holds a lease for the writer and streams its writes to the others.

## Check how much room is left

<<< @/examples/storage.mjs#quota

`quota()` answers `{ usage, quota }` in bytes, or `null` for what the storage cannot say. In a browser the
numbers come from the Storage API for the whole origin, and `db.persist()` asks the browser not to evict the
origin's storage. A storage that fills up between a write's log entry and its record does not fail the write:
it resolves, the record stays readable from memory, the database's `error` event carries `UNPERSISTED` with
`quota: true`, and the next open lands the record.

## Move a database to another storage

<<< @/examples/storage.mjs#move

`copyEngine()` copies a closed database whole: records, tags, the op log, the node's identity. The node opens
on the new storage as itself, so its peers resume where they were instead of sending everything again. Open it
on the new storage only from then on. [Storage migration](./migration-storage) covers the rest, including
moving through a JSON dump.

## Write your own engine

An engine is an object with a `name`, `capabilities`, `open(path)` and `remove(path)`; `open()` answers the
database's stores and a `write(batch)` that lands one write set. The smallest engine of your own wraps one
that exists:

<<< @/examples/storage.mjs#wrap

A new medium (a key-value store, a cloud database) implements the stores itself. The contract is specified
in [Engines and backends](../reference/engines), and `tests/suites/engine.js` in the repository is the contract
as a test: run it against your engine. Where the medium holds files rather than rows, a backend of five
functions is less work, as [localStorage](./storage-localstorage) shows.

## Coming from RxDB

An RxStorage executes queries and keeps indexes; a syncom engine only keeps bytes, and the catalog above it
does the rest. Queries therefore answer the same on every storage, and an engine is a smaller thing to write.
The `storage` option RxDB requires is `engine` here, and optional.

::: code-group

<<< @/examples/storage.mjs#pick [syncom]

<<< @/examples/rxdb/storage.mjs#pick [RxDB]

:::

<FromRxdb page="rx-storage" :rows="['storageContract', 'customBackend', 'indexStorage', 'quotas']" />
