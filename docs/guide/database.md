---
title: Database
description: Open a syncom database, choose where it stores data, read and write records by id, make writes atomic, and close it safely.
---

# Database

A database is one [node](./glossary#node)'s copy of your data: its records, the log of every
[op](./glossary#op) (the record of one write) it made or received, and the collections you define over
them. `createDatabase()` opens one (creating it on first use) and resolves once it is ready. Everything
else, from [collections](./collection) to [replication](./replication), hangs off the object it returns.

<<< @/examples/database.mjs#open

In Node.js the data lives in the `board` directory under the working directory. In a browser the same call
stores it in the [Origin Private File System](./storage-opfs). Open the same path again later and the
records are there.

## Choose where the data lives

`path` names the database, and by default it is a directory on disk or in OPFS. To keep the data
somewhere else, pass an engine. The memory engine keeps everything in the process, which suits tests and
throwaway caches:

<<< @/examples/database.mjs#memory

The [IndexedDB](./storage-indexeddb), [SQLite](./storage-sqlite) and [MongoDB](./storage-mongodb) engines
work the same way, each from its own subpath. [Storage overview](./storage) helps you choose.

## Set the options you need

`createDatabase()` takes one options object and checks it before it opens anything: a misspelled value or
a path passed as a bare string is a `TypeError` right away. Most apps set a handful of options:

<<< @/examples/database.mjs#options

`schema` defines your collections ([Schema](./schema)), `plugins` adds what the core does not do on its own
([Installation](./install#pick-only-the-plugins-you-need)), `sync` configures [replication](./replication),
and `hooks` runs your code inside writes ([Hooks](./hooks)). `actor` names who is writing, such as the
signed-in user: the node id names the device, so set `actor` when [history](./versions) and the `commit`
event should say which person made a change. It is kept with every op in the log, never in the record.

syncom logs what it does at `info` level to `console` unless you pass a `logger` of your own or `false`.
The other options tune caching, durability and locking; [`createDatabase()`
options](../reference/api#createdatabase-options) lists all of them with their defaults.

## Read and write records by id

Every record has an id, and the database itself reads and writes any record by it, in any collection or
in none. Collections are a layer over these same calls.

<<< @/examples/database.mjs#by-id

`insert()` generates the id; `update()` changes the fields it names and leaves the rest; `set()` replaces
the record whole; `unset()` removes fields; `delete()` leaves a small [tombstone](./glossary#tombstone) so
the deletion reaches other nodes. `get()` returns the record's fields, without the id you passed it, and
as a copy: editing it changes nothing until you write it back.

Each write is an op: it is applied here, appended to the log, and sent to other nodes when sync is on. A
plain field keeps the last value written, while counters and sets merge their own way;
[Fields that merge](./fields) shows each kind and the `inc()`, `add()` and update operators that make them.

## Make several writes atomic

`transact()` runs your function and writes everything it did as one group: all of it lands, or none of it
does. Inside, `tx` has the same write methods as the database, and `tx.get()` reads what the transaction
has written so far.

<<< @/examples/database.mjs#transact

A throw from the function, or a write the validator refuses, leaves nothing behind:

<<< @/examples/database.mjs#rollback

A transaction is atomic on this node. Other nodes receive its operations together, and each field merges
with their concurrent writes as usual; [Transactions and conflicts](./transactions-conflicts) explains what
that means for your data.

## Write only if a value has not changed

`swap()` writes its changes only if the fields you name still hold the values you expect, compared inside
the database's write queue so that two concurrent swaps cannot both pass. It resolves to whether it wrote.

<<< @/examples/database.mjs#swap

`update(id, delta, { ifMatch: query })` does the same with a [query](./query) as the condition. Both
protect against writers on this node; a concurrent write on another node is merged, not refused.

## Use your own ids

By default `insert()` mints a UUID. Pass `getId` to mint your own: ULIDs, nanoids, or ids from your server.
The generator takes no arguments and may be async.

<<< @/examples/database.mjs#get-id

An id must be safe to store as a file name on every platform. UUIDs, ULIDs, CUID2s and nanoids all fit;
an id with a space or a slash is refused before anything is written (the exact rule is under `getId` in
[the options](../reference/api#createdatabase-options)):

<<< @/examples/database.mjs#invalid-id

A collection can also take the id from the record's own data, from one field or several;
[Schema](./schema#choose-how-records-are-identified) shows how.

## Open one instance per path

Two instances writing to one database would number their ops the same way, and peers would drop
one of them as a duplicate. So `createDatabase()` holds the path while it is open: through the Web Locks
API in the browser, and through a lock file elsewhere. A second open of the same path rejects with
`ALX_ERR_LOCKED`:

<<< @/examples/database.mjs#lock

`lock: 'wait'` waits until the other instance closes instead, and `lock: false` leaves coordination to
you. A crashed process does not leave the path locked for good; the [`lock`
option](../reference/api#createdatabase-options) has the details.

<<< @/examples/database.mjs#lock-wait

Two browser tabs are two instances, so the second tab sees `ALX_ERR_LOCKED` too. To work with one database from
several tabs, let one tab lead and the others follow: [Leader election](./leader-election) shows how, and
[SharedWorker](./storage-shared-worker) covers the alternatives.

## Know when a write is on disk

A write resolves once its op is in the log on disk, so it survives a crash from that moment. The record's
own file follows a moment later, so that a burst of writes to one record, such as typing into a text,
becomes one file write. Every read sees the write at once, and a crash in between is repaired from the log
at the next open. `flush()` writes the waiting files now:

<<< @/examples/database.mjs#flush

`defer: 0` writes every record file at once, at the cost of a file write per op, and
`durable: true` asks the file system to sync every write to the device where it can. `close()` flushes for
you.

## Close or remove a database

`close()` stops replication, writes everything that is waiting, seals the log and releases the lock. After
it, every write rejects with `ALX_ERR_CLOSED`:

<<< @/examples/database.mjs#closed

`db.drop()` closes the database and removes everything it stored, and `dropDatabase(path)` does the same
for one that is closed. Both remove the node's identity too: a database opened at the path again is a new
node to its peers.

<<< @/examples/database.mjs#drop

## More database tasks

- [Encryption](./encryption): seal records for this node, or encrypt the whole database at rest.
- [Health and maintenance](./health): `stats()`, the room left in storage, compacting and repairing a record.
- [Audit chain](./chain): verify every write against a hash-linked chain.
- [Purge](./purge): remove a record's data from the log for good.
- [Backup](./backup) and [Import and export](./import-export): copy a database out and back in.

## Limitations

- One writer per path. A follower can read a database another instance writes, over an engine that allows
  it; it never writes ([Leader election](./leader-election)).
- The catalog of every record (its id, collection and indexed fields) is kept in memory. That suits the
  tens of thousands of records a local-first app holds, not millions.
- The lock is per machine. On a network file system shared by several machines, coordinate yourself and
  pass `lock: false`.

## Coming from RxDB

`createRxDatabase({ name, storage })` becomes `createDatabase({ path })` or `createDatabase({ engine })`,
and collections can be part of the open call. There is no `multiInstance` sharing of one store between
tabs: a database is held by one instance and the others work through it. Ids can be generated for you,
and `transact()` gives you atomic writes across records, which RxDB does not have.

::: code-group

<<< @/examples/database.mjs#options [syncom]

<<< @/examples/rxdb/database.mjs#open [RxDB]

:::

<FromRxdb page="rx-database" :rows="['exclusiveOpen', 'idGeneration', 'transactions', 'cas', 'deleteDatabase', 'docCache']" />

Every method and property of a database is in the [API reference](../reference/api#database).
