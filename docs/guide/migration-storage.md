---
title: Storage migration
description: Move a database from one storage engine to another with migrateStorage(), keeping the node's identity, its log and its place in sync.
---

# Storage migration

You started on the files engine and now want SQLite, or you are moving a browser app from IndexedDB to OPFS.
`migrateStorage()` copies a database from one [engine](./storage) to another. The copy is the same node, not a
new one with the same records: its identity, its operation log, its version vector and every record come along,
so its peers resume syncing with it where they left off, with no full re-download.

<div class="sc-steps">

### Close the database

The copy holds the source and the target the way an open database holds its directory, so close every instance
first. A copy of a database that is still open is refused with `LOCKED`.

<<< @/examples/migration-storage.mjs#close

### Copy it to the new engine

Hand `migrateStorage()` the engine the database is on, the engine it moves to, and its path.

<<< @/examples/migration-storage.mjs#copy

The result counts what was copied: the records, the pieces of large lists and texts, the copies a
[version tag](./versions) keeps, the key-value entries (the node's identity, the catalog, [local documents](./local),
a pipeline's checkpoint), the log entries and the [attachment](./attachments) blobs.

### Open it on the new engine

<<< @/examples/migration-storage.mjs#open

From here on, open the database with the new engine. The old copy is still there; remove it once you have checked
the new one (`dropDatabase()` takes a closed database away).

</div>

## What makes a copy safe

A copy never writes over a database: if the target already holds one at that path, it is refused before anything
is written.

<<< @/examples/migration-storage.mjs#refused

The node's identity is the last thing written, so a copy cut short by a crash is not a node yet. A failed copy
removes what it wrote, and the next copy into a target that a crash interrupted clears it before it begins. If
the target engine cannot keep attachment bytes while the source holds some, the copy is refused
(`BLOBS_UNSUPPORTED`) rather than leaving records that name bytes nowhere. Every engine that ships with syncom
keeps them.

Never open the source and the copy at the same time and let both sync: they are one node, and two instances
writing as one node fork its history. Peers detect that and refuse the second one's ops.

## Start a new node instead

Sometimes you want the records but not the identity: you are splitting one database into two, or the old node's
history should stay behind. `mode: 'merge'` takes two open databases and merges every record of the first into
the second, as a [JSON import](./import-export) would:

<<< @/examples/migration-storage.mjs#merge

The target is a new node that holds the same records, with their full merge state, so it converges with the old
node's peers like any node that joined by bootstrap.

## Limitations

- A copy needs both databases closed, so the app is offline for its duration. It moves records `batch` at a time
  (500 by default) and is as fast as the two engines are.
- `migrateStorage()` copies between engines that run in the same process. To move data between devices, sync it
  instead.

## Coming from RxDB

RxDB's storage migration reads the documents of an old database and writes them into a new one under a new name,
which makes the new database a fresh replica: replication starts over, and deleted documents are not carried.
syncom copies the node whole, its log and tombstones included, so nothing has to resync.

::: code-group

<<< @/examples/migration-storage.mjs#copy [syncom]

<<< @/examples/rxdb/migration-storage.mjs#copy [RxDB]

:::

<FromRxdb page="migration-storage" :rows="['storageMigration', 'storageContract']" />

`migrateStorage()` and `copyEngine()` are in the [reference](../reference/api#dump-subpath).
