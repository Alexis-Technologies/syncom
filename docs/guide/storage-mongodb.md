---
title: MongoDB
description: Store databases in MongoDB with mongoEngine(), the driver yours; a lease keeps one writer per database and other instances follow it by change streams.
---

# MongoDB

The MongoDB engine stores databases in a MongoDB database you already run. Pick it for a server, and in
particular for several instances of one service: a lease on the server's clock lets one instance write each
database, and the others open it read-only and follow the writer through change streams. The driver is your
application's; syncom never connects, configures or closes it.

<div class="sc-steps">

### Connect the driver

Install `mongodb` (6.0 or later) and connect as you always do.

<<< @/examples/storage-mongodb-connect.mjs#connect

### Create the engine and open a database

`mongoEngine()` comes from `@alexify/syncom/mongodb`. `name` is the MongoDB database; every syncom database
opened through the engine lives in its collections, its documents keyed by its `path`.

<<< @/examples/storage-mongodb.mjs#engine

### Close it

<<< @/examples/storage-mongodb.mjs#close

</div>

`transactions: true` lands every write as one session transaction, which needs a replica set. Without it the
engine writes in a fixed order and every write is an upsert, so a write cut short is landed again whole when
the database next opens. On a standalone server, turn off what it lacks:

<<< @/examples/storage-mongodb.mjs#standalone

## One writer per database

<<< @/examples/storage-mongodb.mjs#locked

The first instance takes a lease on the database: a document in the `locks` collection, renewed every third of
its length on the server's clock, so the instances' own clocks never matter. Another instance gets `ALX_ERR_LOCKED`
until the lease is released or lapses, and with `lock: 'wait'` it waits and takes over. `lock: { staleAfter }`
sets the lease's length, 30 seconds by default.

<FigMongoLease />

A writer that loses its lease (a network partition, a pause longer than the lease) is told, and stops:

<<< @/examples/storage-mongodb.mjs#lease

Every document carries the generation of the lease that wrote it, and a write of an older generation is
refused, so a writer that lost its lease cannot write over the new one's documents even before it notices. It
hears `ALX_ERR_LEASE_LOST` once on its `error` event, becomes read-only, and leaves what it had logged but not stored
to the next holder, which replays it.

## Follow the writer from another instance

<<< @/examples/storage-mongodb.mjs#follower

A follower opens with `readOnly: true`, holds no lease, and writes nothing (a write rejects with `ALX_ERR_READ_ONLY`).
It hears every record the writer lands through a change stream on the `records` collection and wakes its
queries. When the stream ends it reports `ALX_ERR_FOLLOW_LOST`, subscribes again and reads every record again. A
follower can also [host other nodes](./server-scaling) when the instances share a log:
`mongoSharedLog()` from the same subpath is that log, kept in two more collections.

## Limitations

- **Node.js only**, with the official driver 6.0 or later.
- **Change streams and transactions need a replica set.** A standalone server has neither: no followers, and
  writes that land in order rather than whole.
- **One MongoDB database per engine.** Every syncom database of the engine shares its eight collections (plus
  `locks`), separated by path. `engine.destroy()` drops the MongoDB database with all of them.
- **No size report.** `db.quota()` answers nulls: the server's disk is the server's.

## Coming from RxDB

RxDB's MongoDB storage asks you to keep one process per MongoDB database, and nothing enforces it. syncom's
lease enforces one writer per database, and the other instances follow it instead of being shut out. RxDB runs
a query as a MongoDB query; syncom runs it over its own catalog and uses MongoDB to keep the bytes. To sync
with documents that other programs write to MongoDB, use the [MongoDB connector](./replication-mongodb) rather
than this engine.

<FromRxdb page="rx-storage-mongodb" :rows="['mongodbStorage', 'serverStorage', 'exclusiveOpen']" />
