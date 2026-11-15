---
title: Query
description: Find records with Mango queries, sort and page the results, keep a live query up to date, and change or delete everything a query matches.
---

# Query

`select(query)` on a collection returns a cursor: a description of which records you want, in what order
and how many. Nothing is read until you call `fetch()`, `one()`, `count()` or `watch()`. The query is a
MongoDB-style object (the Mango syntax), and the cursor works out how to answer it from the catalog of
indexed fields that every database keeps in memory, reading records only when it must.

Queries are the `query` plugin, which `@alexify/syncom/all` registers. The examples on this page use this
board:

<<< @/examples/query.mjs#data

## Find records

`fetch()` returns every match as a plain object with the record's `id`. `one()` returns the first match or
`null`, and `count()` counts the matches without returning them:

<<< @/examples/query.mjs#find

`{ field: value }` matches equal values, and `{ field: { $op: value } }` uses an operator: `$gt`, `$in`,
`$exists`, `$regex` and the others. [Query examples](./query-examples) shows each operator on this board.
A malformed query (an unknown operator, `$in` without an array) is a `TypeError` at `select()`, before
anything runs. A misspelled field name is not an error; it matches nothing.

The rows `fetch()` and `one()` return are copies of the records as they read, with `$type` included, so
you can change them freely. A cursor reads the records directly and does not run the `beforeRead` and
`afterRead` [hooks](./hooks); `get()` does.

## Sort, limit and skip

`order(field)` sorts ascending and `desc(field)` descending; several calls add tie-breakers in the order you
make them. `limit(n)` and `offset(n)` cut the result after the sort.

<<< @/examples/query.mjs#sort

Values sort with missing and `null` first, then booleans, numbers and strings; arrays and objects keep their
place. Ties, and a cursor with no order at all, fall back to the record id, so a result always comes in the
same order. Each builder returns a new cursor and leaves the one you called it on as it was;
[Query builder](./query-builder) shows how to reuse a base query.

## Keep records in an order you choose

To let users drag tasks into their own order, keep a position in a plain field and sort by it.
`between()` from `@alexify/syncom/order` makes position keys: strings that sort with `<` and always leave
room between two neighbors, so moving a task writes one field and never renumbers the rest.

<<< @/examples/query.mjs#position

Two nodes that drop a task into the same gap at once pick their own keys, and `jitter` adds random digits
so they rarely pick the same one; if they do, the two tasks tie and sort by id until one moves. To order the
elements inside one record instead, use a [list](./lists) field, which merges by position on its own.

## Page through results

`page()` returns up to `limit` rows and a `next` token; `after(next)` continues right after the last row of
that page. The token holds the last row's sort keys and id, so a record added between two pages is placed
where it sorts and no row is read twice. A page with fewer rows than the limit is the last one, and its
`next` is `null`.

<<< @/examples/query.mjs#page

To walk every result in bounded memory, iterate the cursor with `for await`. It reads the rows a batch at a
time the same way (100 rows unless you call `stream({ batch })`):

<<< @/examples/query.mjs#stream

## Watch a query

`watch()` calls your listener with the current rows right away and again whenever a write changes the
result, whether the write was made here or arrived from another node. It returns the function that stops
it.

<<< @/examples/query.mjs#watch

A live query is kept up to date rather than run again: when a record changes, the database reads that one
record, checks it against the query, and moves it in, out or within the result. Your listener is called
only when the rows actually changed. The first call comes a microtask after `watch()`, and an error, from
the query or from your listener, goes to `{ onError }` if you pass one, or to the logger. A row that did not
change is handed to the listener as the same object as before, which lets a UI skip it; the rows belong to
the live query, so read them and copy one before you change it.

`watchCount()` does the same for the number of matches, moving it by one per change instead of counting
again:

<<< @/examples/query.mjs#watch-count

Every `watch()` of the same query (the same collection, conditions, order, window and projection) shares
one live run, and a `fetch()` of that query while it runs reads nothing; [Query cache](./query-cache)
explains what else is reused. To use a live query from React, Svelte, Vue or Solid, wrap it with
`toStore()` from `@alexify/syncom/store` ([Reactivity](./reactivity)).


## Change or delete what a query matches

`update()`, `modify()` and `delete()` on a cursor write every match as one transaction. Each record is
checked against the query again inside the write queue, so a record that changed in between is skipped and
not counted in `written`:

<<< @/examples/query.mjs#write

`update()` takes the same fields and operators as a collection's `update()`, and `delete({ data })` puts
the data on every tombstone. One call writes at most 10,000 records; past that it is a `TypeError` before
anything lands, so narrow the query or page through it with `limit()`.

## Count distinct values

`distinct(field)` lists the values a field takes among the matches, and `countBy(field)` adds how many
records hold each. Both are on a cursor and on a collection, which takes the query as its second argument:

<<< @/examples/query.mjs#aggregate

There are no sums, averages or group pipelines. Compute those over `stream()`, or keep them up to date in
another collection with a [pipeline](./pipeline).

## Test a record against a query

`matches(record)` tells you whether a record in hand would match the cursor's query, without reading
anything. It is handy to decide in your own code whether a record that arrived belongs in a list:

<<< @/examples/query.mjs#matches

## Make queries fast

A query on indexed fields reads only the records that match, and one that sorts by an index reads no more
than the window it returns. Declare the fields you filter and sort on in the entity's `index`
([Schema](./schema#index-fields-for-queries)), and ask a cursor how it will run with `explain()`:

<<< @/examples/query.mjs#explain

[Query optimizer](./query-optimizer) explains the plan, compound indexes and covered queries, and
`indexAdvisor()` from `@alexify/syncom/inspect` suggests the indexes your queries are missing.

## Search text and vectors

`$text` searches the words of the fields an entity names in `search`, best match first:
[Full-text search](./fulltext-search). `nearest()` ranks matches by distance to a vector:
[Vector search](./vector-search).

## Encrypted records in results

A record written with `encrypted: true` is sealed for this node, and the catalog knows nothing of its
fields. A query on the node that holds the key still finds it: the sealed records of the collection are
decrypted and matched beside the indexed ones. `select(query, { sealed: false })` leaves them out. Reads
that leave the node (a host serving queries to a thin client, an agent's tools, a connector) never include
them, and neither does `$text`. Each sealed record costs a read and a decryption per query, so keep them
few; [Encryption](./encryption) has the details.

## Limitations

- The catalog of indexed fields lives in memory, and a query that no index serves reads every record of
  the collection. That is fine for the tens of thousands of records a local-first app holds, and the wrong
  tool for millions.
- A `$regex` runs on the event loop of the node that answers it, and a pathological pattern can block it.
  A host that answers queries from peers refuses a `$regex` from the wire unless you allow it.
- Comparisons only hold between values of one kind: `{ due: { $gt: 5 } }` never matches a string `due`.

## Coming from RxDB

`find({ selector })` becomes `select(query)`, with the selector as the argument itself, and `exec()`
becomes `fetch()`. `sort`, `limit` and `skip` are cursor methods, and a query's `$` observable is
`watch()`. Projections, keyset paging with `page()`/`after()`, and `count()` over any query are built in.

::: code-group

<<< @/examples/query.mjs#watch [syncom]

<<< @/examples/rxdb/query.mjs#watch [RxDB]

:::

<FromRxdb page="rx-query" :rows="['liveQueries', 'liveCount', 'streaming', 'count', 'byQuery', 'aggregation']" />

Every member of a cursor is in the [API reference](../reference/api#cursor).
