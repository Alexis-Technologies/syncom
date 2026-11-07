# src/query/CLAUDE.md — Queries

The cursor over `storage[SOURCE]`. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/query/query.js        @alexify/syncom/query — the query plugin: setup hands the core a cursor factory (`query` hook); select()/count()
                          on a Collection go through storage[CURSOR], PLUGIN_MISSING without it
src/query/cursor.js       compileQuery (Mango predicate), compareRows, Cursor — reads through storage[SOURCE]; requires live.js, cache.js,
                          plan.js beside the core's shape.js, catalog.js and search/distance.js
src/query/plan.js         plan — how a cursor is answered over the declared indexes (the prefix of equalities, a range, the sort), what
                          explain() shows — no requires
src/query/live.js         Live — a live query kept by event-reduce over the catalog's action stream (rows, or a count) — requires shape.js only
src/query/cache.js        QueryCache, keyOf — a result by its key with the catalog's generation, the one live run every watch() of a
                          key shares, an LRU of unobserved results — no requires
```

## Rules

- **A query is checked at compile time, and bounded.** `compileQuery` refuses an unknown operator, a malformed one, a
  `$regex` or `$text` past 1000 characters and a query nested past `MAX_QUERY_DEPTH` (32) levels — `$and`/`$or`/
  `$nor`/`$not`/`$elemMatch` within one another — as a TypeError, never a RangeError from the recursion.
- **A cursor reads through `storage[SOURCE]`, not through `get()`.** The
  seam hands it the catalog and a lensed, hook-free `load(id)` — like
  `snapshot()` and `swap()`; the cursor itself is the query plugin's
  (`src/query/cursor.js`), made through `storage[CURSOR]` (a Collection's
  `select()`, a tag view's through `core.cursor`). `Cursor#matching` is the one place that reads
  records for a query: sixteen at a time, in candidate order, into a `TopK`
  when the cursor is ordered and limited (the rows come back sorted, `fetch`
  must not sort again) or an `Every` otherwise; `Catalog.candidates` narrows
  through `$and`/`$or`, and `ids()`/`indexed()` hand out cached, shared
  arrays and sets — never edit what they return. Indexed and unique values are
  keyed canonically (`keyOf`: object keys sorted at every depth), as the
  predicate compares them. Unique keys are checked after validation and
  the fold, before `#log.append` (local: throw) and after `applyOp` on the
  apply path (remote: `conflict` event, never a skip — both records stay).
- **A cursor is planned over the catalog's sorted indexes.** An entity's `index` is a list of keys — a
  field, or a compound key of fields — each a sorted index the catalog keeps (`Catalog#keyed`: a `SortedIndex` each — src/sorted.js, chunked sorted arrays in `compare` order then id — built
  once at load, a put re-keying only the indexes a changed field belongs to; `multi` counts the rows keyed per
  element of an array, `overflow` the rows whose array passed the cap, keyed whole and yielded by every scan)
  beside the equality postings of every field named. `plan()` (src/query/plan.js, pure) fits every index — the longest prefix of
  equalities, a `$in` of a few ordered values on the next field (one sub-scan per value, `#scanIn`), then a range
  or the sort — and picks the one expected to read the fewest records (`estimate`: the scan's entries, the
  narrowest posting list it leaves to `narrow`, the window where sorted; the sort alone only for a finite window
  with nothing to narrow); `Catalog.scan(type,
plan)` reads the entries between two binary searches, forward or backward; where `sortedByIndex` the
  cursor reads the window and stops (`enough`), otherwise a TopK or a sort after. `compare`/`rankOf` are
  the catalog's, shared with the cursor. `explain()` is the plan as a copy. A `$text` query keeps the
  ranking and plans nothing.
- **A sealed record is read, never indexed.** A collection's `encrypted: true` records are rows with no fields; the
  seam lists them (`[SOURCE].sealed(entity)`, `Catalog.sealed`: cached per type, dropped at every bump) and `load`
  opens them (a copy of the data as the key here reads it, no meta to compose). `Cursor#matching` adds them to the
  candidates of every plan over the collection (`withSealed`: every id once), lets them past `narrow`'s posting
  lists and reads them whole — in the covered loop too, where a plain row stays the catalog's — and gives up
  `byIndex` while one is there (a TopK sorts); `count()` adds the sealed records that match (`#sealedMatches`) to
  the index's estimate. A `$text` query never sees them (the text index did not), and a tag's source lists none.
  The cost is the sealed records read, not the collection's rows — a blind index is not here yet.
- **A cursor is immutable, a result has one order, a live query is kept, not run.** Every builder hands
  back a new Cursor (`#clone`). A result is ordered by its keys then the id (`compareFully`; a `$text`
  query without keys keeps the index's ranking), so a page has an edge and a live result places a row
  where a run would. `watch()` and `watchCount()` are a `Live` (src/query/live.js) over the catalog's
  `subscribe(type, fn(changed, id, action))`: the record that changed is read once (`rowOf`), matched
  and placed; a full window that lost a row, a row moved to the end of a full window, or a `$text`
  query runs the cursor again (`top()`); it emits only when an id came, went or moved, or a row's view
  (`row[VIEW]`, the object it was built from) is another; a failure goes to `onError` or the logger, and an `onError`
  that throws to the logger too (`#fail`), as does an advisor that throws (the seam's `planned`, `listener.error`)
  — and delivers a row that stayed as the copy it delivered
  before (`#delivered`, by id and the row object; `deliverOne` of the spec, none where something is populated), so a
  change is one copy. `nearest()` streams the rows into a `Nearest` sink (`#matching(…, into)`): `k` rows held,
  `MAX_NEAREST`/`MAX_VECTOR` bound what it takes. The plugin keeps one `QueryCache`
  (src/query/cache.js) per database: every `watch()` of a key (`keyOf([entity, query, order, window,
projection, populate])`, built once per cursor) shares one Live, whose rows are the key's result while it runs; a
  `fetch()` of a key whose collection's `generation(entity)` (`Catalog.generationOf`: moved by a put of a record of the
  collection — a no-op put too — by its definition, by a load or an adopt; never by another collection) has not moved
  since reads nothing; the idle results hold `MAX_ROWS` (10 000) rows between them at most, a larger one alone is not
  kept. A `filter(fn)` has no key. A tag's source has no `generation`: nothing of it is cached, and `watch()` throws
  there.
