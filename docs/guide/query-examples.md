---
title: Query examples
description: A cookbook of Mango query operators on the task board, from equality and ranges to arrays, regular expressions, nested fields and logical combinations.
---

# Query examples

Every query on this page runs against the same small board, and the comment after each one lists the ids
it returns. A query without an `order()` returns its rows by id, which is the order shown. [Query](./query)
covers the cursor itself: sorting, paging and live queries.

<<< @/examples/query-examples.mjs#data

`tags` is a [set](./fields), so it reads as an array sorted by element, and `votes` is a counter, which
reads as a number. A query sees every field as it reads, whatever its kind: a set or a list is its array, a
text its string, a tree its array of nodes.

## Match a value

`{ field: value }` matches records whose field equals the value; objects and arrays are compared deeply.
`$eq` says the same explicitly, and `$ne` matches everything else, records without the field included.

<<< @/examples/query-examples.mjs#equality

## Match one of several values

`$in` matches any of the listed values and `$nin` none of them. The record id is a field like any other in
a query, so `{ id: { $in: ids } }` selects records by id.

<<< @/examples/query-examples.mjs#in

## Compare values

`$gt`, `$gte`, `$lt` and `$lte` compare values of one kind: a number with a number, a string with a string,
a boolean with a boolean. Anything else never matches, so a string field compared with a number matches
nothing rather than everything. ISO dates stored as strings compare in date order.

<<< @/examples/query-examples.mjs#compare

## Check that a field exists

`$exists: true` matches records that have the field, even when its value is `null`, and `$exists: false`
records that do not. `$type` matches by what the value is, in JSON's terms: `'null'`, `'boolean'`,
`'number'`, `'string'`, `'array'` or `'object'`.

<<< @/examples/query-examples.mjs#exists

## Query arrays

A plain value matches an array field that holds it as an element. An array value matches the whole array,
in order. `$all` asks for every listed element, and `$size` for an exact length.

<<< @/examples/query-examples.mjs#arrays

`$elemMatch` matches an array with at least one element that passes a query of its own: the fields of an
object element, or the operators for a scalar one.

<<< @/examples/query-examples.mjs#elem-match

## Match a pattern

`$regex` takes a regular expression or its source as a string, with flags in `$options`. It matches strings
(any element of an array of strings); the `g` and `y` flags are dropped, since they make a regular
expression remember where it stopped. A `RegExp` written as a plain value is compared for equality, so put
it under `$regex`.

<<< @/examples/query-examples.mjs#regex

A pattern runs on the event loop of the node that answers the query, and some patterns take minutes on a
long string. Write patterns anchored and simple, and remember that a host serving queries to peers refuses
a `$regex` from the wire unless you allow it.

## Reach into nested fields

A dotted path reaches into objects, and a number in the path into an array by position. Paths work in
queries, in `order()` and in `projection()`.

<<< @/examples/query-examples.mjs#dotted

A dotted path in a query reads the record as it is shaped. A field written by path, such as
`update(id, { 'assignee/name': 'ada' })`, reads as a nested object too, so the same `'assignee.name'` query
finds it ([Fields that merge](./fields#edit-part-of-an-object)).

## Combine conditions

Several fields in one query must all match. `$and`, `$or` and `$nor` take arrays of queries, and `$not`
takes one query and matches what it does not; they nest freely, up to 32 levels deep.

<<< @/examples/query-examples.mjs#logical

## Test a remainder

`$mod: [divisor, remainder]` matches numbers with that remainder.

<<< @/examples/query-examples.mjs#mod

## Malformed queries

An unknown operator, a misplaced one or an argument of the wrong shape is a `TypeError` thrown by
`select()` itself, so a typo in a query fails where you wrote it rather than returning nothing:

<<< @/examples/query-examples.mjs#malformed

A misspelled field name is not malformed, though: it is a field no record has, and matches nothing. For
words rather than patterns, use [full-text search](./fulltext-search) with `$text`. Every operator and its
exact rule is in the [API reference](../reference/api#the-query).

## Coming from RxDB

The operators are the Mango ones you know, with the same names and meanings, and the selector is passed
directly to `select()` instead of under `selector`. Comparisons between values of different kinds never
match, a `RegExp` object is accepted under `$regex`, and a query can test the record id as `id`.

<FromRxdb page="rx-query-examples" :rows="['opComparison', 'opSet', 'opExistence', 'opArray', 'opRegex', 'opLogical', 'opMod', 'dottedPaths']" />
