---
title: Query builder
description: Build queries by chaining cursor methods, reuse a base query, compose conditions in plain JavaScript, and filter, project and populate the rows.
---

# Query builder

A syncom cursor is already a chain: `select()` takes the conditions, and `order()`, `desc()`, `limit()`,
`offset()`, `filter()`, `projection()` and `populate()` shape the result. What syncom does not have is a
builder for the conditions themselves, in the style of `where('priority').gte(2)`. The condition is a
[Mango query](./query-examples) object, and plain JavaScript builds it.

## Chain a query

<<< @/examples/query-builder.mjs#chain

Sort keys apply in the order you add them: here by priority, highest first, then by due date. `limit()` and
`offset()` cut the result after sorting. `projection()` keeps only the named fields in each row (plus `id`);
a dotted field comes back under its dotted name.

## Reuse a base query

Every method returns a new cursor and leaves the one you called it on untouched, so a base query can be
shared and refined in several directions:

<<< @/examples/query-builder.mjs#reuse

A cursor holds no results and no connection; it describes a query, and nothing is read until `fetch()`,
`one()`, `count()`, `page()` or `watch()`.

## Compose conditions in plain JavaScript

Where a builder would add a `where()` call per condition, build the query object instead. Conditions on
several fields all have to match, so adding a key narrows the query:

<<< @/examples/query-builder.mjs#compose

For alternatives, collect queries into an array under `$or`; for two conditions on the same field, merge
the operators into one object (`{ priority: { $gte: 2, $lt: 5 } }`) or use `$and`.

## Filter with a function

`filter(fn)` keeps the rows your function accepts, for conditions a query cannot express. It runs over the
loaded rows, before `limit()` and `offset()`:

<<< @/examples/query-builder.mjs#filter

A cursor with a filter always reads the records the query matches and is never served from the
[query cache](./query-cache), so let the query do as much of the narrowing as it can and keep the filter for
the rest.

## Resolve references

`populate(fields)` replaces each declared [reference](./population) in the rows with the record it points
to, reading each referenced collection once per page:

<<< @/examples/query-builder.mjs#populate

## Limitations

- There is no `where().gt()` builder: conditions are objects. Field names in them are strings, checked by
  the types when the collection is typed ([TypeScript](./typescript)) and not at all otherwise.
- `filter()` is JavaScript running in your process: it cannot use an index, a host cannot run it for a thin
  client, and it does not travel over the wire.

## Coming from RxDB

RxDB's query builder plugin turns `where('done').eq(false)` into a Mango selector; in syncom you write the
selector, and keep chaining for the order, the window and the shape of the rows. Projections and a
JavaScript predicate are part of the chain, which RxDB leaves out on purpose.

::: code-group

<<< @/examples/query-builder.mjs#chain [syncom]

<<< @/examples/rxdb/query-builder.mjs#chain [RxDB]

:::

<FromRxdb page="query-builder" :rows="['queryBuilder', 'immutableQueries', 'jsPredicate', 'projection']" />
