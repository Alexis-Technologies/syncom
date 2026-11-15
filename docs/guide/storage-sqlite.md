---
title: SQLite
description: Keep databases in one SQLite file with sqliteEngine(), over node:sqlite or a driver such as better-sqlite3, with one transaction per write.
---

# SQLite

The SQLite engine keeps databases as rows of one SQLite file and lands every write as one transaction. Pick it
in Node.js when a database holds many records and one file suits you better than [a file per record](./storage-filesystem),
when you want every write set atomic, or when several databases of one process belong in one file. It runs on
Node's built-in `node:sqlite` with no install, or on a driver you pass.

<div class="sc-steps">

### Create the engine and open a database

`sqliteEngine()` comes from `@alexify/syncom/sqlite`. `file` is the SQLite file; every database opened through
the engine lives in it, its rows keyed by its `path`.

<<< @/examples/storage-sqlite.mjs#open

### Close it

The database and the connection close separately, and the file stays.

<<< @/examples/storage-sqlite.mjs#close

### Reopen it

An engine opens its file again on the next call after `close()`.

<<< @/examples/storage-sqlite.mjs#reopen

### Delete the file

<<< @/examples/storage-sqlite.mjs#destroy

To delete one database and keep the others in the file, close it and call `engine.remove(path)`, or
`db.drop()` while it is open.

</div>

Node prints an `ExperimentalWarning` the first time `node:sqlite` loads. Run with
`node --no-warnings=ExperimentalWarning` to hide it, or pass a driver: the engine loads `node:sqlite` only when
it has neither a `driver` nor a `database`.

## Keep several databases in one file

<<< @/examples/storage-sqlite.mjs#two-paths

Every row starts with its database's path, so databases never see each other's rows. They do share one
connection, and SQLite runs one statement at a time on it: a busy database makes the others wait. Give a
database that must not wait an engine (and a file) of its own.

## Use another driver

A driver is an object with `open(file)` that answers a database with `exec(sql)` and `prepare(sql)`, whose
statements have `run`, `get` and `all`. Every answer may be a promise, so a driver over an asynchronous binding
works too.

<<< @/examples/storage-sqlite.mjs#driver

better-sqlite3's `Database` has the same three calls, so `{ open: (file) => new Database(file) }` is a whole
driver for it. On other platforms, a few lines adapt the binding: [Expo](./storage-expo) shows one over
expo-sqlite. To manage the connection yourself, pass it as `database`:

<<< @/examples/storage-sqlite.mjs#connection

A database in memory, gone with the connection, is the default when you give no file:

<<< @/examples/storage-sqlite.mjs#in-memory

## The options that matter

`durable: true`, on the engine or on any database opened through it, sets `PRAGMA synchronous = FULL`: a write
resolves once SQLite has synced it. Without it, a file the engine opens runs in WAL mode with
`synchronous = NORMAL`, which survives a crash of the process and may lose the last writes to a power loss.
[Engines and backends](../reference/engines#sqlite-engine) lists the eight tables the engine creates and
every option.

`db.quota()` reports the file's size and the free space on its disk.

## Limitations

- **Node.js only.** The subpath is not part of the browser build; use [IndexedDB](./storage-indexeddb) there.
- **No followers.** One instance holds a database (a second open gets `LOCKED`), and SQLite serves no
  read-only follower in another process. Sync a second process instead.
- **One lane per engine.** Statements of every database on one engine run one after another.

## Coming from RxDB

RxDB's SQLite storage is a Premium plugin; the free trial version lacks indexes and attachments and stops after
a few hundred documents. syncom's SQLite engine is MIT like the rest of the package, with no limit. Both adapt
the SQLite library through a small object you pass: RxDB's "basics", syncom's driver.

::: code-group

<<< @/examples/storage-sqlite.mjs#open [syncom]

<<< @/examples/rxdb/storage-sqlite.mjs#open [RxDB]

:::

<FromRxdb page="rx-storage-sqlite" :rows="['sqlite', 'storageTrialLimits', 'transactions']" />
