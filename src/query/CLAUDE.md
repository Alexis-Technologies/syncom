# src/query/CLAUDE.md — Queries

The cursor over `storage[SOURCE]`. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/query/query.js        @alexify/syncom/query — the query plugin: setup hands the core a cursor factory (`query` hook); select()/count()
                          on a Collection go through storage[CURSOR], PLUGIN_MISSING without it
src/query/cursor.js       compileQuery (Mango predicate), compareRows, Cursor — reads through storage[SOURCE]
```

## Rules

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
