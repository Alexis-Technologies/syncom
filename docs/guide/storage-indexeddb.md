---
title: IndexedDB
description: Store a browser database in IndexedDB with idbEngine(), let other tabs follow it, test it in Node with fake-indexeddb, and when to pick it over OPFS.
---

# IndexedDB

The IndexedDB engine keeps a browser database in object stores, lands every write as one transaction, and tells
other tabs about each write. Pick it over the default [OPFS](./storage-opfs) when several tabs open the same
database, when a database holds many records (one row each instead of one file each), when OPFS is unavailable
in the browsers or contexts you target, or when your app already lives in IndexedDB.

<div class="sc-steps">

### Create the engine and open a database

`idbEngine()` comes from `@alexify/syncom/idb`, part of the package. `name` is the IndexedDB database; every
syncom database opened through the engine lives in it, its rows keyed by its `path`.

<<< @/examples/storage-indexeddb.mjs#open

### Close it

The database and the engine close separately: several databases may share one engine.

<<< @/examples/storage-indexeddb.mjs#close

### Delete everything

`engine.destroy()` deletes the IndexedDB database, and with it every syncom database it held. To delete one
of them, close it and call `engine.remove(path)`, or `db.drop()` while it is open.

<<< @/examples/storage-indexeddb.mjs#destroy

</div>

## The options that matter

<<< @/examples/storage-indexeddb.mjs#options

`durability` is the hint IndexedDB takes for each transaction: `'relaxed'` lets the browser report a write done
before it reaches the disk, which is faster, and `'strict'` asks it to wait. `channel: null` stops the engine
from telling other tabs about writes; the rest of the options exist for tests. [Engines and backends](../reference/engines#indexeddb-engine)
lists them all with the seven object stores the engine creates.

## Open the same database in several tabs

A second tab that opens the database with the default options gets `ALX_ERR_LOCKED`: one instance writes, so that two
never hand out the same sequence number. A tab that only reads opens it with `readOnly: true` and follows the
writer:

<<< @/examples/storage-indexeddb.mjs#follower

<FigTabFollower />

The follower hears each write set over a `BroadcastChannel`, reads the records again and wakes its queries.
It writes nothing (a write rejects with `ALX_ERR_READ_ONLY`), and it sees a write once the writer has landed its record,
up to `defer` ms after the write resolved in the first tab. For tabs that all write, use
[leader election](./leader-election): one tab leads and the others write through it, with a new leader when it
closes.

## Run it in Node.js

Node has no IndexedDB. Tests pass an implementation such as `fake-indexeddb`:

<<< @/examples/storage-indexeddb.mjs#node

## Use IndexedDB as a file store

`createIdbFsi()` is the other way into IndexedDB: a backend that stores each file of the files engine as a row
of one object store. It spends a transaction per file where the engine spends one per write, so prefer the
engine; the file store is there for code that wants the files layout, for instance under
[`layered()`](./storage-layered).

<<< @/examples/storage-indexeddb.mjs#fsi

`fsi.close()` closes its connection; the database never closes a backend it was handed.

## Limitations

- **Evictable.** Browsers may clear an origin's storage under pressure. Ask for persistence with
  `db.persist()` and check room with `db.quota()` ([Storage overview](./storage#check-how-much-room-is-left)).
- **`durable: true` has no effect.** A write resolves when its transaction completes, as durable as the
  browser makes it; `durability` is the knob.
- **A full origin.** A write whose log entry is in but whose record does not fit resolves, stays readable from
  memory, and is reported on the database's `error` event as `ALX_ERR_UNPERSISTED` with `quota: true`.

## Coming from RxDB

RxDB's own IndexedDB storage is a Premium plugin, and its free option goes through Dexie.js. syncom's engine
ships in the package, with no dependency. Several tabs are not peers sharing one store here: one writes and the
others follow it or write through a leader.

<FromRxdb page="rx-storage-indexeddb" :rows="['indexeddb', 'multiTab', 'quotas']" />
