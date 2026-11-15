---
title: Query optimizer
description: How syncom picks an index for each query, how to read the plan with explain(), and how indexAdvisor() names the indexes your queries are missing.
---

# Query optimizer

Every query is planned when it first runs: syncom looks at the indexes the collection declares, estimates how many
records each would make it read, and takes the cheapest. There is nothing to run at build time and no hint to
write. What you do is declare the right indexes, and two tools tell you which: `explain()` shows how one query is
answered, and `indexAdvisor()` watches the queries your app makes and names the indexes they asked for and did not
get.

## See how a query is answered

Declare indexes in the collection's `index` list: a field, or a compound key of several fields.

<<< @/examples/query-optimizer.mjs#open

`explain()` on any cursor returns its plan, without running it:

<<< @/examples/query-optimizer.mjs#explain

The plan reads top to bottom. `scan: 'index'` with `index: ['boardId', 'rank']` says a sorted index answers it;
`prefix: ['b1']` is where the scan enters it, and `range` bounds the field after. `sortedByIndex: true` means the
rows come out of the index already in the order asked for, so a `limit(4)` reads four records and stops.
`residual: false` means the index decided every condition, and `estimate` is how many records the plan expects to
read. Every field is described in the [cursor reference](../reference/api#cursor).

## How the planner picks an index

<FigQueryPlan />

An index serves a query field by field, left to right. First come the fields the query holds an equality on
(`boardId: 'b1'`), as many of the index's leading fields as it can match. After them, one field may take a `$in` of
up to 16 values (one scan per value), and the next a range (`$gt`, `$gte`, `$lt`, `$lte`) or the sort:

<<< @/examples/query-optimizer.mjs#in

The rows come sorted by the index when the order's fields are the index's next fields, all in one direction, and
reach its end; a descending sort scans the index backwards. Otherwise the planner still uses the index to find the
rows and sorts them after. When several indexes fit, it takes the one expected to read the fewest records,
counting the entries between the scan's edges, the size of any posting list it can narrow by, and the window when
the rows come sorted. A tie goes to the scan that walks fewer entries, then to the sorted one, then to the longer
prefix. An index that would serve only the sort is taken only for a query with a `limit()`, and only when no indexed
equality could narrow the candidates instead.

A condition the index does not decide is tested on each record the scan yields; the plan says so with
`residual: true`:

<<< @/examples/query-optimizer.mjs#residual

## Queries no index serves

<<< @/examples/query-optimizer.mjs#unserved

When no index fits but the query holds an equality or a `$in` on an indexed field, that field's posting list
narrows the candidates before any record is read (`scan: 'postings'`). An indexed array field, such as a
[set](./fields) of tags, is posted under each element, so `{ tags: 'bug' }` narrows to the records holding it. The
narrowing follows every `$and` branch, and an `$or` whose branches each hold an indexed equality is narrowed by
their union when it runs, although `explain()` reports such a query as a `collection` scan.

Anything else reads the whole collection: from the cache for recent records, from the storage otherwise, sixteen
at a time, with the conditions tested on each. That is fine for the tens of thousands of records a local-first
app holds. An unordered query with a `limit()` stops at enough matches, and an ordered one keeps only the best
`offset + limit` rows as the candidates go by, so the cost is the reading, not the memory.

## Answer a query from the index alone

When every field a query tests, sorts by and returns is indexed, and there is no `filter()`, the catalog answers it
without reading a single record:

<<< @/examples/query-optimizer.mjs#covered

Without the projection the rows are whole records, which must be read. `count()` gets the same benefit more often:
when one index decides every condition, the count is the number of its entries.

## Find the indexes your app needs

`indexAdvisor()` from `@alexify/syncom/inspect` watches every plan the database's cursors make from the moment you
start it. A query an index served in order asks for nothing; one that scanned the collection, narrowed by a posting
list, or sorted after the scan asks for the index that would have served it: its equality fields, then a range
field, then the sort's fields.

<<< @/examples/query-optimizer.mjs#advisor

Run it while you exercise the app, in development or behind a debug flag, and read `suggest()`: the keys most asked
for come first. Then declare the index. The catalog builds it at the next open:

<<< @/examples/query-optimizer.mjs#add-index

A collection created at run time takes its indexes in `addCollections()`. The [devtools](./devtools) page shows the
other inspectors of the same subpath.

## When the planner cannot help

- Indexes live in memory, in the catalog, on every storage. They make a query read fewer records; they do not let a
  node hold more records than its memory allows for the catalog.
- An array-valued key is entered once per element and never trusted for a sort.
- A `$text` query is the [full-text index](./fulltext-search)'s ranking and plans no index; equalities narrow it.
- A `filter(fn)` sees the loaded record, so a cursor with one always reads records and is never covered.
- [Sealed records](./encryption) are in no index. They are read whole beside the plan, and `explain().sealed` says
  how many.

## Coming from RxDB

RxDB's planner also rates one index per query and takes the best; its query optimizer is a premium tool you run at
build time against test data to choose the indexes to declare. syncom's advisor works from the queries your app
actually makes, at run time, and its planner can use posting lists of several fields in one query. Both expose the
plan:

::: code-group

<<< @/examples/query-optimizer.mjs#explain [syncom]

<<< @/examples/rxdb/query-optimizer.mjs#explain [RxDB]

:::

<FromRxdb page="query-optimizer" :rows="['planner', 'explain', 'queryOptimizer', 'indexCombination', 'coveredQueries', 'sortIndex']" />
