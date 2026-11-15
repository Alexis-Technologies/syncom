---
title: Sharding
description: Why syncom has no sharding wrapper like RxDB's, and how to split data instead, with several databases by path or scopes served by hubs.
---

# Sharding

<NotInSyncom page="rx-storage-sharding" />

RxDB's sharding plugin wraps a storage and spreads the documents of one collection over several stores, such as
several IndexedDB object stores, to work around a storage that slows down as one store grows. The number of shards
is part of the collection's schema and cannot change once data is stored.

## Why syncom does not do this

A syncom database is one node: one lock, one operation log, one catalog and one position in every stream it syncs.
Its engines store a database's records in one place, queries are planned over the catalog's indexes held in
memory, and the engine contract has no notion of a shard. Splitting a collection inside one database would split
none of those, while a split into databases splits all of them, which is what makes the data smaller to open, to
sync and to move.

## Split data another way

The unit to split by is the database. Open one per tenant, team or project, each under its own path:

<<< @/examples/sharding.mjs#by-path

Each database opens, syncs and can be deleted on its own, and one engine serves many of them: the files engine as
directories, [SQLite](./storage-sqlite) as one file, [IndexedDB](./storage-indexeddb) and
[MongoDB](./storage-mongodb) as one database each, keyed by path. A query across them is yours to run on each and
combine.

On a server, splitting is a matter of what each client receives. A hub can hold every tenant's records and serve
each client only the [scopes](./partial-sync) it may see, so a client's database holds its own share and nothing
else. When one hub is not enough, several hubs share the load over a shared log; [Server scaling](./server-scaling)
shows both.

## Coming from RxDB

If you sharded to speed up a large IndexedDB store, measure syncom on your data first
([Storage performance](./storage-performance)): queries are planned over the catalog in memory. If you sharded to
keep tenants apart, use a database per tenant on the client and scopes on the server.

<FromRxdb page="rx-storage-sharding" :rows="['sharding', 'collectionLimit']" />
