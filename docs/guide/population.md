---
title: Population
description: Declare which fields of a record point at other records, follow them from a document with Reference, and resolve them in a query with populate().
---

# Population

A task has an assignee, and the assignee is a record of its own. syncom stores the reference as the id of the other
record, a plain string, so it syncs and merges like any other field. Declare which fields are references, and
syncom resolves them for you: one at a time from a [document](./document), or for every row of a
[query](./query).

## Declare references

<<< @/examples/population.mjs#schema

`refs` maps a field to the collection it points at: a collection name for one record, a one-element array for many.
With a metaschema schema you do not need `refs`: a relation in the model (`assignee: 'Person'`, `{ many: 'Tag' }`)
declares it.

## Store a reference

<<< @/examples/population.mjs#write

Write the id. Nothing checks it on write, because a reference may arrive before the record it points at: on another
device the person may be created a moment later and sync in after the task.

## Follow a reference from a document

<<< @/examples/population.mjs#reference

On a document, a declared field reads as a `Reference`: `id` is the id, `document()` resolves it to the live
document of the record it names, and `toJSON()` gives the id back, so serializing a document writes the id as it
was stored. A field declared as many is an array of `Reference`s.

`populate(field)` on the document resolves a field in one call, a document for one or an array for many:

<<< @/examples/population.mjs#document-populate

## Resolve references in a query

<<< @/examples/population.mjs#cursor

`populate(fields)` on a cursor replaces each declared field of every row with the record it names, as a plain
object with its `id`. It reads each field once per page of results, not once per row.

## When the record is gone

<<< @/examples/population.mjs#missing

A reference to a record that was deleted, was never written, or belongs to another collection than the declared
one resolves to `null`. Deleting a record does not touch the records that point at it; decide in your app whether
to clear them, delete them too, or show the gap.

Only declared fields become references. A field that happens to hold an id stays a string:

<<< @/examples/population.mjs#undeclared

## Limitations

- References are not foreign keys. Nothing prevents writing an id that does not exist, and nothing cascades on
  delete.
- Population reads the referenced records from this node. Under [partial sync](./partial-sync) a referenced record
  outside the node's scopes is not there and resolves to `null`.
- Population goes one level deep. To follow a reference of a referenced record, call `document()` or `populate()` on
  the result.

## Coming from RxDB

RxDB declares a reference with `ref` in the JSON schema and resolves it with `populate()` or a getter with a
trailing underscore. syncom declares it beside the collection (`refs`) or in a metaschema relation, gives a document
a `Reference` you can pass around, and populates a whole query in one call.

::: code-group

<<< @/examples/population.mjs#schema [syncom]

<<< @/examples/rxdb/population.mjs#schema [RxDB]

:::

<FromRxdb page="population" :rows="['relations', 'orm']" />

`Reference`, `populate()` and `refs` are in the [reference](../reference/api#document).
