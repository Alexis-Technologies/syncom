# Queries

`collection.select(query)` is a cursor over a collection: build it, then
`fetch()`, `count()`, `one()`, iterate it, or `watch()` it. The query is
Mango-shaped, as in CouchDB and MongoDB; the cursor plans how to answer it
from the record catalog, and reads records only when it must. The cursor is
the `query` plugin — `@alexify/syncom/query`, registered by
`@alexify/syncom/all`; the catalog and its indexes are the core's, kept
whether or not anything queries them, and without the plugin `select()` and
`count()` throw `PLUGIN_MISSING`. The examples on this page open the core
with it and with `schema` (the entities a collection is).

```js
const { createDatabase } = require('@alexify/syncom');
const { schema } = require('@alexify/syncom/schema');
const { query } = require('@alexify/syncom/query');

const storage = await createDatabase({
  path: 'data',
  plugins: [schema, query],
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
| `{ field: value }` | The field equals the value (deep); an **array** field holds the value as an element (indexed or not — a set, a list, or any array); an array value matches an array field whole, in order |
| `{ 'a.b': value }` | A dotted path reaches into the record |
| `$eq`, `$ne` | Equality, as above, and its negation |
| `$in`, `$nin` | Any of the values matches (the array rule applies), or none does |
| `$gt`, `$gte`, `$lt`, `$lte` | Ordered comparison between values of **one kind** — number with number, string with string, boolean with boolean; anything else is false. An array field: any element |
| `$exists` | `true`: the field is present (`null` counts); `false`: absent |
| `$type` | What the value is, in JSON's terms: `'null'`, `'boolean'`, `'number'`, `'string'`, `'array'`, `'object'` |
| `$regex`, `$options` | A `RegExp` or a source string, with flags; strings only (an array field: any element); the `g` and `y` flags are dropped |
| `$size` | An array of exactly that many elements |
| `$mod: [divisor, remainder]` | A number with that remainder |
| `$all: [...]` | An array holding every one of the values |
| `$elemMatch: {...}` | An array with an element matching the query — an object element by a query of its fields, a scalar one by the operators (`{ $elemMatch: { $gt: 3 } }`) |
| `$and: [...]`, `$or: [...]`, `$nor: [...]`, `$not: {...}` | Nest freely |
| `$text: 'words'` | Full-text, over the entity's `search` fields through the injected index; top level only, once — see [Full-text search](#full-text-search) |

A malformed query — an unknown operator, `$in` without an array, an invalid
regex, a `$text` that is not a string, is over 1000 characters or sits inside
`$and`/`$or`/`$not`, a `$text` on a collection with no search fields — is a
`TypeError` at `select()`, not at `fetch()`.

## The cursor

A cursor is immutable: every builder hands back a new cursor and leaves the one it was called on as it
was, so two may be built on one (`const open = db.Task.select({ status: 'open' }); open.order('due');
open.desc('priority').limit(5)`).

| Builder | Meaning |
| --- | --- |
| `order(field)`, `desc(field)` | Sort keys, applied in the order given; nothing (`null`, absent) first, then booleans, numbers, strings; arrays and objects stay where they were. A result has one order — the keys, then the id — so an unordered cursor hands its rows out by id (a `$text` query without keys keeps the index's ranking) |
| `limit(n)`, `offset(n)` | Cut after the sort |
| `filter(fn)` | A predicate over the loaded row — what a query cannot say; a cursor with one is never cached |
| `projection(fields)` | Each row carries only those fields, plus `id`; a dotted field comes back under its dotted name |
| `populate(fields)` | The declared [references](./database#references) of those fields resolved on every row: the record as `{ id, …data }` (`null` where gone), an array for many — one read per field per page |
| `after(next)` | The cursor from after the row a page's `next` names — [paging](#paging) |

| Terminal | Returns |
| --- | --- |
| `fetch()` | `Promise<row[]>` — `{ id, ...data }` as the record reads: the [lens](./schema#reading-an-older-record-the-lens) applied, `$type` included |
| `count()` | `Promise<number>` — no sort, no slice |
| `one()` | `Promise<row \| null>` — `limit(1)` |
| `page()` | `Promise<{ rows, next }>` — one page and the token of the next, see [Paging](#paging) |
| `stream({ batch }?)`, `for await (const row of cursor)` | The rows `fetch()` would give, read lazily a batch (100) at a time by keyset |
| `distinct(field)`, `countBy(field)` | The distinct values of a field among the matches, in the sort order; with how many hold each — see [Aggregates](#aggregates) |
| `nearest(field, vector, k, { distance }?)` | The `k` matches nearest to a vector by an array field, `[{ distance, row }]` — see [Aggregates](#aggregates) |
| `matches(doc)` | Whether a document in hand matches the query (the filter aside); `matches(query)` of the subpath is the same predicate without a cursor |
| `explain()` | How the cursor is answered — see [The plan](#the-plan) |
| `watch(listener, { onError }?)`, `watchCount(listener)` | The rows, or their count, now and whenever they change — see [Live queries](#live-queries) |
| `update(delta)`, `modify(fn)`, `delete({ data }?)` | Every match written as one transaction — see [Writes by query](#writes-by-query) |

A cursor reads the records themselves — like `snapshot()` and `swap()`, not
through `get()`, so `beforeRead`/`afterRead` do not run. Records outside the
collection, deleted ones and encrypted ones are never rows. In a row, and to
the query, a list field is its array, a text its string and a tree its array
of `{ id, children }`.

A cursor at a [tag](./versions#tags) — `storage.at(name).collection(entity).select(query)`
— reads the records as they were then, over the tag's catalog. A tag does not
change, so `watch()` on it throws, and it carries no text index, so a `$text`
query there is a `TypeError`.

## The plan

The entity's `index` — fields, and compound keys of fields: `index: ['boardId', ['boardId', 'rank']]`,
explicit or read off a [metaschema schema](./schema#a-metaschema-model) — and its `unique` keys are
what the [catalog](./database#the-catalog-and-the-cache) keeps per record, in memory on every engine:
a posting list per indexed field for equality, and a **sorted index** per declared key (the rows in key
order, then id). A cursor is planned over them once — and again where the collection is defined anew
(`addCollections()`, `removeCollection()`) — and `explain()` shows the plan:

```js
db.Task.select({ boardId: 'b1', rank: { $gte: 10 } }).order('rank').limit(4).explain();
// { scan: 'index', index: ['boardId', 'rank'], prefix: ['b1'], in: null,
//   range: { field: 'rank', lower: { value: 10, inclusive: true }, upper: null },
//   desc: false, sortedByIndex: true, covered: false, residual: false,
//   narrow: [], estimate: 4,
//   uses: { equalities: ['boardId'], ranges: ['rank'], order: ['rank'] } }
```

- **An index** serves a query by its longest prefix of fields the query holds an equality on
  (`field: value`, `$eq`), then a `$in` of a few ordered values on the next field (`in`: one sub-scan per
  value, in key order), then one field more for a range (`$gt`/`$gte`/`$lt`/`$lte`) or the sort. The
  scan is bounded — a binary search to each edge — and comes **sorted by the index** where the order's
  keys are the index's next fields in one direction, reaching its end (`desc` scans backwards); then an
  ordered, limited cursor reads `offset + limit` records and no more. A sort the index cannot serve reads
  by the prefix and sorts after. Of several indexes the one expected to read the fewest records wins
  (`estimate`: the scan's entries, no more than the narrowest posting list of the indexed equalities it
  leaves to the catalog — those `narrow` the scan before a record is read — no more than the window where
  sorted); a tie goes to the sorted one, then the longer prefix. An index that serves the sort alone is
  taken only for a finite window where no indexed equality could narrow instead. An array-valued key is
  entered once per element (as the posting lists post it) and never trusted for a sort;
- **the posting lists** narrow a query no index serves but which holds an equality (or `$in`) on an
  indexed field, before any record is read: `{ boardId: { $in: ['b1', 'b2'] }, priority: { $gte: 2 } }`
  reads those boards' records only. The narrowing follows every `$and` branch, and an `$or` whose
  branches all name an indexed equality; a `$not`, a `$nor` or a branch without one is left to the
  predicate. An indexed array field — a [set](./sync#registers-counters-sets-lists-and-text), a
  [list](./lists) or any array — is posted under each of its elements as well, so `{ tags: 'bug' }`
  narrows to the records whose array holds it; a unique key over an array compares the whole array;
- a query whose fields, order and projection are **all indexed**, with no `filter`, is **covered**:
  answered from the catalog alone, not one record read. `{ boardId: 'b1', status: 'open' }` with
  `projection(['status'])` is one; without the projection the rows are the records, which must be read;
- everything else is a scan of the **collection**: the candidates read — from the cache for the recent
  ones, from disk otherwise, sixteen at a time — and the predicate evaluated on each. That is fine for
  the tens of thousands of records a local-first app holds and the wrong tool for millions; an
  unordered cursor with a `limit` stops reading at enough matches (its candidates in id order, the
  result's order), an ordered one keeps only the best `offset + limit` rows as the candidates go by.

A `$text` query is the text index's ranking, best first, and every equality narrows that order rather
than replacing it; it plans no index. `indexAdvisor(db)` of [`@alexify/syncom/inspect`](./devtools)
watches the plans and suggests the keys the queries asked for and no index served.

### The query cache

Every `watch()` of one query — the same entity, query, order, window, projection and populated fields,
whatever the key order — shares one [live run](#live-queries), and a `fetch()` of it reads nothing
while the run lasts: the run's rows are the result. After the run stops the last result stays, as do up
to a hundred unobserved results, the least recently used let go of first, each with the catalog's
generation it was read at: a `fetch()` of a query the catalog has not moved since reads nothing. A
cursor with a `filter(fn)` has no key and runs every time; a cursor at a tag is never cached.

## Full-text search

An entity names the fields to search, and `createDatabase({ search })` gives the index
that searches them — `createSearch()` from the `@alexify/syncom/search`
subpath, so a node that never searches ships none of it:

```js
const { createDatabase } = require('@alexify/syncom');
const { schema } = require('@alexify/syncom/schema');
const { query } = require('@alexify/syncom/query');
const { createSearch } = require('@alexify/syncom/search');

const storage = await createDatabase({
  path: 'data',
  plugins: [schema, query],
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

**What is searched.** The record as it reads — the [lens](./database#reading-across-versions)
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

## Live queries

```js
const stop = db.Task.select({ status: 'open' }).order('priority').limit(20).watch((rows) => render(rows));
const stopCount = db.Task.select({ status: 'open' }).watchCount((n) => badge(n));
stop();
stopCount();
```

A live query is kept, not run again. The catalog says which record changed; the record is read once (it
was just written: the cache has it), matched, and placed — in the result and matching, moved to where
it sorts; in and not matching, taken out; not in and matching, put where it sorts; neither, nothing. A
window (`offset + limit`) holds that many rows from the top; a row that leaves a full window, or moves
to its end, runs the cursor again for the successor beyond it, as does a `$text` query, whose order is
the index's. The listener hears only when the rows changed — an id came, went or moved, or a row reads
as another; a write of the value a field held, or of a field the projection drops, is no change.
`watchCount()` keeps the matching ids and moves the count by one per change, never counting again; the
window (`limit`, `offset`) does not apply to a count.

The first run is a microtask after `watch()`; a failing run, or a listener that throws, goes to
`onError` or to the logger at warn. A cursor over `Task` never wakes for a `Tag`: the catalog's action
stream is per collection, and a change that left a covered cursor's rows as they were wakes nothing.
Every `watch()` of one query shares one run (see [the query cache](#the-query-cache)); `toStore()` of
`@alexify/syncom/store` is a store over `watch()`.

## Paging

```js
let page = await db.Task.select({ boardId: 'b1' }).order('rank').limit(50).page();
while (page.next !== null) page = await db.Task.select({ boardId: 'b1' }).order('rank').limit(50).after(page.next).page();
for await (const row of db.Task.select({ boardId: 'b1' }).order('rank').stream({ batch: 50 })) use(row);
```

`page()` hands back `limit` rows at most and `next`, the token of the page after — the last row's order
keys and its id — or `null` at the last page. `after(next)` is the cursor from after that row: keyset
paging in the result's one order (the keys, then the id), so a row is never read twice and a row that
came between the pages is taken where it sorts, left out before the edge, taken after it; `offset` does
not apply from an edge. `stream({ batch })` — what `for await` is — reads the rows `fetch()` would give
a batch at a time the same way, in bounded memory. A `$text` query without an order has no edge to page
by.

## Aggregates

```js
await db.Task.distinct('status');                       // ['done', 'open']
await db.Task.countBy('boardId', { status: 'open' });   // [{ value: 'b1', count: 12 }, ...]
await db.Doc.select().nearest('embedding', vector, 5);  // [{ distance, row }, ...], nearest first
```

`distinct(field)` and `countBy(field)` — on a cursor, or on a collection with a query — group the
matches by a field, compared as the predicate compares them (an array by the whole array; a record
without the field under `null`), in the sort order; from the catalog alone where the field is indexed
and the query covered. `nearest(field, vector, k, { distance })` ranks the matches by an array field of
numbers of the vector's length: a scan over the matches with the `k` best kept, by `'cosine'` (the
default), `'euclidean'`, `'manhattan'`, `'dot'` (the negated product) or a function of two vectors —
the distances `@alexify/syncom/search` exports. There is no vector index: thousands, not millions.

## Writes by query

```js
await db.Task.select({ status: 'open', due: { $lt: today } }).update({ $set: { late: true } });
// { matched: 7, written: 7 }
await db.Task.select({ boardId: 'b9' }).delete({ data: { reason: 'board closed' } });
```

A cursor's `update(delta)`, `modify(fn)` and `delete(options)` are one transaction over the records the
cursor matched when it started (its order, offset and limit applied), each matched again inside the queue
over the record as it reads there: it is written as the [database's method](./database#update-operators)
would, and a record gone or no longer a match meanwhile is skipped and counted out of `written`. A cursor at
a tag is read-only. In a row the `id` is the record's: a data field named `id` is not it, in a query, a write
by query or an `ifMatch`.

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

An ordered field — a list or a text — merges by position; see [Lists and
text](./lists). To order *records* — tasks in a column — keep a position in
a register and sort by it. `@alexify/syncom/order` mints the keys: strings
that sort with `<`, with room between any two, so an insert between two
neighbours never renumbers the rest; two writers inserting at one spot at
once pick their own keys (`jitter` keeps them apart), and last-writer-wins
settles the rare equal key on one of them.

```js
const { between } = require('@alexify/syncom/order');

const first = between();            // 'V'
const second = between(first);      // 'WV' — after first
const inserted = between(first, second); // 'WUV' — between the two
await storage.Task.insert({ title: 'ship', position: inserted });
const tasks = await storage.Task.select().order('position').fetch();
```
