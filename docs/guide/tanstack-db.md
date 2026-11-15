---
title: TanStack DB
description: Why syncom has no TanStack DB collection adapter, and how to get live queries and instant local writes in your components without one.
---

# TanStack DB

<NotInSyncom page="articles/tanstack-db/rxdb-collection-for-tanstack-db" />

TanStack DB is a reactive store for the client: it keeps collections in memory, runs live queries over
them and applies mutations optimistically, and it leaves persistence and networking to the collection
type you plug in. RxDB fills that slot with a collection adapter, published by TanStack, so that the
in-memory collections are backed by a durable RxDB collection and its replication.

## Why syncom has no adapter

Nobody has written one. syncom also covers most of what the pairing adds on its own: its collections run
[live queries](./query) that are kept up to date as records change, a write applies to the local database
at once with no round trip to wait for (there is nothing optimistic to roll back, because the local write
is the write), and [replication](./replication) merges it with other nodes later. Putting TanStack DB on
top would keep a second copy of every row in memory to answer queries syncom already answers.

## Get the same result in syncom

Read live queries straight from your components through a [store](./reactivity). In React that is
`useSyncExternalStore` over a store made once:

<<< @/examples/react.mjs#board

[React](./react) builds the component around it, and [Other frameworks](./frameworks) has the same
recipe for Vue, Svelte, Solid and Angular, the frameworks TanStack DB also binds to.

If you already use TanStack DB and want syncom underneath it, a custom collection is the way: load the
rows with a query, then follow the collection's `insert`, `update` and `remove` events
([events](./hooks#watch-what-happened-with-events)) and send writes back through the collection's
methods. That adapter would be yours to write and test; the store contract and the collection events are
the stable surface to build it on.

## Coming from RxDB

With RxDB the adapter makes TanStack DB the query layer and RxDB the storage and sync layer. With syncom
the database is both, so the code that read TanStack DB's live queries reads a syncom store instead.

<FromRxdb page="articles/tanstack-db/rxdb-collection-for-tanstack-db" :rows="['tanstack', 'react']" />
