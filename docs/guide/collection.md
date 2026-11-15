---
title: Collection
description: Add collections to a database, insert, upsert and bulk-write records, read them by id, listen to changes, and add or remove collections at runtime.
---

# Collection

A collection groups the records of one kind, such as the tasks of a board, and is what you query. Each
entity of the [schema](./schema) becomes a collection on the database object: `db.Task`. A record written
through a collection carries a `$type` field naming it, and the collection reads, writes and lists only
its own records.

<<< @/examples/collection.mjs#define

A collection name may not clash with something the database already answers to (`get`, `close`, `sync`
and so on): `createDatabase()` refuses it with a `TypeError`. `entities` may also be a `Map`.

## Insert a record

`insert()` writes a new record and resolves to a live [document](./document) for it. The id is minted
unless the data names one: by default a string `id` field becomes the record id and leaves the data, and a
schema can name another field or build the id from several ([Choose how records are identified](./schema#choose-how-records-are-identified)).

<<< @/examples/collection.mjs#insert

Inserting under an id a live record already holds rejects with `EXISTS`, decided inside the write queue so
that two concurrent inserts cannot both pass.

## Write a record whole, or only if it is absent

`upsert()` writes the record its data names whether it exists or not, replacing it whole.
`insertIfAbsent()` writes it only when no live record holds the id, and resolves to the record that is
there either way:

<<< @/examples/collection.mjs#upsert

`set(id, data)` is the same whole-record write with the id passed apart. A whole-record write resets the
fields it does not name, counters and sets included, so prefer `update()` when you change part of a record.

## Update and delete records

`update()` changes the fields it names, or runs the update operators (`$set`, `$inc`, `$addToSet` and the
rest, described in [Fields that merge](./fields)). `unset()` removes fields. `modify()` runs your function
over a copy of the record inside the write queue and writes the difference, so two `modify()` calls on one
record compose instead of overwriting each other:

<<< @/examples/collection.mjs#update

`delete()` leaves a tombstone so that the deletion reaches other nodes. With `data`, the tombstone carries
those fields (a reason, who deleted it) for a hook, a [pipeline](./pipeline) or a peer to read, while
`get()` answers `null` all the same:

<<< @/examples/collection.mjs#delete

## Write many records at once

`bulkInsert()`, `bulkUpsert()` and `bulkRemove()` write a batch as one transaction with a verdict per row.
Every row that can be written is; a row refused on its own account (a taken id, the validator, a unique
key, a record of another collection) is listed in `error` with its index and the error a single write
would have thrown.

<<< @/examples/collection.mjs#bulk

A batch that cannot reach the disk at all writes nothing. One call takes at most 10,000 rows; a larger
batch is a `TypeError` before anything lands, so page through big imports.

## Read records by id

`get()` returns a copy of the record, `findByIds()` a `Map` of the live records among the ids you give
(reading the ones not in memory in one go), and `document()` the record's live document:

<<< @/examples/collection.mjs#read

To find records by their fields instead, use a [query](./query): `db.Task.select({ done: false })`.

A collection only answers for its own records. A record of another collection reads as `null` through it,
and writing it through the wrong collection rejects with `NOT_FOUND`:

<<< @/examples/collection.mjs#foreign

## Listen to a collection

A collection emits `change` with the record's id and an `action` (`insert`, `update` or `remove`), and
then an event named after the action. They fire after the write has landed, whether it was made here or
came from a peer.

<<< @/examples/collection.mjs#events

A record that joins the collection is an `insert` and one that leaves it (deleted, purged, moved to
another collection) a `remove`. To follow the records that match a condition, a live
[query](./query#watch-a-query) is usually what you want instead.

## Add or remove collections at runtime

`addCollections()` defines collections on an open database, with the same definitions the schema takes;
records already stored with that `$type` are indexed as they are found. `remove()` deletes every record of
a collection, and `removeCollection()` forgets the definition while keeping its records:

<<< @/examples/collection.mjs#runtime

`remove()` takes `{ purge, actor }` and nothing else, so `remove({ done: true })` is a `TypeError` rather
than an accident: delete the records a query matches with `select(query).delete()`.

## Records outside a collection

The database's own methods write records with no collection at all, which suits settings, singletons and
data you have not modeled yet. Such a record can join a collection later; once it has one, its `$type`
never changes.

<<< @/examples/collection.mjs#outside

## Limitations

- Collections added with `addCollections()` are not saved: add them again after every open.
- Counters and sets have no method of their own on a collection. Use `$inc` and `$addToSet` in `update()`,
  the database's `inc()` and `add()`, or the document's.
- A batch holds at most 10,000 rows, and `remove()` works through a collection 500 records at a time, each
  page its own transaction.

## Coming from RxDB

Collections work much as they do in RxDB: `insert`, `upsert`, `bulkInsert`, `bulkUpsert`, `bulkRemove`,
`findByIds` and `remove()` are all here, and `insertIfNotExists()` is `insertIfAbsent()`. A collection
needs no schema, a bulk write is one transaction rather than a write per document, and a duplicate id inside
one batch is a row's verdict instead of an exception for the whole call.

::: code-group

<<< @/examples/collection.mjs#bulk [syncom]

<<< @/examples/rxdb/collection.mjs#bulk [RxDB]

:::

<FromRxdb page="rx-collection" :rows="['bulk', 'upsert', 'insertIfAbsent', 'findByIds', 'collectionStream', 'changeAndDelete']" />

Every member of a collection is in the [API reference](../reference/api#collection).
