---
title: Query cache
description: How every watch() of one query shares a single live run, how fetch() reuses its rows, and how long unobserved results stay valid in syncom's query cache.
---

# Query cache

A task board shows the open tasks of a board twice: as a count in the header and as the list itself. Both ask the
same query. When the user opens another board and comes back, the app asks it a third time. Running the query
once per caller would read the same records again and again, and keeping two live copies would place every change
twice. syncom's query plugin keeps one cache per database so that a query asked many times costs about as much as
a query asked once.

<FigQueryCache />

## Share one run between every watcher

<<< @/examples/query-cache.mjs#shared

The two cursors are the same query written with the keys in another order, and they share one live run. The run
keeps the result as the collection changes, placing each changed record once, and hands the rows to every listener.
`db.stats().query.live` counts the runs, not the listeners.

Two cursors are the same query when they name the same collection, the same conditions (in any key order), the same
`order()`, the same window (`limit()`, `offset()`, `after()`), the same `projection()` and the same `populate()`.
The `watchCount()` calls of one query share a run of their own the same way.

## Fetch what a run already holds

While a run lasts, its rows are the query's result. A `fetch()` of the same query returns copies of them and reads
nothing:

<<< @/examples/query-cache.mjs#fetch

This is what makes "show the list, then fetch it again on a click" free: the second call is answered from memory.

## Keep results after the last watcher leaves

When the last listener stops, the run ends but its result stays, and so does the result of any plain `fetch()`:

<<< @/examples/query-cache.mjs#idle

A kept result is used for as long as its collection has not changed: no record of that collection written here or
received from a peer, the collection not defined again, the catalog not reloaded. Writes to other collections do
not count, so the `Tag` insert above leaves the task query's result valid. The first write to `Task` makes every
kept `Task` result stale, and the next `fetch()` of each runs again.

The cache holds up to a hundred such results, with ten thousand rows between them, and lets go of the least
recently used first. A result of more than ten thousand rows is not kept at all. Results that a live run keeps do
not count toward either bound.

## What is never cached

<<< @/examples/query-cache.mjs#uncached

A cursor with a `filter(fn)` has no key, because a function cannot be compared, so it runs every time and each of
its `watch()` calls gets a run of its own. A cursor at a [tag](./versions) reads a past that never changes and is
read every time. `count()` is not cached either.

## Read the rows, do not change them

`fetch()` hands you copies, yours to change. A `watch()` listener gets the run's own rows, and a row that did not
change is the very object it received last time. That makes "did this row change?" an identity check, which is
what memoized UI components want, and it is why a change costs one copy however large the result. Treat those rows
as read-only: every listener of the query receives the same objects, so an edit would show up in all of them.

## See the cache at work

`db.stats().query` answers `{ cache: { entries, rows }, live }`: the keys the cache holds, the rows of the results
no run keeps, and the live runs. With the [telemetry](./telemetry) plugin, every `fetch()` of a cursor with a key
counts a hit or a miss on the `syncom.query.cache` metric.

## Trade-offs

The bounds are fixed, and there is no replacement policy to plug in: the cache is sized for what one screen of an
app asks, not for precomputing reports. Staleness is decided per collection, not per query, so a collection written
to several times a second rarely answers a `fetch()` from an idle result; its live runs stay current all the same,
since they are kept, not rerun. Memory is the price: up to ten thousand idle rows per database, plus the result of
every live run.

## Coming from RxDB

RxDB caches query objects: two `find()` calls with the same selector return one `RxQuery`, and a replacement policy
you can replace decides which unobserved queries to drop. syncom caches by what a cursor asks rather than by object,
so two cursors built separately still share a run and a result, and the policy is fixed. Both keep a result current
by placing changes into it instead of running the query again.

::: code-group

<<< @/examples/query-cache.mjs#shared [syncom]

<<< @/examples/rxdb/query-cache.mjs#shared [RxDB]

:::

<FromRxdb page="query-cache" :rows="['queryCache', 'immutableQueries']" />
