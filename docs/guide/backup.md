---
title: Backup
description: Back up a syncom database to a file and restore it, copy a whole node while it is closed, and what syncom does not do for you.
---

# Backup

Every node that syncs is already a copy of the data it holds: lose a laptop and its records are still on the
server and on the phone. A backup is for what sync cannot help with: a node that syncs with nobody, a server
that is the last copy, or a mistake you want to undo by going back to yesterday. syncom gives you two kinds of
backup, a JSON dump of the records and a copy of the whole node, and leaves scheduling and storing them to you.

## Write a backup to a file

A backup is a [JSON export](./import-export) written to a file:

<<< @/examples/backup.mjs#write

The dump holds every record, tombstones included, with the metadata needed to merge it back exactly. Writing to a
temporary name and renaming it means a crash halfway never leaves a broken file under the real name. The
database stays open and keeps working while the dump is made.

## Restore it

<<< @/examples/backup.mjs#restore

Importing as a merge brings every record back with its merge state, into an empty database or into one that
already holds data (records the database has changed since are merged, not overwritten). The restored database is
a new node: it holds the records, not the old node's identity, operation log or [audit chain](./chain). Once it
syncs, its peers receive the restored records like any other writes from a new node.

## Back up on a schedule

syncom has no backup writer that runs by itself. Write one from the `transaction` event, which fires for every turn
that changed something, local or synced:

<<< @/examples/backup.mjs#schedule

This rewrites the whole dump when something changed. For a large database, stream it with `exportPages()` instead
of building it in memory, and keep a few dated files rather than one.

## Copy the whole node

A dump restores records into a new node. To keep the node itself (its identity, its log, its keys, its place in
sync), copy the database while it is closed:

<<< @/examples/backup.mjs#cold

`copyEngine()` is what [storage migration](./migration-storage) runs; here the target is another path on the same
engine. Restoring is opening the copy, or copying it back. Only ever run one of the two: the copy is the same node,
and two instances of one node writing at once fork its history.

Restoring an older copy of a node that syncs has a catch: the node's peers hold ops it made after the copy was
taken. At the next connection the node notices (`ALX_ERR_REWOUND` on the sync `error` event). When the peer proves it
holds ops signed by this node, the node moves past them and bootstraps from that peer. Writes made on the node
between the restore and that connection are lost to its peers. See the
[error reference](../reference/api#syncomerror) for the details.

## What is not here

There is no live backup that streams every change to a file, no incremental backup, and no point-in-time restore
of a single record from a file. Within the database, [versions and tags](./versions) give you the past of a
record and of the whole database without a file. Keeping backups is yours: syncom makes the dump, you decide where
it goes and how long it stays.

[Encrypted](./encryption) records are not in a dump; a copy of the node keeps them as ciphertext, with the keys.

## Coming from RxDB

RxDB's backup plugin writes a folder per document under a directory, once or live, in Node.js only, and has no
restore. syncom makes one JSON value that you store where you like (a file in Node.js, a download or OPFS in the
browser) and restore with `importJSON()`, and adds a copy of the whole node; the live part is a few lines of yours.

::: code-group

<<< @/examples/backup.mjs#write [syncom]

<<< @/examples/rxdb/backup.mjs#write [RxDB]

:::

<FromRxdb page="backup" :rows="['backup', 'jsonDump', 'encExport']" />

The dump functions are in the [reference](../reference/api#dump-subpath).
