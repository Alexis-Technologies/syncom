---
title: ORM
description: Give every document of a collection its own methods and the collection its own functions, with methods and statics in the entity definition.
---

# ORM

Logic that belongs to a kind of record, such as how a task labels itself or which tasks count as open, tends to
end up scattered across the app. Put it on the collection instead: `methods` become functions of every
[document](./document) of the collection, and `statics` functions of the [collection](./collection) itself.

## Add methods and statics

<<< @/examples/orm.mjs#define

Inside a method, `this` is the document, so it reads the record's fields as properties and can call `save()`,
`inc()`, `delete()` and the rest of the document's API. Inside a static, `this` is the collection, so it can
`select()`, `insert()` and so on.

## Use them

<<< @/examples/orm.mjs#use

A collection's `insert()` returns a document, so the methods are there at once. `document(id)` returns the same
kind of document for a record that exists. Rows from a query are plain objects, not documents, and have no
methods; take the `id` and call `document(id)` when you need them.

## Methods are not data

<<< @/examples/orm.mjs#hidden

Methods are bound to the document and hidden from enumeration, so they never end up in the record, in
`JSON.stringify()` of a document, or in what syncs to other nodes. Every node runs the methods of its own code: a
node on an older version of the app calls its older methods on the same records.

## Names a document already has

A method or a static cannot take a name the document or the collection already answers to (`save`, `data`,
`delete`, `select`, `insert`, `id`...). `createDatabase()` refuses such a definition with a `TypeError`, so a typo
never silently replaces a built-in:

<<< @/examples/orm.mjs#clash

## Coming from RxDB

The same `methods` and `statics` as in RxDB, declared on the collection. RxDB also has attachment methods; syncom's
[attachments](./attachments) live on `db.attachments` for every record, so there is nothing per collection to add.

::: code-group

<<< @/examples/orm.mjs#define [syncom]

<<< @/examples/rxdb/orm.mjs#define [RxDB]

:::

<FromRxdb page="orm" :rows="['orm', 'relations']" />

`methods` and `statics` are part of the entity definition in the [reference](../reference/api#collection).
