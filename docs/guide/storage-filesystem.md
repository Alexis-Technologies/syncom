---
title: Filesystem (Node.js)
description: Store a database as plain JSON files with Node's file system, the default in Node.js, and learn what is on disk, how fsync works and how the lock behaves.
---

# Filesystem (Node.js)

In Node.js a database writes plain JSON files under its `path` unless you pick another storage. It is the
storage to start with for an app, a CLI tool, a desktop app or a server whose data you want to read, back up or
diff with ordinary tools. It needs no option and no dependency; choose [SQLite](./storage-sqlite) instead when a
database holds many records and you would rather have one file than one file per record.

<div class="sc-steps">

### Open a database in a directory

`path` names the directory, relative to the working directory. It is made on the first write.

<<< @/examples/storage-filesystem.mjs#open

### Read what it wrote

Every record is a file you can open. The record's value is under `data`; the rest of the file is the
bookkeeping that lets two nodes merge their copies.

<<< @/examples/storage-filesystem.mjs#read-file

### Make every write wait for the disk

`durable: true` follows every file write with an fsync; `defer: 0` writes the record files at once instead of
batching them for a frame.

<<< @/examples/storage-filesystem.mjs#durable

### Delete a database

`dropDatabase()` removes every file of a closed database. `db.drop()` does the same for the one you hold open.

<<< @/examples/storage-filesystem.mjs#drop

</div>

## See what is on disk

```
board/
├── node.json        { id, plugins }: this node's identity and the kinds it ran with
├── schema.json      { version, migrated, hash }: the schema this directory last ran
├── lock.json        { pid, id, since }: present while an instance holds the directory
├── keys/            public.pem, private.pem (RSA, seals records); sign-public.pem, sign-private.pem (Ed25519, signs ops)
├── blockchain/      <hash>.json per block; .blockchain.json holds the tail
├── data/            <id>.json per record; a list or text of 1 024 runs or more keeps its runs in <id>~<n>.json beside it
├── index/           catalog.json: the catalog of records and indexed values (derived, rebuilt when missing)
├── log/             index.json, seg-<from>.json per sealed segment, open/ for the groups not sealed yet
├── tags.json        { format, tags }: the tags taken here, and tags/<name>/ with what each tag keeps
├── remote/          <url>.json per node registered with sync.addNode()
├── local/           <key> per local document, never replicated
├── blobs/           <digest> per attachment's bytes
└── …                pipeline/, connector/, shared/ and tombstones/ once those features write
```

A record file holds `{ data, meta, encrypted, timestamp, block }`: the value, the merge bookkeeping (a clock per
field, the counters, the sets, a list's or a text's blocks), whether it is [sealed](./encryption), when it was
written and the [chain](./chain) block that committed it. `keys/`, `blockchain/` and `schema.json` come from
the plugins of `@alexify/syncom/all`; the core alone writes `node.json`, `data/`, `index/` and `log/`. A deleted record keeps its file as a tombstone until
[cleanup](./cleanup) folds it. [Engines and backends](../reference/engines#the-files-engine) specifies each
file.

## What a crash can and cannot break

<FigWriteSet />

A write resolves once its operation is in the log. The record file and its chain block land after it, in log
order, up to 16 ms later by default (`defer`), so a burst of writes to one record becomes one file. A crash
before the record lands loses nothing: the next open replays the logged operations onto the files. A log file
torn by the crash is dropped before anyone was told of it, and the files the log does not replay (its index,
`node.json`, `tags.json`, the catalog) are written to a temporary file and renamed into place.

A record file torn in the middle of a write reads as `INTEGRITY` until `repair(id)` rebuilds it. A disk that
fills up after the log took a write does not fail it: the write resolves, the record stays readable from memory,
and the database's `error` event carries `UNPERSISTED` until the next open lands it.

## Survive a power loss

Without `durable`, a write is as safe as the operating system's page cache: a crash of the process loses
nothing, a power loss can lose the last writes the disk had not flushed. `durable: true` fsyncs every file
before the write resolves, at the price of the disk's write latency. `durable` applies when the database builds
its own files engine, the default or `createDatabase({ fsi })`; a files engine passed as `engine` is used as it
was made.

## Open the same directory twice

<<< @/examples/storage-filesystem.mjs#locked

Two instances over one directory would hand out the same sequence number for two different operations, so the
first instance holds the directory with `lock.json` and a second open rejects with `LOCKED`. A lock whose
process is gone is stale, and the next open takes it over. To wait instead:

<<< @/examples/storage-filesystem.mjs#wait

`lock: false` turns the lock off when you coordinate instances yourself. The lock is per machine, so on a
network file system shared by several machines, coordinate them yourself.

## Limitations

- **A file per record.** Each record, chain block and log segment is a file; millions of records are millions
  of files. [SQLite](./storage-sqlite) keeps them in one.
- **One instance per directory.** There is no read-only follower over the files engine; a second process that
  needs the data should [sync](./replication) with the first.
- **Not atomic across files.** A transaction of many records lands in crash order and relies on the log's
  replay, never on the file system.

## Coming from RxDB

RxDB's filesystem storage for Node.js is part of its paid Premium plugins; here the file system is the default,
and the files are plain JSON you can read. RxDB lets several processes share one folder; syncom holds the
directory for one instance and syncs the others.

<FromRxdb page="rx-storage-filesystem-node" :rows="['nodeFs', 'onDiskFormat', 'durability', 'crashRecovery', 'exclusiveOpen']" />
