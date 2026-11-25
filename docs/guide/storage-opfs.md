---
title: OPFS
description: The default browser storage, files in the Origin Private File System, from the main thread or a worker; persistence, quota and the one-tab lock.
---

# OPFS

In a browser, a database writes its files into the Origin Private File System (OPFS) unless you pick another
storage: the same layout as on disk in Node.js, in a file system private to your origin. It needs no option and
works on the main thread and in a worker. Choose [IndexedDB](./storage-indexeddb) instead when several tabs open
one database or when a database holds many records.

<div class="sc-steps">

### Bundle the browser build

`@alexify/syncom` resolves to its browser build under the `browser` export condition of `package.json`, which a
bundler applies when it builds for the browser (esbuild's `platform: 'browser'`, for one). That build swaps the
file system for OPFS and `node:crypto` for Web Crypto; nothing else changes.

### Open a database

`path` names a directory inside the origin's OPFS.

<<< @/examples/storage-opfs.mjs#open

### Ask the browser to keep the data

A browser may evict an origin's storage when the device runs low on space. `db.persist()` asks it not to, and
`db.quota()` reports what the origin uses and may use.

<<< @/examples/storage-opfs.mjs#persist

</div>

## Run the database in a worker

The same call opens a database inside a worker, which keeps parsing and writing off the page's thread. The
page then talks to the worker with messages of your own:

::: code-group

<<< @/examples/storage-opfs.mjs#worker-main [main.js]

<<< @/examples/storage-opfs-worker.mjs#worker [board-worker.js]

:::

To keep the database on the page and move only the file work into a worker, serve the storage from the worker
instead ([Worker](./storage-worker)).

## Open the database in a second tab

<<< @/examples/storage-opfs.mjs#locked

The first instance holds the database through the Web Locks API, which the browser releases when that tab or
worker closes or crashes. A second tab gets `ALX_ERR_LOCKED` and can wait with `lock: 'wait'`. For tabs that all work on
one database, open it over [IndexedDB](./storage-indexeddb#open-the-same-database-in-several-tabs), where other
tabs can follow the writer, and let [leader election](./leader-election) pick the tab that writes.

## How it writes

The OPFS backend writes each file through `createWritable()`, the asynchronous API every thread has, and a file
is durable once its writable closes. It has no append, so the op log writes a small file per group of writes
instead of a line in a journal, and no fsync, so `durable: true` has no effect. Directory handles are kept once
resolved, so a write does not walk the tree from the root. The files are those of the
[Filesystem](./storage-filesystem#see-what-is-on-disk) page.

## Limitations

- **A secure context only.** OPFS and Web Crypto need HTTPS or `localhost`.
- **Per origin, and evictable.** Data is private to the origin and may be cleared under storage pressure until
  `persist()` is granted.
- **A file per record.** Many small files; [IndexedDB](./storage-indexeddb) keeps rows instead.
- **One instance per database.** OPFS serves no read-only follower in another tab.

## Coming from RxDB

RxDB's OPFS storage is a Premium plugin built for a worker, where it uses synchronous access handles, with a
separate variant for the main thread. syncom's OPFS backend is the free default, uses the asynchronous API on
any thread, and stores the files of the files engine rather than a format of its own.

<FromRxdb page="rx-storage-opfs" :rows="['opfs', 'browser', 'exclusiveOpen']" />
