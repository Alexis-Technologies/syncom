# Queries

`collection.select(query)` is a cursor over a collection: build it, then
`fetch()`, `count()`, `one()`, iterate it, or `watch()` it. The query is
Mango-shaped, as in CouchDB and MongoDB; the cursor plans how to answer it
from the record catalog, and reads records only when it must.

```js
const storage = await open({
  path: 'data',
  schema: { entities: { Task: { index: ['boardId', 'status'], unique: ['key'] } } },
});

await storage.Task.select({ boardId: 'b1', status: 'open' }).fetch();             // [{ id: 'T-1', boardId: 'b1', status: 'open', … }]
await storage.Task.select({ priority: { $gte: 2 }, tags: 'bug' }).order('priority').fetch();
await storage.Task.select({ 'assignee.name': 'ada' }).fetch();                     // a dotted path
await storage.Task.select({ $or: [{ status: 'done' }, { boardId: 'b2' }] }).desc('priority').projection(['key', 'priority']).fetch();
// [{ id, key: 'T-3', priority: 3 }, { id, key: 'T-2', priority: 1 }]
await storage.Task.count({ status: 'open' });                                      // 2
await storage.Task.select({ key: { $regex: '^T-[12]$' } }).count();                 // 2
await storage.Task.select({ tags: { $exists: true } }).filter((row) => row.tags.length === 0).one();
for await (const row of storage.Task.select({ boardId: 'b1' }).order('key').limit(100)) render(row);
```

## The query

| Form | Matches when |
| --- | --- |
| `{ field: value }` | The field equals the value (deep); an **array** field holds the value as an element (indexed or not — a set, or any array); an array value matches an array field whole |
| `{ 'a.b': value }` | A dotted path reaches into the record |
| `$eq`, `$ne` | Equality, as above, and its negation |
| `$in`, `$nin` | Any of the values matches (the array rule applies), or none does |
| `$gt`, `$gte`, `$lt`, `$lte` | Ordered comparison between values of **one kind** — number with number, string with string, boolean with boolean; anything else is false. An array field: any element |
| `$exists` | `true`: the field is present (`null` counts); `false`: absent |
| `$regex`, `$options` | A `RegExp` or a source string, with flags; strings only (an array field: any element); the `g` and `y` flags are dropped |
| `$and: [...]`, `$or: [...]`, `$not: {...}` | Nest freely |
| `$text: 'words'` | Full-text, over the entity's `search` fields through the injected index; top level only, once — see [Full-text search](#full-text-search) |

A malformed query — an unknown operator, `$in` without an array, an invalid
regex, a `$text` that is not a string, is over 1000 characters or sits inside
`$and`/`$or`/`$not`, a `$text` on a collection with no search fields — is a
`TypeError` at `select()`, not at `fetch()`.

## The cursor

| Builder | Meaning |
| --- | --- |
| `order(field)`, `desc(field)` | Sort keys, applied in the order given; nothing (`null`, absent) first, then booleans, numbers, strings; arrays and objects stay where they were; stable |
| `limit(n)`, `offset(n)` | Cut after the sort |
| `filter(fn)` | A predicate over the loaded row — what a query cannot say |
| `projection(fields)` | Each row carries only those fields, plus `id`; a dotted field comes back under its dotted name |

| Terminal | Returns |
| --- | --- |
| `fetch()` | `Promise<row[]>` — `{ id, ...data }` as the record reads: the [lens](./schema#reading-an-older-record-the-lens) applied, `$type` included |
| `count()` | `Promise<number>` — no sort, no slice |
| `one()` | `Promise<row \| null>` — `limit(1)` |
| `for await (const row of cursor)` | The rows, one by one |
| `watch(listener, { onError }?)` | Runs now and again after every change to the collection; returns the stop function |

A cursor reads the records themselves — like `snapshot()` and `swap()`, not
through `get()`, so `beforeRead`/`afterRead` do not run. Records outside the
collection, deleted ones and encrypted ones are never rows.

## The plan

The entity's `index` fields and `unique` keys — explicit, or read off a
[metaschema schema](./schema#a-metaschema-model) — are what the
[catalog](./storage#the-catalog-and-the-cache) keeps per record. A cursor
reads from it twice:

- an **equality** on an indexed field (`field: value`, `$eq`, `$in`) narrows
  the candidates to that field's posting list before any record is read —
  `{ boardId: 'b1', priority: { $gte: 2 } }` reads the board's records only.
  The narrowing follows every `$and` branch, and an `$or` whose branches all
  name an indexed equality; a `$not`, or a branch without one, is left to the
  predicate. An indexed array field — a [set](./sync#registers-counters-and-sets)
  or any array — is posted under each of its elements as well, so
  `{ tags: 'bug' }` narrows to the records whose array holds it, and an array
  value to the records holding that array whole; a unique key over an array
  compares the whole array;
- a query whose fields, order and projection are **all indexed**, with no
  `filter`, is answered from the catalog alone: not one record read.
  `{ boardId: 'b1', status: 'open' }` with `projection(['status'])` is one;
  without the projection the rows are the records, which must be read.

Everything else reads the candidates — from the cache for the recent ones,
from disk otherwise, sixteen at a time — and evaluates the predicate on each.
There is no B-tree: an ordered range over an unindexed field is a scan of the
collection, which is fine for the tens of thousands of records a local-first
app holds and the wrong tool for millions. An unordered cursor with a `limit`
stops reading at enough matches; an ordered one with a `limit` keeps only the
best `offset + limit` rows as the candidates go by, instead of sorting every
match — the first page of a large collection costs its reads, not its sort.
A `$text` seeds the candidates with the text index's ranking, best first, and
every equality narrows that order rather than replacing it.

## Full-text search

An entity names the fields to search, and `open({ search })` gives the index
that searches them — `createSearch()` from the `@alexify/syncom/search`
subpath, so a node that never searches ships none of it:

```js
const { open } = require('@alexify/syncom');
const { createSearch } = require('@alexify/syncom/search');

const storage = await open({
  path: 'data',
  schema: { entities: { Note: { index: ['boardId'], search: ['title', 'body'] } } },
  search: createSearch(),
});
await storage.Note.insert({ boardId: 'b1', title: 'Quick brown fox', body: 'Jumps over the lazy dog' });
await storage.Note.insert({ boardId: 'b1', title: 'Crème brûlée', body: 'A dessert' });
await storage.Note.insert({ boardId: 'b2', title: 'Fox hunting', body: 'An old sport' });

await storage.Note.select({ $text: 'fox' }).fetch();               // Fox hunting, Quick brown fox — best first
await storage.Note.select({ $text: 'fox', boardId: 'b1' }).fetch(); // Quick brown fox — an equality narrows
await storage.Note.select({ $text: 'creme brulee' }).fetch();      // Crème brûlée — marks are ignored
await storage.Note.select({ $text: 'quikc' }).fetch();             // Quick brown fox — a typo still matches
await storage.Note.count({ $text: 'fox' });                        // 2
await storage.Note.select({ $text: 'fox' }).order('title').fetch(); // order() re-sorts the matches
```

Rows come back **best first** unless the cursor has an `order()`; `limit()`
and `one()` stop reading at enough matches, and `count()` counts every match.
`watch()` runs again when a matching record lands. Scores are not handed out.

**What is searched.** The record as it reads — the [lens](./storage#reading-across-versions)
applied — through the `search` fields: a string field, and the string elements
of an array field, joined by a space. An encrypted record and a deleted one
never match, and neither does a record of another collection.

**How it matches.** Text is normalized — decomposed, combining marks stripped
(`Crème` is `creme`), lower case, anything that is not a letter or a digit a
word break — and cut into trigrams per word, padded with a space either side
(`quick` is ` qu`, `qui`, `uic`, `ick`, `ck `), so a word's start and end count
and an exact word outranks part of a longer one. A record matches when it holds
at least `minOverlap` of the query's distinct trigrams — 0.3 by default:
`createSearch({ minOverlap })` takes 0 (one shared trigram is a match) to 1
(every one) — which is why a typo at the end of a word still finds it. The
score is TF-IDF over the shared trigrams, divided by the square root of the
record's length: a rare word weighs more than a common one, and a short record
holding the words outranks a long one. Ties break by id.

**What it costs.** A put per write — the text is joined and indexed inside the
write (a 40-word record is tens of microseconds; see [Benchmarks](./benchmarks)).
The index lives in memory; the text is kept in the catalog's row and written
with `index/catalog.json`, so a reopen rebuilds the index from the file with no
record read — and the file grows with it, rewritten whole on OPFS: keep
`search` to titles and short bodies. Changing an entity's `search` fields
rebuilds the catalog once, from the records.

**Limits.** No phrases, no field-scoped or boolean text operators, one `$text`
per query, at the top level, 1000 characters at most; an index that throws is
logged (`catalog.search`) and the write lands all the same. A `TextIndex` of
your own — `{ put(id, text), remove(id), query(text) }`, `query` returning
every match as `{ id, score }`, best first — can replace `createSearch()`.

## watch()

```js
const stop = storage.Task.select({ status: 'open' }).order('priority').watch((rows) => render(rows));
// … every insert, update, delete or peer op on a Task runs it again, once per batch
stop();
```

The first run is a microtask after `watch()`; changes that land while a run
is in flight coalesce into one more run. A failing run — the query, or the
listener — goes to `onError`, or to the logger at warn. Watching keys off
the catalog, so a cursor over `Task` never wakes for a `Tag`.

## Unique keys

A `unique` key — a field, or a composite `['orgId', 'name']` — holds on this
node: a local write that would take a key another record holds is refused
with a `ValidationError` whose issue is `{ code: 'unique', path: fields,
conflict: otherId }`, after validation and before anything is logged.

Two nodes writing the same key at once cannot be refused — each op is
already in its node's log. Both arrive, both are kept, and the `conflict`
event `{ kind: 'unique', entity, fields, id, other, op }` (and the
`syncom.conflicts` metric) says so on every node that applies the second;
the application decides which record yields, and a `delete()` of it
converges like any other op. A `select({ slug })` meanwhile returns both.

## Ordering records

There is no sequence CRDT in v1. For an ordered list — tasks in a column —
keep a position in a register and sort by it: a string that sorts between
its neighbours, generated on the client (`midpoint('a', 'c')` → `'b'`, and
so on), survives concurrent inserts because every writer picks its own key
and last-writer-wins settles the rare collision on one of them.
