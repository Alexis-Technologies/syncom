# src/search/CLAUDE.md — Full-text search

`$text` as the catalog's. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/search/search.js      the @alexify/syncom/search subpath — the trigram text index behind `$text`; the core knows only the TextIndex contract
```

## Rules

- **`$text` is the catalog's.** An entity's `search` fields are joined into
  its catalog row as `row.text` (format 3, a seventh cell) and handed to the
  injected `TextIndex` (`open({ search })`, built per entity in
  `#defineSchema`) LAZILY: `#insert`/`#remove` leave the last word per id in
  `#textPending`, and `candidates` flushes it before a `$text` query reads the
  index (re-indexing a text on every keystroke cost the whole text each time)
  — under a try/catch that logs `catalog.search`: derived state never fails a
  write. A `put` that leaves a row as it was posts nothing, saves nothing and
  wakes the watchers with `changed: false` — a covered cursor does not run. `compileQuery` takes
  `$text` at the top level only and makes no test of it; `fieldsOf` skips it;
  `Catalog.candidates` seeds `#narrow` with the index's ranked ids (a fresh
  Set) and every `meet` keeps the seed's order, so an unordered cursor hands
  rows out best first. Never apply a limit inside the index (the equality
  intersection comes after, and `count()` needs every match), never persist
  the index — `load()` replays the rows through `#insert` (into the pending
  map) — and never let the
  core normalize text: that is `src/search/search.js`'s, a subpath with no requires.
