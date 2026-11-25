---
title: Browser storage compared
description: Which browser storage to use with syncom (OPFS, IndexedDB or memory), why localStorage, cookies and WebAssembly SQLite are not among them, and how quotas work.
---

# Browser storage compared

A browser offers several places to keep data: cookies, localStorage, IndexedDB, the Origin Private File System
(OPFS), and SQLite compiled to WebAssembly on top of one of them. A syncom database uses two of them, OPFS and
IndexedDB, or keeps everything in memory. This page helps you pick one, explains why the others are not on the
list, and shows what happens when the browser runs out of room.

## Pick a storage

| Storage                          | How you choose it             | Pick it when                                             | Keep in mind                                    |
| -------------------------------- | ----------------------------- | -------------------------------------------------------- | ----------------------------------------------- |
| [OPFS](./storage-opfs)           | the default, no option        | one tab or one worker owns the database                  | a second tab gets `ALX_ERR_LOCKED`; a file per record   |
| [IndexedDB](./storage-indexeddb) | `engine: idbEngine({ name })` | several tabs open the database, or it holds many records | every awaited write is an IndexedDB transaction |
| [Memory](./storage-memory)       | `engine: memoryEngine()`      | tests, previews, data you can fetch again                | nothing survives a reload                       |

With no option, a database in a browser bundle writes its files into OPFS:

<<< @/examples/browser-storage.mjs#default

The IndexedDB engine keeps the database in object stores instead, one row per record:

<<< @/examples/browser-storage.mjs#indexeddb

The memory engine keeps it in the page:

<<< @/examples/browser-storage.mjs#memory

Your code does not change with the storage: collections, queries, live queries and sync work the same on each.

## OPFS or IndexedDB

**OPFS** needs no setup and works on the page and in a worker. It stores the same files a database writes on disk
in Node.js. The database holds it through the Web Locks API, so a second tab that opens it gets `ALX_ERR_LOCKED` (or
waits, with `lock: 'wait'`); a tab that closes or crashes lets go. Each record is a file, and each group of ops in
the log a small file, since OPFS cannot append to a file.

**IndexedDB** lets other tabs follow a database: one tab writes, the others open it with `readOnly: true` and hear
every write over a `BroadcastChannel`, and [leader election](./leader-election) moves the writing role between
tabs. Each record is a row, and a database with many records is many rows in one store rather than many files.
What its writes cost, and how syncom keeps that down, is on [IndexedDB performance](./slow-indexeddb).

The repository has no benchmark that runs in a browser, so neither is "the fast one" here. If speed decides, open
your app on both and measure; [Engine performance](./storage-performance#measure-your-own-workload) shows a
script to start from. The engine benchmark's IndexedDB row runs in Node.js on `fake-indexeddb` and says nothing
about a browser.

`createIdbFsi()` is a third way into IndexedDB: the files a database writes, stored as rows of one object store,
a transaction per file. It exists for code that wants the files layout, such as a [memory layer](./storage-layered) over it;
prefer the engine otherwise.

## Why not localStorage, cookies or SQLite in WebAssembly

**localStorage** holds a few megabytes of strings per origin and answers synchronously on the page's thread, and
workers cannot reach it. A database writes its log, its records, its catalog and its keys, which fills a small
synchronous store fast and blocks the page while it writes. syncom ships no localStorage storage;
[localStorage](./storage-localstorage) has a small backend for the rare place that has nothing else.

**Cookies** are a few kilobytes each and travel to the server with every request to the origin. They are for
sessions, not for a database.

**SQLite in WebAssembly** is not shipped. syncom has no runtime dependencies and no WebAssembly, and its
[SQLite engine](./storage-sqlite) is built for Node.js. That engine takes any driver with `exec()` and
`prepare()`, so a WebAssembly build could in principle be wrapped as one, but nobody has run that in a browser,
and a browser already has the two storages above.

## Ask for room and keep it

<<< @/examples/browser-storage.mjs#quota

`quota()` answers `{ usage, quota }` in bytes from the browser's Storage API, for the whole origin; a storage
that cannot tell answers `null`. A browser may clear an origin's storage when the device runs low on space, and
`persist()` asks it not to. It resolves to `true` once the browser agrees and `false` when it declines or has no
such API.

When the origin is full, a write fails in one of two places:

- **The log refuses the op.** Nothing was written: the write rejects with `ALX_ERR_QUOTA`, the platform's error as its
  `cause`, and the next write goes through once there is room.
- **The record cannot land.** The op is already in the log and replicates, so the write resolves and its record is
  held in memory, where reads find it. The database's `error` event carries `ALX_ERR_UNPERSISTED` with `quota: true` and
  the ids, and the next open replays the log onto the storage.

OPFS needs a secure context (HTTPS or `localhost`), and so does Web Crypto, which syncom hashes with on every
storage, IndexedDB included, so serve the app over one.

## Coming from RxDB

RxDB's article measures every browser storage, localStorage and WebAssembly SQLite included, because RxDB offers
storages over most of them (some Premium). syncom offers fewer: OPFS by default and IndexedDB for several tabs,
both free, and leaves localStorage and WebAssembly SQLite out. What it adds is quota handling in the core: a full
origin is a `ALX_ERR_QUOTA` refusal or an `ALX_ERR_UNPERSISTED` write held in memory, not a raw `QuotaExceededError`.

<FromRxdb page="articles/localstorage-indexeddb-cookies-opfs-sqlite-wasm" :rows="['browser', 'opfs', 'indexeddb', 'localStorage', 'quotas']" />
