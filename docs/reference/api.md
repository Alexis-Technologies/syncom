---
title: API reference
description: Every export of syncom and its subpaths with its signature, options, events and error codes, the specification the guide links into.
---

# API reference

Everything below is exported from the package root — the core: records with
registers, counters and sets, the log, the write paths, queries, versions and
sync — except the subpaths. The kinds beyond those are plugins:
[`@alexify/syncom/text`](#text-subpath) (lists and texts) and
[`@alexify/syncom/tree`](#tree-subpath), registered with `createDatabase({ plugins })`;
[`@alexify/syncom/all`](#all-subpath) is the core with every shipped plugin
registered — the API as one import (see [Entry points](./entry-points)).
The other subpaths: the
wrpc adapter, [`@alexify/syncom/wrpc`](#wrpc-adapter), the smart contracts,
[`@alexify/syncom/contracts`](#contracts-subpath), the IndexedDB backend,
[`@alexify/syncom/idb`](#engines-and-backends) (`createIdbFsi`, `idbEngine`), the SQLite engine,
[`@alexify/syncom/sqlite`](#engines-and-backends) (`sqliteEngine`, Node only), the MongoDB engine,
[`@alexify/syncom/mongodb`](#engines-and-backends) (`mongoEngine`, Node only), the text index,
[`@alexify/syncom/search`](#search-subpath) (`createSearch`), fractional indexes,
[`@alexify/syncom/order`](#order-subpath), the undo stack,
[`@alexify/syncom/undo`](#undo-subpath) (`createUndo`), and branches,
[`@alexify/syncom/branch`](#branch-subpath). The browser build exports
the same names — see [Entry points](./entry-points#the-browser-build) for the five signatures that
differ.

```js
const syncom = require('@alexify/syncom');
```

## Database

### `createDatabase(options?)`

Returns `Promise<Database>` — typed by the options: a collection per entity
of `schema`, its records typed by the entity's Standard Schema or by
`Schema<Shapes>` (see [TypeScript](../guide/typescript)), and the methods of
every plugin in `plugins`, all inferred. Takes an options object only — `createDatabase('./dir')` is a
`TypeError`, as is any option of the wrong shape, thrown by `createDatabase()` itself before anything is
opened. The guide is [Database](../guide/database).

#### `createDatabase()` options

| Option | Default | Meaning |
| --- | --- | --- |
| `path` | `'syncom'` | Directory (or OPFS path) holding the identity, keys, chain, data, log and peers; under another engine, the name the engine keys the database by |
| `name` | — | Alias for `path` |
| `engine` | the files engine over `fsi` | The storage engine every byte goes through — `isEngine`; `filesEngine(fsi)` is what `fsi` builds; an engine and a backend together are a `TypeError` (see [Engines and backends](#engines-and-backends)) |
| `fsi` | `node:fs` / OPFS | The backend of the files engine — any object with `read`, `write`, `exists`, `remove`, `list` (see [Engines and backends](#engines-and-backends)) |
| `durable` | `false` | fsync after every write, where the backend can (`node:fs`); a backend without `sync` logs at debug and is as durable as it is; OPFS and memory are as durable as they are |
| `defer` | `16` | Record files may lag the log by this many ms (a non-negative integer; `0` lands every write at once) — the writes of one record within the window coalesce into one file and one block, what typing into a text or a list wants; a flush that took longer than the window makes the next window as long as it took; `flush()`, `tag()` and `close()` land them first, and a crash replays the batch at the next open |
| `lock` | `'fail'` | One instance per path: `'fail'` rejects a second `createDatabase()` (`code: 'LOCKED'`), `'wait'` waits, `false` leaves it to you. Web Locks in the browser, `<path>/lock.json` with the pid elsewhere (stale once that process is gone, or after `staleAfter` when that cannot be told). The object form is `{ mode, staleAfter, poll, timeout }`: `staleAfter` 30 minutes for a lock file (an engine's lease, MongoDB's, lapses after it unless renewed: 30 s), `poll` 100 ms, `timeout` (how long `'wait'` waits before `LOCKED`) forever |
| `readOnly` | `false` | A follower: reads what another instance writes through the same engine (`engine`) and writes nothing — no lock, no replay, no catalog save; every write rejects with `code: 'READ_ONLY'`. Only an engine several instances may open at once takes one (`capabilities.shared`: memory, IndexedDB, MongoDB); the files engine and SQLite refuse it with a `TypeError`. Its log and vector are as of its open: it never dials (`sync.connect` is a `TypeError`) and hosts over a shared log alone — its hello answers the vector as the log moved it, its feed comes from the log, a push is forwarded to the log's inbox for the writer to land — without one `sync.unit()` rejects with `READ_ONLY`, `reason: 'hosting'`. Over an engine with a change stream (IndexedDB, MongoDB) a record the writer lands is read again, a live `Document` of it refreshed, its watchers woken — subscribed before the load, so nothing landed while it opens is missed; a stream that ends is `error` `FOLLOW_LOST` once, then subscribed again and every record read again |
| `cache` | `{ max: 5000 }` | How many entries stay in memory, the oldest evicted first; a live `Document` pins its own |
| `integrity` | `'verify'` | `'lazy'` trusts a record file on the cold read instead of re-verifying it against its block — the choice for a browser rebuilding a large catalog |
| `chain` | `true` | `false` keeps no [chain](../guide/chain) — a hub that only replicates has nothing to audit; two file writes less per record, reads lazy, `validate()` rejects with `code: 'NO_CHAIN'`; `true` without the `chain` plugin is `PLUGIN_MISSING` |
| `catalog` | `{ flushEvery: 64 }` | The fewest changes between two saves of the record catalog; a large catalog is saved every sixteenth of its size, never more than half the log's retention apart, and the log catches up the rest |
| `actor` | — | Who writes — stamped on every op as `actor`: a string, or a function asked per write (see [The operation log](../guide/operation-log#what-an-op-is)) |
| `schema` | — | Entity definitions: collections, their validators, indexes and ids; `version`, `snapshot`, `migrations`, `ahead`, `lens` — the `schema` plugin's (see [Schema (subpath)](#schema-subpath)) |
| `validator` | — | Compiles entity schemas that are plain objects without `~standard`: `{ compile(schema, { entity }) }`, an Ajv instance as it is |
| `search` | — | The text index behind `$text`, asked once per entity with `search` fields — `createSearch()` from `@alexify/syncom/search` (see [Full-text search](../guide/fulltext-search)) |
| `getId` | `crypto.randomUUID()` | Id generator for `insert()`; sync or async, no arguments; must mint an id of the record-id form — letters, digits, `.`, `_`, `-`, `@`, not starting with a dot, 128 characters at most — or `insert()` rejects with `INVALID_ID`; not a function is a `TypeError` |
| `logger` | `console` | A Console- or pino-shaped logger, or `false` for silence |
| `encrypted` | `false` | Encrypt every record at rest by default (the records then stay local); a per-call `{ encrypted }` still overrides; without the `encryption` plugin `PLUGIN_MISSING` |
| `sync` | — | Replication: `connect`, `scope`, `retention`, `pendingMax`, `signatures`, `maxSkew`, … — see [Sync options](#sync-options) |
| `hooks` | — | `beforeWrite`, `afterWrite`, `beforeRead`, `afterRead`, `beforeApply`, `afterApply` — see [Database hooks](./events#database-hooks) |
| `telemetry` | — | Injected OpenTelemetry: `{ api }` or `{ tracer, meter }` — see [Telemetry](../guide/telemetry) and the [telemetry reference](./telemetry) |
| `maxListeners` | `100` | Listeners per event on the storage and its sync manager; one more throws |
| `plugins` | `[]` | The plugins this database runs with, registered for it alone — `text`, `tree`, `signing`, `chain`, `encryption`, `sync`, `schema`, `telemetry`, `query`, `versions`, `local`, `attachments(…)` from their subpaths, or your own; `/all` puts every shipped one ahead of them (see [Plugins](#plugins) and [Entry points](./entry-points)) |

### `Database`

`await new Database(options)` — `createDatabase()` is the shorthand. Extends `Emitter`.
The list, text and tree methods below (`splice` … `treeRemove`, `spans`,
`cursor`, `index`) are the `text` and `tree` plugins' — on a storage opened
without the plugin they reject with a `TypeError` `code: 'PLUGIN_MISSING'`
naming the subpath; `@alexify/syncom/all` has both.

| Method | Returns | Notes |
| --- | --- | --- |
| `insert(data, options?)` | `Promise<string>` | Generates an id via `getId` (a UUID by default) and writes; rejects with `code: 'INVALID_ID'` when the generator mints one that is not a [valid id](../guide/database#use-your-own-ids) |
| `collections` | `Readonly<Record<string, Collection>>` | The collections by name, one frozen object — another after `addCollections()`/`removeCollection()`; `db.<Name>` is the same collection |
| `addCollections(definitions)` | `Promise<void>` | Defines collections after the open — each as an entity of `createDatabase({ schema })` would be: its validator (the `schema` plugin's), indexes, unique keys and search fields in force at once; the records of its type the catalog holds are indexed from the records, 500 a page inside the queue, behind the landings. Nothing of it is persisted: a reopen under fewer definitions rebuilds the catalog. A name the database answers to, or a definition the schema refuses, is a `TypeError` before anything is applied |
| `removeCollection(name)` | `void` | Forgets the definition and `db.<name>`; the records stay (`collection.remove()` deletes them) |
| `get(id, { at }?)` | `Promise<R \| null>` (`get<Post>(id)`; `RecordData` by default) | `null` when absent or deleted; verifies against the chain; a copy — editing it changes nothing. With `at` (the `versions` plugin's) — an event id, a stamp (a number or a `Date`), `{ vector }` or `{ tag }` — the record at that version, folded from the log, or a tag's copy (see [Versions and history](../guide/versions)); rejects with `HISTORY_GONE` when the log cannot give it exactly, `INVALID_VERSION` for a malformed `at` or a seq not reached, `TAG_NOT_FOUND` for a tag this node has not, `ENCRYPTED` for an encrypted record (at a tag one reads as its data) |
| `tag(name)` | `Promise<Tag>` | Names the storage as it is now — `{ name, eventId, seq, ts, vector, createdAt }`, kept on this node as the catalog of the moment plus a copy of each record's file taken before its first change after the tag (see [Tags](./versions#tags)); `name` is of the record-id form (a `TypeError` otherwise); deferred files land first. Rejects with `TAG_EXISTS`, `UNPERSISTED` while a record's file lags the log after a failed write, `CORRUPT` while `tags.json` is unreadable; the `versions` plugin's (`PLUGIN_MISSING` without it) |
| `untag(name)` | `Promise<void>` | Drops a tag; the copies the next older tag needs move there; rejects with `TAG_NOT_FOUND`; the `versions` plugin's (`PLUGIN_MISSING` without it) |
| `tags()` | `Tag[]` | The tags, oldest first — from memory; the `versions` plugin's (`PLUGIN_MISSING` without it) |
| `at(name)` | `TagView` | The storage at a tag: its fields plus `get(id)` (the record as it was, through the lens and the read hooks with `at: { tag }`; `null` when it was not there), `has(id)` and `list()` (every live id then; promises — the tag's catalog is read at the view's first read), `collection(entity)` (`name`, `select()`, `count()`, `get()` as it was — `watch()` throws, no `$text`; an entity the schema has not is a `TypeError`) and `snapshot(options)` (pages like `snapshot()`, at the tag's position); throws `TAG_NOT_FOUND`; the `versions` plugin's (`PLUGIN_MISSING` without it) |
| `atVersion(at)` | `VersionView \| TagView` | The storage at any version the log can still give exactly — an event id, a stamp, `{ vector }` (or `{ tag }`: the tag's view): `eventId`, `vector` (the ops within it, per stream), `ts`, `get(id)`, `has(id)`, `list()` and `snapshot(options)` — the pages another storage joins to stand there, what `branch(parent, { from: { at } })` forks from; a record compacted past the version, or a stream cut by compaction with nothing of it inside, is `HISTORY_GONE` (never under `retention: 'all'`); the `versions` plugin's |
| `diff(id, from?, to?)` | `Promise<Patch[]>` | The patches that turn the record at `from` into the record at `to` (the present when omitted), per field by kind — see [Patches](./versions#patches); raw, through the lens, no read hooks; a text's marks are not diffed; rejects as `get(id, { at })` would, `ENCRYPTED` for an encrypted record; the `versions` plugin's (`PLUGIN_MISSING` without it) |
| `applyPatches(id, patches, { actor, source, message }?)` | `Promise<number>` | Realizes patches as ops of this node's own, as one [transaction](../guide/database#make-several-writes-atomic) (`put`, `unset`, `write`, `inc`, `add`, `remove` with `elements` — `own: true` for this node's adds alone — or exact `removals`, `splice` (with `vals`), `setAt`, `mark`, `treeMove`, `treeRemove`, `delete`, `purge`); `source` rides on the `commit` events, `message` on every op; resolves to how many ops. A patch is checked as the method of its name checks its arguments — the wrong shape is a `TypeError` with nothing minted — and every patch is first resolved and applied over a scratch record, so an index out of range, a kind clash, a cycle or a type change refuses the whole batch with nothing written; a hook or a validator that throws on a later op leaves nothing written either |
| `transact(fn, { actor, source, message }?)` | `Promise<T>` | Runs `fn(tx)` as one transaction: every write made through `tx` — the write API less `purge()`, the plugins' methods included, plus `get(id)`/`has(id)` reading the records as the transaction left them (through the lens, without the read hooks) — is one op, prepared in one turn of the mutation queue with the hooks, the validator and the unique keys of each, and appended with the others as one group once `fn` returns: all durable or none, one chain block, each record's file written once, the `commit` events after, in order. `message` (at most 1 024 characters) rides on every op — signed, logged, relayed, listed by `history()` — and `source` on their `commit` events. A throw from `fn`, or a write refused (`OUT_OF_RANGE`, `FIELD_KIND`, a validator…), leaves nothing appended and rejects with the error; an encrypted write inside is `ENCRYPTED`, `tx.purge()` a `TypeError`. Resolves to what `fn` returned once the transaction has landed |
| `restore(id, at, { actor, source, message }?)` | `Promise<number>` | Makes the record read as it did at `at` (required) with new ops that lead back — `diff(id, undefined, at)` applied; rejects as `diff()` would; lands whole or not at all (see `applyPatches`); the `versions` plugin's (`PLUGIN_MISSING` without it) |
| `compact(id, { actor, source, message }?)` | `Promise<number>` | Rewrites the record as the ops its reading takes today — a `write` of the registers, then one op per field of another kind: an `inc`, an `add`, one `splice` (a text or a list becomes one run), one `tree` move per node — so what lies under it goes by the reset rule here and on every peer, and `get()` and `spans()` read the same: a text's marks are laid again in the order they were made, with their expand rules, and a list or text over 1 048 576 elements is made again in several runs. It names every element anew, so the cursors into its lists and texts read `null` after, and a stacking mark has a new id; a list, text, set or tree that reads empty is left out. A peer's op stamped before the rewrite and arriving after it is dropped, as with any whole-record write. Resolves to how many ops; `0` for a record that is not there; `ENCRYPTED` for an encrypted one |
| `history(id, { limit = 50, before }?)` | `Promise<{ versions, complete, exact }>` | The record's past, newest first: `{ eventId, seq, ts, origin, actor, message, type, fields, data, scrubbed? }` per op this node applied, `data` the record after it through the lens and `afterRead` — run for the versions handed out alone; `limit` a positive integer or `Infinity`; `before` (an event id of this log — `HISTORY_GONE` `epoch` for another incarnation's) pages back to the versions older than it; `complete` when the page reaches the first op the node applied and nothing was dropped, `exact` when the versions are what the node held; rejects with `ENCRYPTED` for an encrypted record; the `versions` plugin's (`PLUGIN_MISSING` without it) |
| `lastEditorOf(id, field)` | `Promise<{ origin, ts } \| null>` | Who last wrote `field` — the node and the stamp of a register's value, a counter's newest increment, a list's, text's or tree's newest run, mark or move — from the record's metadata; `null` for a set (its slots carry counts, no stamps), a field the record has not, a record that is not there. `origin` is a node id, not a user: `actor` on the ops is the application's word |
| `editorsOf(id)` | `Promise<string[]>` | Every node that wrote something the record still carries — its registers' writers, its counters' contributors, the adders of its sets' live elements, the writers of every run, mark and value of its lists and texts, the movers of its trees — sorted; `[]` for a record that is not there |
| `has(id)` | `Promise<boolean>` | `false` for a tombstone |
| `list()` | `Promise<string[]>` | Every live id, sorted — from the catalog, no I/O |
| `check(entity, data)` | `Promise<unknown>` | Runs the entity's validator as a write would and returns its value; rejects with `ValidationError`; writes nothing. The `schema` plugin's: `PLUGIN_MISSING` without it, as is `migrate()` |
| `migrate({ entities, batch = 100, actor }?)` | `Promise<{ migrated, counters, sets, lists, texts, trees }>` | Moves records of an older schema version to this one through the lens, each in a transaction of its own: one `version` op carrying what the lens changed — the names it removed, the registers it wrote — and nothing of what it left as it read (a text keeps its runs and marks, a counter its slots); a counter, a set, a list, a text or a tree the lens renamed or rewrote is laid again after it — what a local write of a field to such a record does to it first. Resolves to the records migrated and, per kind, the fields laid again; idempotent; `actor` rides on the ops it writes; a `TypeError` without `createDatabase({ schema })` (see [Versions and the lens](#versions-and-the-lens) and [Schema migration](../guide/migration-schema)) |
| `set(id, data, options?)` | `Promise<void>` | Replaces the record (a `write` op); keeps `$type` — data naming another is a `TypeError` with `code: 'TYPE_IMMUTABLE'`; rejects with `FIELD_KIND` for a field held by another kind than a register. Every writer rejects an invalid id with `TypeError` `code: 'INVALID_ID'` |
| `update(id, delta, { actor, ifMatch }?)` | `Promise<void>` (`Promise<boolean>` with `ifMatch`) | Sets the listed fields (a `set` op) — a key may be a path (`'profile/city'`, see [Paths](../guide/fields#edit-part-of-an-object)) — or, written in operators (`$set`, `$unset`, `$inc`, `$addToSet`, `$pull`, `$push`, `$pop`, `$min`, `$max`, `$rename`; every key one, or none: mixed is a `TypeError`), the ops each one means by the kind of its field, decided inside the queue and written as one transaction (see [Update operators](../guide/fields#update-operators-pick-the-kind-for-you)); with `ifMatch` (a Mango query, the `query` plugin's — `PLUGIN_MISSING` without it) the write is made only where the record matches it, inside the queue, and resolves to whether it was. Rejects with `NOT_FOUND` when absent, `FIELD_KIND` on a counter, set, list, text or tree field, or under a prefix one holds — an operator on a field of another kind the same (`$inc` on a register, `$addToSet` on a counter), nothing of the update written |
| `unset(id, fields, { actor }?)` | `Promise<void>` | Removes fields of any kind — one name or an array of them (an `unset` op: the fields' own reset, which an older concurrent write of them loses to and a newer one makes them again); a field the record does not hold is no op, so an absent record is too, and a deleted one is `NOT_FOUND`; also on a collection and a `Document` |
| `inc(id, key, value = 1, { actor }?)` | `Promise<void>` | Adds to a counter field (an `inc` op); creates the field and the record when absent; `NOT_FOUND` on a deleted record (a field op never brings one back: delete wins), `FIELD_KIND` on a field of any other kind |
| `add(id, key, elements, { actor }?)` | `Promise<void>` | Adds JSON values to a set field (an `add` op); creates the field and the record when absent; `NOT_FOUND` on a deleted record, `FIELD_KIND` on a field of any other kind |
| `remove(id, key, elements, { actor }?)` | `Promise<void>` | Removes from a set field the elements this node has seen added (a `remove` op; none seen: no op); `NOT_FOUND` on a deleted record, `FIELD_KIND` on a field of any other kind |
| `elementAt(id, key, index)` | `Promise<string \| null>` | The name of the element at `index` of list field `key` — what a path under it is spelled with (`items/<name>/body`, see [Children of elements and nodes](./text#children-of-elements-and-nodes)); `null` out of range or when the field is not a list; the `text` plugin's |
| `elements(id, key)` | `Promise<string[]>` | The names of the elements of list field `key`, in order; `[]` when the field is not a list; the `text` plugin's |
| `splice(id, key, index, count = 0, content?, { actor }?)` | `Promise<void>` | Removes `count` elements at `index` of a list or text field and inserts `content` there (a `splice` op) — an array for a list, a string for a text; the first write decides the kind (see [Lists, text and trees](../guide/lists)). Creates the field and the record when absent, `NOT_FOUND` on a deleted one — as every list, text and tree method is (delete wins); rejects with `OUT_OF_RANGE` past the length, `FIELD_KIND` on a register, counter, set or tree field, for a string on a list or an array on a text, or past a bound of the field |
| `push(id, key, content, { actor }?)` | `Promise<void>` | Appends to a list or text field — a `splice` at the end |
| `updateText(id, key, text, { actor }?)` | `Promise<number>` | Makes a text field read as `text`: diffed against the field inside the mutation queue (Myers, UTF-16 units), one `splice` per hunk, last first, in one turn of the queue; resolves to the number of ops. A difference deeper than a thousand edit steps is one op replacing the middle |
| `setAt(id, key, index, value, { actor }?)` | `Promise<void>` | Replaces the element at `index` of a list field (an `assign` op) — a register per element that follows it through a concurrent move; on a text, the marker of the embed slot at `index` (`{ type, parents, attrs, isEmbed }`, or `null`; `NOT_FOUND` for a slot that is no embed); rejects with `OUT_OF_RANGE`, `FIELD_KIND` on the other kinds |
| `move(id, key, from, to, { actor }?)` | `Promise<void>` | Moves the element at `from` of a list field to `to`, its index once out (a `move` op); concurrent moves of one element leave it once, at the newer one's place; `from === to` is nothing; rejects with `OUT_OF_RANGE`, `FIELD_KIND` on a text and on the other kinds |
| `treeMove(id, key, node, parent = null, { after, before, actor }?)` | `Promise<void>` | Puts `node` of a tree field under `parent` (`null`: a root) — after sibling `after`, before sibling `before`, or last (a `tree` op); creates the node, the field and the record when absent. Two nodes moving concurrently so that each would hang under the other: the older move stands, the newer is kept without effect, on every node. `parent === node` is a `TypeError`; rejects with `CYCLE` for a parent under the node, `NOT_FOUND` for a sibling not under `parent`, `OUT_OF_RANGE` for a move that would reach below the 512 levels a tree reads or a place with no room left among its neighbours; a move to where the node already is makes no op; `FIELD_KIND` on the other kinds |
| `treeRemove(id, key, node, { actor }?)` | `Promise<void>` | Removes `node` of a tree field with everything under it — a `tree` op moving it under `$trash`; a node not known here is created there, so a concurrent creation lands removed; twice is nothing |
| `mark(id, key, start, end, name, value, { expand, many, actor }?)` | `Promise<string \| null>` | Marks visible range `[start, end)` of a text field with `name: value` (a `mark` op); `expand` (`'after'` by default, `'before'`, `'both'`, `'none'`) says whether text typed at the edges takes the style; per name the newest mark wins; `many: true` stacks with every other of its name. Resolves to the mark's id; rejects with `OUT_OF_RANGE`, `FIELD_KIND` on a list and on the other kinds |
| `unmark(id, key, start, end, name, { expand, actor }?)` | `Promise<void>` | Removes a style over a range: a null mark under the reversed expand rule, so the removal grows where the style would not |
| `unmarkById(id, key, markId, { actor }?)` | `Promise<void>` | Switches one mark off by its id (what `mark()` resolved to) — the only way for a `many` mark |
| `revision(id, key)` | `Promise<number>` | What list or text field `key` reads as now, as a token — the same token, the same reading (a new one may read the same: a record read again from its file); `0` for no such field; what `applyDelta({ expect, revision })` takes to skip comparing the text; the `text` plugin's |
| `spans(id, key)` | `Promise<TextSpan[] \| null>` | The text field as runs of equal style, `[{ type: 'text', text, marks }]`, its embed slots told apart — `{ type: 'embed', value, marks }` for an inline embed (`value` its marker, `null` for a slot without one), `{ type: 'block', value }` for a block marker (see [Embeds and blocks](./text#embeds-and-blocks)); raw — no lens, no read hooks; `null` unless the field is a text |
| `insertEmbed(id, key, index, { type, attrs }, { actor }?)` | `Promise<void>` | Inserts an inline embed — an image, a mention — at `index` of a text field: one slot (U+FFFC, a character wide) whose marker `{ type, parents: [], attrs, isEmbed: true }` lands with it (a `splice` op carrying `vals`); rejects with `OUT_OF_RANGE`, `FIELD_KIND` on a list and on the other kinds; the `text` plugin's |
| `splitBlock(id, key, index, { type, parents, attrs }, { actor }?)` | `Promise<void>` | Starts a block at `index` of a text field — a paragraph, a heading, a list item under its `parents` (block types, outermost first): a block marker in one slot, the text after it up to the next marker its content (a `splice` op carrying `vals`); rejects with `OUT_OF_RANGE`, `FIELD_KIND` on a list and on the other kinds; the `text` plugin's |
| `joinBlock(id, key, index, { actor }?)` | `Promise<void>` | Removes the block marker at `index`, joining its content to the block before (a `splice` cutting the slot); rejects with `NOT_FOUND` when the slot is no marker, `OUT_OF_RANGE`; the `text` plugin's |
| `updateBlock(id, key, index, { type, parents, attrs, isEmbed }, { actor }?)` | `Promise<void>` | Replaces the marker at `index` (an `assign` op: last writer wins; `isEmbed` false unless given); rejects with `NOT_FOUND` when the slot is no marker, `OUT_OF_RANGE`; the `text` plugin's |
| `block(id, key, index)` | `Promise<BlockMarker \| null>` | The marker at `index` of a text field, `{ type, parents, attrs, isEmbed }`; `null` when the slot there is no block marker and no embed, or the field is not a text; the `text` plugin's |
| `blocks(id, key)` | `Promise<TextBlock[] \| null>` | The text field by block: per marker, in order, `{ index, type, parents, attrs, spans }` — the spans up to the next marker; text before the first marker as a block with `index` and `type` null; `null` unless the field is a text; the `text` plugin's |
| `editorOf(id, key, index)` | `Promise<{ origin, ts } \| null>` | Who inserted the element at `index` of a list or text field — the node and the stamp of its run; `null` out of range or when the field is not a list or a text; the `text` plugin's |
| `cursor(id, key, index, { side }?)` | `Promise<string \| null>` | A cursor into a list or text field — a place that survives edits around it, before the element at `index` (`'before'`, the default) or after the one before it; `null` out of range or when the field is not a sequence |
| `index(id, key, cursor)` | `Promise<number \| null>` | Where a cursor is now; `null` once its place is gone (a reset) |
| `position(id, key, cursor)` | `Promise<{ index, side } \| null>` | Where a cursor is now and which side it keeps to (`'before'`, `'after'`) — what a selection is restored from; `null` once its place is gone; the `text` plugin's |
| `positions(id, key, cursors)` | `Promise<({ index, side } \| null)[]>` | `position()` of several cursors in one read of the field; the `text` plugin's |
| `toDelta(changes, field?)` | `DeltaOp[] \| null` | The [changes](./events#changes) of text field `field` (every text change when not given) composed into one delta in Quill's form — `[{ retain, attributes? }, { insert, attributes? }, { delete }]` — over the reading before them: a splice's cut and insert, a mark as attributes over its range (`null` removes), an embed slot as `{ insert: { embed: marker } }`, a marker changed as `{ retain: 1, attributes: { embed } }`; `null` when a change is no edit a delta can say (a reset, an unset): read the field again then; the `text` plugin's |
| `applyDelta(id, key, delta, { actor, message, expect, revision }?)` | `Promise<{ ops, revision }>` | Makes `delta` the edits of text field `key`, as one [transaction](../guide/database#make-several-writes-atomic): a `retain` moves on (with `attributes`, a mark — or an unmark, for a null — over what it retains; `{ embed }` sets the slot's marker), an `insert` splices text in (`{ embed: marker }` a slot with it) and marks it with its attributes, a `delete` cuts; every mark it lays has `expand: 'none'` — a delta says each insert's attributes itself; resolves to how many ops it took and the field's revision after them; `expect` is the field's text the delta was made over (another reading inside the mutation queue is `STALE`, before any op), and `revision` — what this call or `revision()` handed back with that text — spares comparing it while the field is still at that revision; a delta of the wrong shape is a `TypeError` with nothing written; the `text` plugin's |
| `openText(id, key, { window, actor, source }?)` | `Promise<TextHandle>` | A synchronous editor's [handle](./text#the-text-handle) on text field `key`: `insert(index, text, attributes?)`, `insertEmbed(index, marker, attributes?)`, `delete(index, count)`, `format(index, count, attributes)` and `applyDelta(delta)` (`applyDelta()`'s, embeds and markers included, checked whole first: a delta refused leaves nothing of itself) edit at once over the handle's reading (the field as announced, its edits on top) or throw and change nothing (`NOT_FOUND` once the record is deleted or purged: delete wins, so only a whole-record write through the storage brings it back); `toString()`, `length`, `slice()`, `spans()` read it (empty once the record is gone); several writers of one node never grow one run from two readings; `pending`, `flushed`, `flush()`; `observe(listener)` hears every change as a delta in the handle's indices (`{ local, reset?, source }`); `close()` (an edit after it is `CLOSED`). The edits are logged `window` ms later (the storage's `defer` by default, 0 for the end of the turn) as one transaction, keystrokes that continue each other as one op and one change; a flush that cannot be logged rejects `flushed` with `UNLOGGED`; a hook sees an edit resolved (`ctx.resolved`, see [Hooks](../guide/hooks)). The storage's `flush()`, `tag()`, `close()`, and `compact()`, `restore()` and `applyPatches()` of the record, log what a handle holds first; `repair(id)` drops what a handle on the record holds unflushed (`UNLOGGED`) and it reads the record again. The `text` plugin's; never inside a transaction |
| `swap(id, changes, prev, { actor }?)` | `Promise<boolean>` | CAS, compared inside the mutation queue — `false`, and no write, on mismatch; rejects with `NOT_FOUND` when absent |
| `modify(id, fn, { actor, message, source }?)` | `Promise<R \| null>` | Changes the record by a function: `fn(copy)` runs inside the mutation queue over a copy of the record as it reads, and what it leaves — what it returns, or the copy when it returns nothing — is written as the ops that take the record there (a field changed a `set`, a field gone an `unset`; `null` deletes), as one transaction; two calls on one record compose, each reading what the one before it left. Resolves to the record as it reads after. Rejects with `NOT_FOUND` when absent, `FIELD_KIND` for a counter, set, list, text or tree field changed by the function, `IN_TRANSACTION` for a write through the database from inside `fn`; a function returning anything but an object, `null` or nothing is a `TypeError`. On `tx` too, over what the transaction left |
| `repair(id)` | `Promise<{ ops, alive }>` | Rebuilds a record whose file fails its integrity check from the log's entries of it (see [Repair](../guide/health#repair-a-record-that-fails-its-check)); rejects with `code: 'UNRECOVERABLE'` when the log holds no whole-record op for it |
| `delete(id, { actor, data }?)` | `Promise<void>` | Leaves a tombstone; with `data` (a plain object), its fields lie on the tombstone at its stamp — the record is as dead as without them, `get()` answers `null`, and whoever reads the tombstone reads them: the `delete` change carries `data`, a peer's `beforeApply` sees the op's, a snapshot page the tombstone's |
| `drop()` | `Promise<void>` | Drops the database: closed, and every store of it removed from the engine (`engine.remove(path)`) — the identity, the records, the log, the tags, the chain — under the lock, before it is let go of. Rejects with `READ_ONLY` on a follower or a writer whose lease was lost. A node opened at the path again is a new node. `dropDatabase(path, { engine, fsi }?)`, a root export, does the same for a closed database: held by the lock while it is taken — another instance's open database is `LOCKED`, never emptied under it; a path that holds nothing is nothing to do, and a directory that holds no database (no identity) is a `TypeError` |
| `forget(id)` | `Promise<void>` | Forgets the record HERE, with no op: its file, pieces and catalog row removed, every entry of it in this node's log scrubbed and flagged skipped — a replay applies none again, the stream keeps its headers so no peer sees a gap. Nothing reaches a peer: what a node does with the records of a scope a host took back (`REVOKED`), where a `delete` would be an op the host refuses. A later op of the record from a peer makes it again. `INVALID_ID` for a value that is no record id |
| `purge(id, { actor }?)` | `Promise<void>` | Forgets the record for good: a `purge` op and a scrub of its log entries, here and on every peer (see [Purge](../guide/purge)) |
| `document(id)` | `Promise<Record>` | Cached per id |
| `saveData(id, data, options?)` | `Promise<void>` | `{ encrypted: true }` seals the record for this node only; `{ actor }` names the writer |
| `loadData(id)` | `Promise<unknown>` | Alias of `get()`; throws if the record no longer matches its block |
| `validate(options?)` | `Promise<boolean>` | `{ last, from }`; no argument walks the whole chain; rejects with `code: 'NO_CHAIN'` under `createDatabase({ chain: false })` or without the `chain` plugin (the message says which) |
| `validate(id, data, blockHash)` | `Promise<boolean>` | One record against its block |
| `getCachedData(id)` | `unknown \| null` | Synchronous cache peek, raw (no lens) |
| `hasRecord(id)` | `boolean` | Whether the id is a live record — from the catalog, no I/O |
| `stats()` | `{ closed, plugins, queue, cache: { size, max, pinned }, catalog: { entries, dirty }, tags: { count, corrupt }, held, deferred, inflight, commits: { fast, queued, coalesced }, handles: { open, pending, extents }, defer: { window, flushCost, positions }, observers, collections, advisors, tombstones, query: { cache: { entries, rows }, live } \| null, log: { length, floor, next, epoch, segments, latestTs, droppedTs, corrupt, rollFailures, pins, journaled, open, unapplied, torn, lost, appendFailures }, chain: { tail } \| null, lock: { kind, mode, expiresAt, lost } \| null, readOnly, follow: { heard, failed, caughtUp } \| null, engine: { name, capabilities, writes, failures, ms } }` | The node's health, from memory — no I/O; `follow` a follower's count of the records heard through the engine's change stream, the re-reads that failed and the catch-ups run (`null` on a writer); `engine` the engine the database stores through and what its write sets cost so far (how many, how many failed, their time in ms); `lock` how the database is held — `kind` `'kv'` (a lock key) or `'native'` (the engine's lease), `expiresAt` when the lease lapses unless renewed (`null` for a lock key, or once lost), `lost` whether it was — `null` for a follower or `lock: false`; `plugins` by name; `defer` the deferred window, what its last landing took and the positions waiting; `observers` the `observe()` listeners; `tags.corrupt` while `tags.json` could not be read; `commits` the local writes so far — made at once (the fast path), through the queue, folded into the write before them (`coalesced`); `handles` the text handles open (`openText()`), how many hold edits not logged yet, and the run offsets reserved for them over every field; `log.corrupt` the log files that did not read whole at this open — a checksum that did not match, a segment or a line cut short (a segment lost, an open file kept under `log/corrupt/`); `log.open`/`log.unapplied` the groups not sealed / not applied to the records yet (a reopen replays those), `log.torn` the journal lines this open left out as torn, `log.lost` whether it lost entries it could not read, `log.appendFailures` the groups whose write failed since; `log.rollFailures` the rolls that failed since the open — what they would have sealed stays open, durable, and the next append rolls again; `held` records whose files lag the log — after a failed write, or waiting under `createDatabase({ defer })` — and `deferred` the latter alone; `inflight` local writes appended but not on disk yet; `log.pins` readers holding segments past retention |
| `quota()` | `Promise<{ usage, quota }>` | The room the medium has, in bytes — the engine's own estimate where it has one (`estimate()`: memory what it holds, SQLite `page_count × page_size` and the file's volume, IndexedDB the browser's Storage API), the files engine's volume under the path (`usage` null; over OPFS the Storage API); null where the medium says nothing (MongoDB, an engine over a port) |
| `persist()` | `Promise<boolean>` | Asks the browser to keep this origin's storage out of eviction (`navigator.storage.persist()`); true where nothing need be asked |
| `flush()` | `Promise<void>` | Lands what waits: the writes in flight, then the record files deferred under `createDatabase({ defer })` — one block, every file — so what was written is on disk when it resolves |
| `applyRemote(ops, { via, scopes, peer, adoptFrom, bound }?)` | `Promise<{ applied, skipped, duplicates, gaps, malformed, unsigned, forged, outOfScope, equivocations }>` | Applies a peer's ops, in order per origin; `peer` is `{ url, node }` for the hooks; `malformed` ops (shape, id, a field nested deeper than 80 levels, a stamp beyond `sync.maxSkew` — the op's own or one its merge meta holds) and ops refused for their signature (`forged`; `unsigned` under `sync.signatures: 'require'`) are counted and dropped; so are `equivocations` — another op than the one this node holds at its seq of its stream, or one whose `prev` is not the fingerprint held at the seq before it (see [Equivocation](../guide/operation-log#who-wrote-it-and-nothing-else-the-hash-chain)); an `advance` is adopted only when its origin is `adoptFrom`; under `bound` (a host's push passes the peer's granted scopes) an op whose record is outside them, before or after it, is counted `outOfScope` and dropped |
| `snapshot({ cursor, limit, scopes }?)` | `Promise<{ records, cursor, eventId, vector }>` | One page of state, tombstones included |
| `mergeSnapshot(records, { via, from }?)` | `Promise<void>` | Joins a page (as `merge` ops of this node) |
| `adoptVector(vector, { via, from }?)` | `Promise<SyncOp \| null>` | Records what a joined snapshot covers (an `advance` op); the keys of this node's own streams, and a seq that is no positive safe integer, are left out |
| `observe(id, path?, listener)` | `() => void` | Watches record `id`: `listener(changes, event)` after every turn that changed it — a local write, a transaction, a peer's page, a joined snapshot — with the record's [changes](./events#changes) of that turn, tagged by `id`, and the `transaction` event they came in; under `path` (a field or a [path](../guide/fields#edit-part-of-an-object)), the changes of that field, of what hangs under it and of a prefix of it (a reset above), and the whole record's (a delete, a purge). A listener is contained like an event listener; a throw or a rejection is logged (`listener.error`). Returns the function that stops watching |
| `close()` | `Promise<void>` | Logs what the open text handles hold (`edits.unlogged` where some could not be), then stops sync, lands what is in flight and the deferred files, and seals the log; further writes are refused (`CLOSED`). Called again, while it runs or after, it is the same close |

Properties: `fsi` (the files engine's backend: the one given to `createDatabase()` or to
`filesEngine()`, or the platform's — wrapped when `durable` — and `null` under a native engine), `schema`, `schemaInfo` (`{ version, hash, previous, held }`,
`null` without a schema — see [Versions and the lens](#versions-and-the-lens)),
`sync`, `nodeId` (this node's Ed25519 public key, base64url — what its ops are
verified against), `signatures` (`'verify'`, `'require'` or `false`), `path`,
`log`, `vector`, `readOnly` (opened with `readOnly: true`, or a writer whose
lease was lost: every write is `READ_ONLY`), `logger` (the writer built from
`createDatabase({ logger })` — `debug`/`info`/`warn`/`error`), `telemetry` (the writer
the engine records through — the `telemetry` plugin's from `{ api }` or
`{ tracer, meter }`, one given contained — a missing or throwing method records nothing —, or the disabled one).
Statics: `Database.Collection`, `Database.Document`, `Database.generateId()` — the
default `getId`, synchronous in both halves.

Events — listeners are contained, a throwing one is logged and never fails
the operation (see [How events are delivered](./events#how-events-are-delivered); every payload in
[Database events](./events#database-events)):

| Event | Payload | When |
| --- | --- | --- |
| `change` | `(op, via)` | Every op applied here; `via` is `null` for a local write, otherwise `{ url, node }` of the peer it came from (`url` null on the hosting side) |
| `commit` | `({ op, seq, txn, source, before, after, kinds, changes, embeds? })` | A local op is durable — never a peer's, a snapshot's merge or an encrypted write; `txn` the seq of the first op of its transaction (its own for a single write), `before`/`after` the record around it as copies (`null` when absent or deleted), `kinds` every field's kind, `changes` its [changes](./events#changes), `embeds` a text's markers on each side, `source` the Record whose `save()` it was or what `transact()`/`applyPatches()` was given, else `null`; built only while someone listens (see [The commit event](./versions#the-commit-event)) |
| `apply` | `({ via, peer, ops, applied, skipped, duplicates, gaps, malformed, unsigned, forged, outOfScope, equivocations })` | A peer's batch is durable |
| `error` | `(error)` with `error.code` and `error.op`, plus `error.rejected` (`OP_REFUSED`: `[{ field, reason }]`, `reason` a kind, `'bound'` — with `detail`, `count`, `max` — or `'malformed'`) or `error.entity` + `error.issues` (`OP_INVALID`); `error.count` for `BAD_SIGNATURE`, `UNSIGNED`, `EQUIVOCATION` and an `OP_REFUSED` of a kind this node runs no plugin for (`reason: 'kind'`, one per page, with `kinds`), and `reason`, `origin`, `scope`, `seq`, `held`, `received` for the last; `error.ids` for `UNPERSISTED`; `error.path`, `error.cause` for `LEASE_LOST` and `FOLLOW_LOST` | A peer's op of a kind the field's holder outranks (register, counter, set, list, text, tree, in that order), past a bound of a list, text or tree field, or carrying a payload the engine does not admit; skipped as invalid under this node's schema, skipped because this node cannot read the record's file (`OP_UNREADABLE`), or refused for a stamp beyond `sync.maxSkew` (`SKEW`); signatures refused (`BAD_SIGNATURE`, `UNSIGNED`); a fork of a writer's stream (`EQUIVOCATION`); logged ops whose record files could not be written (`UNPERSISTED`); the engine's lease gone to another instance (`LEASE_LOST`); a follower's change stream ended (`FOLLOW_LOST`) |
| `conflict` | `({ kind: 'unique', entity, fields, id, other, op })` / `({ kind: 'register', id, field, op, winner: { ts, origin, value }, loser: { ts, origin, value } })` | A peer's op left a unique key shared by two records; both are kept / a peer's register write (a field of a `set` or a `write`) was stamped below the value this node holds — the two made without seeing each other; the newer stamp won on every node, the op applied for its other fields; `winner` what the field reads as here, `loser` what the op carried. A local write never loses: it is stamped above everything the node holds |
| `schema` | `({ kind: 'drift', peer, version, hash, local })` / `({ kind: 'ahead', op, held })` | A peer runs this schema version with another snapshot hash (see [Schemas](./wire#hello)) / a peer's op is from a newer version, applied or held |
| `log` | `({ kind: 'roll', sealed, dropped, floor, segments })` | The log sealed a segment and maybe dropped old ones; `floor` is where a resume is still possible |
| `lease` | `({ state: 'renewed' \| 'late' \| 'lost', path })` | The engine's lease on the database (MongoDB) was renewed; a renewal failed and is being retried every `lock.poll` ms while two thirds of `lock.staleAfter` are left (`late`, once per run of failures; the log event `storage.lease.late`); it went to another instance or was given up (`lost`, with the `error` event `LEASE_LOST`) |
| `close` | — | After `close()` sealed the log |

What the storage writes to its logger — every `event:` name, its level and its fields — is the
table under [Telemetry → Log events](./telemetry#log-events); the events above are what a
listener hears, those lines what an operator reads.

Hooks (`createDatabase({ hooks })`): `beforeWrite`, `afterWrite`, `beforeRead`,
`afterRead`, `beforeApply`, `afterApply` — see
[Database hooks](./events#database-hooks).

#### Field kinds and paths

A field written with `insert()`, `set()` or `update()` is a register (last writer wins); one created with
`inc()` a counter; with `add()` a set (it reads sorted by element text); with `splice()` or `push()` a list
or a text; with `treeMove()` a tree (see [Fields that merge](../guide/fields)). A field is one kind only: a
local write of another kind throws a `SyncomError` with `code: 'FIELD_KIND'`, `field`, and `kind` the kind
that holds it, before anything is stamped. A `set()` that leaves such a field out drops it, as it drops
every field it does not name; `unset(id, fields)` removes named fields of any kind — the fields' own reset,
which an older concurrent write of them loses to and a newer one makes them again, as whatever kind that
write is. From a peer the kinds' precedence decides instead: a register outranks a counter, a counter a set,
then a list, a text, a tree (see [A kind clash](./wire#guarantees-and-limits)).

What each kind keeps is the same on every node. A register holds the newest write by `(ts, origin)`. A
counter is one running sum per stream (the origin, or `origin@scope`: a record moved to another scope keeps
counting there), each within ±`Number.MAX_SAFE_INTEGER`, added up in the order of their keys. A set is an
observed-remove set of JSON values: a remove names the adds its node had seen, so an element another node
re-added meanwhile survives, and a remove of an element this node never saw added makes no op. Elements are
told apart by their JSON text — `1` and `'1'` are two, and so are `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` —
and a set reads sorted by element text: it has no insertion order. Lists, texts and trees are in
[Lists, text and trees](./text). A counter, a set, a list, a text or a tree is made by its own op alone:
`insert({ views: 0 })`, `{ tags: [] }` or `{ body: '' }` make registers, and so does a validator's default
for the field, folded into the write that creates the record — leave such fields out of `insert()` and of
the defaults, and let `inc()`, `add()`, `splice()`, `push()` or `treeMove()` create them.

A field name may be a path of stable segments joined by `/` — `profile/city`, `stats/views` — at most 16
segments and 512 characters, none empty or `__proto__`; `/` is reserved for it (a dot is a plain character:
`update({ 'a.b': 1 })` writes a field named `a.b`). Every path is a field like any other, with its own
clock, merged on its own; a read composes the paths into nested objects, children laid over the register
at their prefix. The rules, the same on every node whatever the order the writes arrive in:

- A register written at a prefix (`update(id, { profile: { zip: 2 } })`) is a reset of what hangs under
  it: children stamped below the write go, a child written later survives and is read over the object.
  `unset(id, 'profile')` takes the subtree the same way.
- A counter, a set, a list, a text or a tree holds its prefix alone: a write under it is refused before
  anything is stamped (`FIELD_KIND`, with `prefix` naming it), and where one lands from a peer, what hung
  under the prefix goes.
- A record holds at most 4 096 fields; a write that would add one past that is refused (`FIELD_KIND`,
  `kind: 'bound'`, `detail: 'paths'`), and a peer's picture of a record keeps the first 4 096 in sorted
  order.

The ops, the log, a `snapshot()` and `getCachedData()` keep the paths apart; `get()`, a `Document`, a query
(`'profile.city'` as a dotted path), a hook's `current` and a validator see them composed. A list's element
and a tree's node can carry fields too — `items/<name>/body`, `outline/<node>/title` (see
[Children of elements and nodes](./text#children-of-elements-and-nodes)). `FIELD_KIND` also refuses a list or text write past a bound (a single insert over
1 048 576 elements, say): `kind` is then `'bound'` and `detail`, `count` and `max` say which. An index past a
list's or a text's length rejects with `OUT_OF_RANGE`, a tree move under the node's own subtree with
`CYCLE`.

#### Update operators

`update(id, delta)` takes a delta in operators — every key one of them, or none (a delta that mixes a field
and an operator is a `TypeError`). Each operator is expanded, inside the mutation queue, into the ops the
kind of its field means, and the ops are written as one transaction: `$set` a `set`, `$unset` an `unset`,
`$inc` an `inc` on a counter, `$addToSet` an `add` (`{ $each: [...] }` for several) and `$pull` a `remove`
(`{ $in: [...] }` for several) on a set, `$push` a `push` and `$pop` a `splice` at the end (`-1` at the
start) of a list, `$min`/`$max` a register written only where the value is lower / higher, `$rename` an
`unset` and a `set`. `$inc` on a register, `$addToSet` on a counter or `$push` on a set is `FIELD_KIND`, as
the typed method would be. A `$push`, `$pop`, `$addToSet` or `$pull` on a field that is a register holding
an array rewrites the register; an absent field given `$inc` becomes a counter, given `$addToSet` a set,
given `$push` a register holding an array. One operator per field: two that name one field (`$addToSet`
and `$pop` of one array, `$set` and `$inc` of one number, a `$rename` into a field another operator names)
are a `TypeError`, as MongoDB refuses a conflicting update. `$rename` takes a register: a counter, a set, a
list, a text or a tree is a `TypeError`. `{ ifMatch: query }` makes the write conditional — the record is
matched against the query inside the queue, and `update()` resolves to whether it was written (the `query`
plugin's).

#### The catalog and the cache

`list()` and `hasRecord()` answer from the **catalog**: every live record's id, collection and indexed
field values (and, for an entity with `search` fields, the text `$text` searches), in memory, kept up to
date by every write — local or a peer's. `snapshot()` pages over it too: it keeps a row for every entry with
a file, tombstones included, so a bootstrap never lists the data directory. It is persisted as
`index/catalog.json` stamped with the log position it reflects: at `close()`, and in between every
`catalog.flushEvery` changes while it is small and every sixteenth of its size as it grows, never more than
half the log's `retention.ops` apart, so a node stopped without `close()` finds its stamp still in the log.
A reopen reads it back and re-reads only the records the log changed since the stamp; when the log cannot
say — a first open, a stamp from another epoch or below the retention floor, other indexes — the catalog is
rebuilt from one scan of the records. It is derived state: delete the file and the next open rebuilds it.

The **cache** holds the last `cache.max` entries read or written, evicting the oldest; a record with a
live `Document` is never evicted. What leaves the database leaves as a **copy**, as JSON — the value
`get()` returns, a cursor's rows — and what comes in (`set()`, `update()`) is copied the same way.
`getCachedData()` and `snapshot()` hand out the raw objects, for callers that know not to touch them. A
cold read re-verifies the record against the chain block that committed it — the block read, parsed and
hashed once for the records of its batch (the last eight blocks verified are kept), one hash of the
record's data each; `integrity: 'lazy'` trusts the file instead.

#### When a record file lags the log

A local write is durable once its op is in the log; the record file and its chain block come after. Two
things put that file behind the log, and in both the cache holds the record — every read sees the write —
and the log keeps the batch unapplied until the file lands, so a crash in between is replayed onto the file
at the next open:

- **`createDatabase({ defer })`**, 16 ms by default: the writes of one record within the window land as one
  file and one block; a flush that took longer than `defer` makes the next window as long as it took;
  `flush()`, `tag()` and `close()` land them first, and a peer's write of the record lands it whole.
  `stats().deferred` counts the records waiting.
- **A file write that failed** (a full disk, a quota): the write is not undone (it replicates from the log
  already); the record is held in memory until the next open, and the `error` event fires with
  `code: 'UNPERSISTED'` and the `ids` (`quota: true` when the medium was full). `tag()` rejects with
  `UNPERSISTED` while such a record is held.

The log itself is written in groups: a write's seq is reserved the moment its op is built, the mutation
queue moves on to the next write at once, and every op appended while the previous group is being written
goes to disk with the others. What the caller awaits is the landing: the disk, then the file (or the
deferred slot), the `afterWrite` hook and the events, in log order. The next write of a record builds on
the one in flight before it; a read sees a write once it is durable. `stats().inflight` counts the writes
between the append and the disk. A log append refused for want of room is `QUOTA`.

### `Document`

Extends `Emitter`. Emits `update` with `(data, delta)` — on a staged
assignment, and when the record changes in storage (`null` data once deleted).

`id`, `data()`, `delta()`, `save({ actor }?)`, `populate(field)`, `unset(fields, { actor }?)`,
`inc(key, value?, { actor }?)`, `add(key, elements, { actor }?)`, `remove(key, elements, { actor }?)`,
`elementAt(key, index)`, `elements(key)`,
`splice(key, index, count?, content?, { actor }?)`, `push(key, content, { actor }?)`,
`updateText(key, text, { actor }?)`, `setAt(key, index, value, { actor }?)`,
`move(key, from, to, { actor }?)`, `mark(key, start, end, name, value, options?)`,
`unmark(key, start, end, name, options?)`, `unmarkById(key, markId, { actor }?)`, `spans(key)`,
`insertEmbed(key, index, embed, { actor }?)`, `splitBlock(key, index, block, { actor }?)`,
`joinBlock(key, index, { actor }?)`, `updateBlock(key, index, block, { actor }?)`, `block(key, index)`,
`blocks(key)`, `cursor(key, index, options?)`, `index(key, cursor)`, `position(key, cursor)`,
`observe(path?, listener)`, `lastEditorOf(field)`, `editorsOf()`, `editorOf(key, index)`,
`treeMove(key, node, parent?, { after, before, actor }?)`, `treeRemove(key, node, { actor }?)`,
`delete({ actor }?)`, plus a
live property per field of the loaded object. `SyncomDocument<R>` types
`data()` as `R | null`, `delta()` as `Partial<R>` and the live properties by
`R` — a typed collection's `document()` and `storage.record<R>(id)` give it;
`RecordData` otherwise (see [TypeScript](../guide/typescript)).

`storage.document(id)` is cached per id: two calls for one record return the same object, and so the same
listeners. The live properties are the keys the record had when it was loaded; `id` is reserved and never a
settable property. An assignment stages a change (`delta()`, an `update` event) and `save()` writes what was
staged as a `set` of the assigned fields alone, then clears the delta; a field of any kind but a register
changes through its own method — assigning it and saving is `FIELD_KIND`. The record follows changes made
elsewhere — a write through the storage, an op from a peer: its properties are refreshed, `update` fires
with the delta, and what is staged and not saved stays on top; a record deleted elsewhere reports `update`
with `null` data. It reads through `get()` — the lens and `afterRead` applied — as it loads and as it
follows a change; with a lens or a read hook in play the change reaches it once the write is done, in order
(see [Reads stay raw where it matters](./events#reads-stay-raw-where-it-matters)).

A field the record's collection declares a reference (`refs`, or a metaschema relation — see
[Schema options](#schema-options)) reads as a **`Reference`**, an array of them for a reference to many:
`id` the string it holds, `document()` the target's live `Document` (`null` where the record is not there,
or is not of the declared collection), `toJSON()` the id again. `populate(field)` resolves the field at
once: a `Document` or `null`, or an array of them for many; a field that is no declared reference is a
`TypeError`. A string that is not declared a reference is a string, whatever it happens to equal. A
cursor's `populate(fields)` resolves references on every row of a page instead (see [`Cursor`](#cursor)).

### `Collection`

Created per schema entity and exposed as `storage.<EntityName>`; a name the
storage already answers to (`get`, `close`, `log`, `sync`…) is refused at
`createDatabase()` with a `TypeError`.

`SyncomCollection<R, I>` — `R` the record as it reads, `I` what a write
takes; both from the entity's Standard Schema or the schema's `Shapes`,
`RecordData` otherwise (see [TypeScript](../guide/typescript)).
`name`, `local` (the collection's [local documents](../guide/local)), and:

| Member | Notes |
| --- | --- |
| `insert(data, options?)` | A new record — under the id its data names (the entity's composite id or its id field: a live one there is `EXISTS`), else a minted one; resolves to its `Document` |
| `upsert(data, options?)`, `insertIfAbsent(data, options?)` | Written whole under the named id, new or not; or only where no live record holds it (decided inside the queue), the `Document` either way. Data that names no id is a `TypeError` |
| `bulkInsert(rows, options?)`, `bulkUpsert(rows, options?)`, `bulkRemove(ids, options?)` | ONE transaction with a verdict per row — `{ success: ids, error: [{ index, id, data, error }] }`: a row refused on its own account (its validator, a unique key, its id, its collection) stays out, the rest land, a batch that cannot reach the disk lands nothing; 10 000 rows at most (a `TypeError` before anything lands). An `afterWrite` hook that fails after the rows landed leaves the verdicts to the caller and goes to the `error` event |
| `get(id, { at }?)`, `findByIds(ids)`, `document(id)` | `null` for a record of another collection; a `Map` of the live records of this collection among `ids`, one read of the engine for the ones not cached (to follow a set, `select({ id: { $in: ids } }).watch()`); the live `Document` |
| `set(id, data, options?)` | Written whole, stamped as the collection's |
| `update(id, delta, { actor, ifMatch }?)` | Fields, or the [update operators](../guide/fields#update-operators-pick-the-kind-for-you) (one operator per field; `$rename` takes a register); a delta naming `$type` is a `TypeError`; with `ifMatch` (the `query` plugin's) written only where the record matches, inside the queue — `true`, else `false`, nothing written |
| `modify(id, fn, options?)` | `fn` over a copy of the record inside the queue; what it leaves is written as the difference (`null` deletes) |
| `delete(id, { actor, data }?)` | A tombstone; `data` written into the record as it dies (one op) |
| `remove({ purge, actor }?)` | Every record of the collection as it was when the call began — tombstones, or purges scrubbed from the log — 500 a page, a page a turn of the queue; `{ removed }`. Takes `{ purge, actor }` and nothing else: `remove({ status: 'old' })` is a `TypeError`, the matches of a query go through `select(query).delete()` |
| `select(query?, { sealed }?)`, `count(query?, { sealed }?)`, `distinct(field, query?)`, `countBy(field, query?)` | The `query` plugin's (`PLUGIN_MISSING` without it): a cursor, below; the collection's [sealed records](../guide/encryption#why-sealed-records-never-sync) read at the key holder unless `sealed: false` |
| `on(event, fn)`, `once`, `off`, `clear` | The collection's events, told on a microtask after the landing of a record of its own — `change` `({ id, action })` and `insert`, `update`, `remove` `({ id })`, `action` what the catalog decided (a record joining the collection an `insert`, one leaving it — deleted, purged, encrypted, of another collection now — a `remove`, several ops of one turn one `update`); the catalog's subscription goes with the last listener |
| `methods` / `statics` (the definition's) | Bound, non-enumerable: `methods` on every `Document` of the collection, `statics` on the collection (`db.Post.recent()`); a static named like a collection member is a `TypeError` at the definition |

`update`, `delete`, `modify` and `document` reject with `NOT_FOUND` (`entity`) for a record of another
collection. Writes through a collection with a `schema` are validated — see
[Validation](../guide/schema); `unique` keys are refused with a `ValidationError` whose issue has
`code: 'unique'` and `conflict`.

What `remove` means where — the one name, four things:

| Call | Meaning |
| --- | --- |
| `db.remove(id, field, elements)`, `document.remove(field, elements)` | Elements out of a set field (a `remove` op) |
| `collection.remove({ purge })` | Every record of the collection, 500 a page |
| `collection.bulkRemove(ids)` | The ids given, one transaction with a verdict per row |
| `db.removeCollection(name)` | The definition alone; the records stay |

#### `Cursor`

`collection.select(query)` — the `query` plugin's (see
[Queries](../guide/query) and [Query](#query-subpath)); `$text` in the
query searches the entity's `search` fields, best first unless ordered.

| Member | Notes |
| --- | --- |
| `matches(doc)` | Whether a document (its data, with or without `id`) matches the cursor's query, the filter aside — `matches(query)` of `@alexify/syncom/query` is the same predicate without a cursor |
| `explain()` | How the cursor is answered, as a copy (`uses` says what the query asks of its fields: the equalities, the ranges, the sort): `{ scan, index, prefix, in, range, desc, sortedByIndex, covered, residual, narrow, estimate, sealed }` — the scan (`text`: the text index's ranking; `index`: a sorted key the catalog keeps, entered by `prefix` (the equality values of its first fields) and `range` (the bounds on the field after); `postings`: the posting lists of the equalities on indexed fields; `collection`: every record), whether the rows come sorted by the index (`sortedByIndex` — the order's keys reach the index's end, or a whole key matched with no order: a window is then read as far as `offset + limit` and no further), whether only the catalog is read, whether the predicate still runs, `in` a `$in` scanned value by value on the field after the prefix, `narrow` the indexed equalities the index left to the posting lists (tested before a record is read), `estimate` how many records the plan expects to read (the index chosen is the one with the smallest), `sealed` how many [sealed records](../guide/encryption#why-sealed-records-never-sync) of the collection are read whole beside the plan. See [The plan](../guide/query-optimizer) |
| `order(field)`, `desc(field)` | Sort keys, in order; nothing first, then booleans, numbers, strings; stable. Every builder hands back a NEW cursor and leaves the one it was called on as it was |
| `limit(n)`, `offset(n)` | Applied after the sort |
| `filter(fn)` | A predicate over the loaded row |
| `projection(fields)` | The fields each row carries, plus `id` |
| `populate(fields)` | The declared [references](../guide/population) of `fields` resolved on every row of the page: the record as `{ …data, id }` (`null` where it is not there, or not of the declared collection), an array of them where the reference is to many — one read of the targets per field per page; a field that is no declared reference is a `TypeError` |
| `fetch()` | `Promise<QueryRow<R>[]>` — `{ id, ...data }` as the record reads |
| `count()` | `Promise<number>`; over a sorted index entered by a prefix or a range, with every conjunct decided by it and no filter, the count is the index's and no record is read |
| `one()` | `Promise<QueryRow<R> \| null>` |
| `watch(listener, { onError }?)` | `listener(rows)` now and whenever the rows change — the result is kept as the collection changes without running the cursor again (the record that changed is read once, matched and placed; a full window that lost a row, or a `$text` query, runs the cursor again) and emitted only when an id came, went or moved or a row reads as another; every `watch()` of one query (the same entity, query, order, window, projection, populated fields) shares one run, and a `fetch()` of it reads nothing while the run lasts. Returns the stop function |
| `watchCount(listener, { onError }?)` | `listener(count)` now and whenever the number of matches moves — the matching ids kept, one in or out per change, never counted again; the window (`limit`, `offset`) does not apply to a count. Returns the stop function |
| `page()` | `Promise<{ rows, next }>` — `limit` rows at most and the token of the page after (`null` at the last: fewer rows than the limit); `after(next).page()` is the next page. A `$text` query without an order has no edge to page by (a `TypeError`) |
| `after(next)` | The cursor from after the row `next` names (a page's `next`): keyset paging in the result's one order — the keys, then the id — so a row is never read twice and one that came meanwhile is taken where it sorts; `offset` does not apply from here. `for await (const row of cursor)` walks the pages of a limited cursor |
| `distinct(field)` | `Promise<unknown[]>` — the distinct values of `field` among the matches, in the sort order, each once (an array field by the whole array; a record without the field under `null`); from the catalog alone where the field is indexed and the query covered. A collection's `distinct(field, query?)` is the same |
| `countBy(field)` | `Promise<[{ value, count }]>` — the distinct values with how many matches hold each, in the sort order. A collection's `countBy(field, query?)` is the same |
| `nearest(field, vector, k, { distance }?)` | `Promise<[{ distance, row }]>` — the `k` matches nearest to `vector` by `field` (an array of numbers of the vector's length; a row without one is skipped), nearest first, by `'cosine'` (the default), `'euclidean'`, `'manhattan'`, `'dot'` (the negated product) or a function of two vectors — the distances of `@alexify/syncom/search`. A scan over the matches with the `k` best kept as they are read — `k` at most 1000, a vector of at most 4096 numbers (a `TypeError` past either): no index |
| `update(delta, { actor, message, source }?)` | Every match updated — fields, or the [operators](../guide/fields#update-operators-pick-the-kind-for-you) — as ONE transaction over the matches when it started, each matched again inside the queue: `Promise<{ matched, written }>` (a record gone or no longer a match meanwhile is skipped). A cursor at a tag is read-only (a `TypeError`) |
| `modify(fn, options?)` | Every match changed by `fn`, as `modify()` does, as ONE transaction: `{ matched, written }` |
| `delete({ actor, data }?)` | Every match deleted as ONE transaction, `data` on each tombstone: `{ matched, written }` |
| `stream({ batch }?)` | The rows `fetch()` would give — the window applied — read lazily, `batch` (100) at a time by keyset (each page sought in the index, or by id), so a result of any size is walked in bounded memory where the order is the index's or there is none; an order no index sorts (or a `$text` query without one) is one run handed out in batches — `indexAdvisor` names the key; `for await (const row of cursor)` is `stream()` |
| `[Symbol.asyncIterator]` | `for await (const row of cursor)` — `stream()` |

The shapes on the wire and on disk — the op's slots, the payloads, the
signed header, the log and record files, the procedures — are in
[Wire format](./wire).

## Sync (subpath)

```js
const { sync, SyncManager, isSyncLink } = require('@alexify/syncom/sync');
```

`sync` is the plugin: `createDatabase({ plugins: [sync] })` gives the storage its
manager at `storage.sync`, built once the log is open; without it
`storage.sync` is `PLUGIN_MISSING`, and a transport of the application's own
carries ops with the core's `outbound()` and `applyRemote()` (see
[Without the plugin](../guide/sync-protocol#sync-without-the-plugin)). The options
(`createDatabase({ sync })`), the hooks, the link contract and the apply path are the
core's.

### `SyncManager`

`storage.sync`; `await new SyncManager(storage, options)` builds one by hand.
Extends `Emitter`. See [Sync](../guide/sync-protocol).

| Method | Returns | Notes |
| --- | --- | --- |
| `addNode({ url, token?, scopes?, direction? })` | `Promise<void>` | Registers a peer to dial; dials it at once when started. `direction` `'both'` (default), `'pull'` (subscribe alone: nothing of this node goes to the peer, retention does not wait for it) or `'push'` (push alone: no feed, no bootstrap) |
| `removeNode(url)` | `Promise<void>` | Hangs up too |
| `enableNode(url, enabled = true)` | `Promise<void>` | Keep a node without dialing it |
| `listNodes()` | `Node[]` | `{ url, token, scopes, direction, enabled, lastSync, cursor, remote, acked }`; `remote` is `{ id, epoch, schema }` after a hello; `acked` is how far the node holds this node's own streams (vector keys → seq), what the log keeps them for |
| `start()` | `Promise<void>` | Dials every enabled node; needs `sync.connect` |
| `stop()` | `Promise<void>` | Closes every link |
| `sync(url?)` | `Promise<Array<{ url, pushed }>>` | Pushes what the peers lack now |
| `peers()` | `Array<{ url, node, connected, subscribed, cursor, lastSync, pending, behind, stuck, terminal, lastError, direction, caughtUp }>` | Live view; `behind` after a failed push until the next recovery, `stuck` once a page failed three times in a row (see [Protocol](../guide/sync-protocol#when-a-page-does-not-land)), `lastError` `{ code, message, at }` or null, `caughtUp` once the host's feed was read to its end (its idle page) and until the next page with ops |
| `awaitInSync({ signal? }?)` | `Promise<void>` | Resolves once every enabled node is in sync with this one: its link up and greeted, nothing left to push to it (no outbox, no push in flight, not behind) and — where it subscribes — its feed read to its end; a node disabled or whose dial failed is not waited for; `signal` cuts the wait short (rejects with its reason) |
| `awaitInitialReplication({ signal? }?)` | `Promise<void>` | Resolves once every enabled node has been in sync at least once since it was dialed — the first handshake and the first lull of its feed (or its push, for a push-only node) |
| `awaitDocumentPushed(id, { signal? }?)` | `Promise<void>` | Resolves once the newest op this node made for the record is acknowledged by every enabled node it goes to (of the op's scope, taking pushes); at once when this node made none |
| `hosted()` | `Array<{ node, scopes, since, cursor }>` | Hosting side: every peer with a live `changes` feed here (`scopes` null means every scope) |
| `sessions()` | `Array<{ node, connections }>` | Hosting side: every peer greeted here with a live session and how many connections hold one — what a `revoke` reaches; a session goes with its socket, and a read that carried its hello leaves none |
| `revoke(node, scopes)` | `void` | Hosting side: takes `scopes` back from the peer `node` on every unit of this manager — its live feeds end, it is told at once (`syncom/revoke`), its grant is narrower from here on and its next hello says so (`revoked`); the `revoke` event. Kept in `revoked.json` of the root kv namespace (a restart grants them no more) and, over a shared log, appended to the topic for every hub to take back (their `revoke` event says `via: 'shared'`). A grant of everything (`'*'`) is not narrowed by a scope: revoke what hello granted |
| `shared()` | `SharedStats \| null` | The [shared log](../guide/server-scaling#serve-every-hub-from-one-log) as this hub stands to it: `topic`, `inbox`, `running`, `cursor` (the consumer's, per topic), `appended` (this node's own log position appended through), `behind`, `stuck`, `shadow` (a read-only hub keeps the vector as the log moved it) and the counts `relayed`, `entries`, `applied`, `forwarded`, `malformed`, `appendFailures`; null without one |
| `unit({ access, authorize, authorizeWrite, prove, query, tracked, pageSize, pageBytes, limits, meta, presence, allow }?)` | router unit | The procedures a host mounts: `hello`, `push`, `snapshot`, `changes`, `prove` (the key's proof), `blob` (an attachment's bytes, as `allow.blob` serves them), `query` and `count` under `{ query }`, and the inbound event `on.presence` — a peer's [presence](../guide/presence) update, checked (its own node, a scope it asked for, `presence.rate` per second — 20 — signed under `'require'`) and relayed to the scope's room but the sender; the host keeps the newest state per node (`presence.max` per scope, 1 024; for `presence.timeout` ms, 30 000) and hands them to a newcomer at hello — see [Hosting](#unit-options) |
| `presence(instance)` | `() => void` | Carries a [presence](../guide/presence) instance: its updates go to every connected host as the `syncom/presence` event, a host's come back to it, a host hands its room's at hello; returns the function that stops carrying it |

Properties: `storage`, `started`.

Events (contained, like the storage's): `peer` `({ url, connected, node?,
reconnected?, schema? })`, `sync` `({ url, pushed })` after a push and `({ url,
received, applied, skipped, duplicates, gaps, malformed, unsigned, forged,
outOfScope, equivocations })` after a received page, `bootstrap` `({ url, records })`, `error`
(with `.url`; `code: 'PAGE_FAILED'` / `'STUCK'`
with `cursor` and `attempt` for a page of the feed that could not be applied,
`'HANDSHAKE_LOOP'` for a host that keeps answering 428), `start`, `stop`,
`node` `({ url, action: 'add' | 'remove' | 'enable' | 'disable' })`, `connect`
`({ url })` once a link is accepted (before hello), and on the hosting side
`hello` `({ node, scopes, schema })` once a peer is authorized and `refused`
`({ node, reason, count })` when a push carried ops it would not take: `reason`
`'scope'` for ops outside the scopes that hello granted — the scope an op
declares, or the scope of the record it writes, before or after it (see
[Scopes](../guide/partial-sync)) — `'forged'` and `'unsigned'` for signatures
refused (see [Signatures](../guide/signing)), `'equivocation'` for
ops that fork their writer's stream (see [Equivocation](../guide/operation-log#who-wrote-it-and-nothing-else-the-hash-chain)).
The dialer's `error`
event also carries `'REWOUND'` and `'UNDELIVERABLE'` (see the codes below).

Hooks (`createDatabase({ sync: { hooks } })`): `beforeConnect`, `beforeBootstrap`, `beforeSend`, `onRevoke` — see
[Sync hooks](./events#sync-hooks).

### Sync options

`createDatabase({ sync })` — the manager's options (`SyncOptions` in `index.d.ts`). The `telemetry`
option sits beside `sync` on `createDatabase()`, not inside it.

| `sync.…` | Default | Meaning |
| --- | --- | --- |
| `connect(node)` | — | Returns a link (or a promise of one) for a registry node. Required to dial; a read-only database refuses it |
| `autoStart` | `true` when `connect` is given | Dial on open |
| `scope(id, data)` | `() => '*'` | The scope of a record (see [Scopes](./wire#scopes)) |
| `retention.ops` | `10000` | Ops kept in the log before the oldest sealed segment is dropped; `0` bounds nothing by count |
| `retention.days` | — | Age after which a sealed segment is dropped, by this node's wall clock |
| `retention: 'all'` | — | Keep everything: no segment is ever dropped, so every version stays exact (`history()`, `get(id, { at })`, a fork at any version) |
| `maxSkew` | `86400000` | How far ahead of this node's clock a peer's stamp may be, in ms — an op's own, every stamp a merge op's meta holds; beyond it the op is `malformed` (`SKEW`), and a snapshot record is left out of the join. A stamp a record already holds past it is not observed by a local write either (`clock.skew.ignored`). `Infinity` disables |
| `pendingMax` | `4096` | How much pending work a list or text field takes from a peer's ops that ran ahead of what they depend on — runs waiting for their anchor, cuts and extensions for their run, registers and switched-off marks for elements not here — before an op is refused (`OP_REFUSED`, reason `bound`, with `detail`, `count` and `max`). A refusal is final on this node, so a mesh with several hosts raises it rather than lowers it. `Infinity` disables. A snapshot block past it is not taken as state |
| `signatures` | `'verify'` | `'verify'`, `'require'` or `false` — see [Modes](./wire#modes) |
| `rewind` | `'report'` | A host that holds more of this node's own streams than its log (`REWOUND`): `'report'` moves them past the host's only on proof — this node's own op at the seq, signed by its key — `'adopt'` on the host's word. See [The dialer](./wire#the-dialer) |
| `maxOutbox` | `10000` | Ops queued for one peer beyond this are dropped and the peer is `behind`; the recovery pushes what it lacks from the vector |
| `maxPageBytes` | `268435456` (256 MiB) | The bytes one streamed snapshot page may carry while bootstrapping (`Infinity` for no bound); past it — or a page without its records, or a cursor that does not move on — the bootstrap stops with `BAD_PAGE` |
| `log.rollAfter` | `64` | Groups of appends per sealed segment |
| `pageSize` | `500` | Ops per push. What a host serves per page — snapshot records, `changes` ops — is its own `unit({ pageSize })` |
| `authorizeWrite({ op, peer, current, after })` | — | The host's rule on what a peer may write: every unit's unless the unit names its own, and the writer's over a shared log's inbox (see [`unit()` options](#unit-options)) |
| `hooks` | — | `beforeConnect`, `beforeBootstrap`, `beforeSend`, `onRevoke` — see [Sync hooks](./events#sync-hooks) |
| `sharedLog` | — | A log shared by the hubs of a mesh — a broker's log (wrpc's `BrokerLog`) or `mongoSharedLog()` — alone or as `{ log, topic, inbox, stopWait }` (`topic` `'syncom'`, `inbox` `<topic>.inbox` or `false`, `stopWait` 5000 ms): every op this node accepts goes to the topic, the other hubs' are applied from it, `changes` is served from it, a read-only hub hosts over it — see [The shared log](./wire#the-shared-log) |

### `unit()` options

`db.sync.unit(options)` — what a host mounts on a wrpc router as `syncom` (`SyncUnitOptions` in
`src/sync/sync.d.ts`). The procedures and their refusal codes are in [The procedures](./wire#the-procedures).

| Option | Default | Meaning |
| --- | --- | --- |
| `access` | `'session'` | wrpc's access level, applied to every procedure |
| `authorize(context, hello)` | — | Gate the handshake; `hello.token` is the dialer's registered token, `hello.scopes` what it will be held to, `hello.schema` its schema; `false` is 403 `UNAUTHORIZED` |
| `authorizeWrite({ op, peer, current, after })` | `sync.authorizeWrite` | Asked of every pushed op before it is applied, with the record as it is here and as the op would leave it: `false` refuses the op — logged as a withheld scrub (skipped, scrubbed, `withheld`), relayed as a no-op that applies nowhere, a purge included, no gap — and the push's answer names it (`refused`, `reason: 'rule'`, with the record as the host holds it and the op's `actor`), so the pusher sets itself straight (`WRITE_REFUSED`). A sealed record at the host is skipped before the rule is asked. A throw fails the page |
| `limits` | `{ opsPerPush: 10000, rowsPerQuery: 500 }` | Per-peer limits checked in `push`: a page over `opsPerPush` or `bytesPerPush` (the JSON length of its ops) is 413 (`OPS_PER_PUSH` / `BYTES_PER_PUSH`); a peer over `opsPerSecond` (a token bucket per peer, refilled at that rate, holding one second's worth) is 429 (`OPS_PER_SECOND`); `rowsPerQuery` bounds a thin client's read; `bytesPerBlob` the bytes one `syncom/blobPut` carries (413 `BYTES_PER_BLOB`; 64 MiB whatever it says). `Infinity` lifts a limit. The `syncom.ops.limited` metric counts refusals by reason (`ops`, `bytes`, `rate`) |
| `pageSize` | `500` | Records per snapshot page, ops per `changes` page |
| `pageBytes` | `4 MiB` | Above this a snapshot page is sent inline rather than streamed |
| `tracked` | built in | wrpc's `tracked()`; the built-in produces the same shape |
| `meta` | — | Copied onto every procedure, for a wrpc `onRequest` hook to read as `context.procedure.meta` |
| `prove` | `true` under `signatures: 'require'` | Ask every peer to prove it holds the key that is its node id: hello answers a `challenge`, the peer signs it (`syncom/prove`, the dialer does so by itself), and until then push, snapshot, changes, query, count and blob are 403 `UNPROVEN` (a bad signature 403 `BAD_PROOF`). Needs the signing plugin |
| `query` | `false` | Serve `query` and `count`: a thin client's read of this host's records through the query plugin, in its scopes, within `limits.rowsPerQuery`; never a sealed record. `true` is `{ regex: false }` (a `$regex` from the wire is 400 `REGEX`); `{ regex: 'safe' }` takes a pattern with no nested quantifier, backreference or lookaround; `{ regex: true }` any. A call may carry its hello (`hello: { node, token, scopes }`) for a stateless transport |
| `allow` | `{ push: true, changes: true, snapshot: true, blob: 'named' }` | Which procedures this unit serves: `push` off is 403 `READ_ONLY`, `snapshot`, `changes` or `blob` off 403 `NOT_SERVED`. `blob` `'named'` (`true`) serves a digest only to a peer that names a live record in its scopes holding it; `'any'` by digest alone |
| `presence` | `{ timeout: 30000, rate: 20, max: 1024 }` | The unit's inbound event `on.presence`: a peer's [presence](../guide/presence) update — its own node's, of a scope it asked for, at most `rate` a second, signed under `'require'` — relayed to the scope's room; the host keeps the newest state per node (`max` per scope, for `timeout` ms) and hands them to a newcomer at hello |

### `SyncomError`

What syncom rejects with when an operation cannot be done: `name`
`'SyncomError'`, a `code` from the table below, the fields the code lists,
and `cause` when an underlying error exists. A `TypeError` is the other kind
— a wrong argument, option or hook result, a bug in the calling code — and
carries no code, except `INVALID_ID`, `TYPE_IMMUTABLE`, `ID_IMMUTABLE`, `INVALID_VERSION`,
`NO_CHAIN`, `PLUGIN_MISSING`, `BLOB_TOO_LARGE` and `PRESENCE_SIZE`, whose value is data or configuration (the rows below say "a
`TypeError`"; their union is the `TypedErrorCode` type). `HookError` and `ValidationError` are
`SyncomError`s. Exported from the package root; the union of codes is the
`SyncomErrorCode` type.

| Code | Raised by | Fields |
| --- | --- | --- |
| `CLOSED` | any write, `applyPatches()`, `tag()`/`untag()`, `repair()`, `applyRemote()`, `mergeSnapshot()` or `adoptVector()` after `close()`; a text handle's edit (`openText()`) once its `close()` was called | — |
| `IN_HOOK` | a write issued from inside a write or apply hook (the `cause` of the `HookError` the operation rejects with) | — |
| `IN_TRANSACTION` | a write issued through the database from inside `transact()`'s or `modify()`'s function, which holds the mutation queue the write would wait for — write through `tx`, or return the record. Told by the function's async context (Node); in the browser such a write is not told from one made meanwhile and waits for the queue the function holds | — |
| `EXISTS` | `insert()` (the database's, a collection's, `tx.insert()`, an encrypted one too) and `bulkInsert()` of a record whose data names the id of a live record — the entity's composite id, or the id field's value; decided inside the queue | `id`, `entity` |
| `NOT_FOUND` | a write under a list element or a tree node that is not there (`items/<name>/body` with no element `name`: `id`, `field` the list or tree, `elem` the name); `update()`, `swap()`, `modify()` on a record that is absent, deleted or purged — a collection's `update()` and `modify()` too, which hand the write to the database; a collection's `update()`, `delete()`, `modify()`, `document()` on a record of another collection, and its `bulkRemove()` on an id absent or of another collection (that row's verdict); `treeMove()` with an `after`/`before` sibling not under the parent; `joinBlock()`, `updateBlock()`, `setAt()` on a text at a slot that is no block marker and no embed; `attachments.put()` on a record that is not there | `id` alone for a record absent, deleted or purged (from the database's `update()`/`swap()`/`modify()`, and a collection's `update()`/`modify()` of one); `id`, `entity` (the collection's) where a collection refused the record as another collection's — `update`, `delete`, `modify`, `document` — and from `bulkRemove` for an absent one too; `id`, `field`, `elem` under an element or node; `id`, `field`, `node` (the sibling) for a tree; `id`, `field`, `index` for a text's slot |
| `FIELD_KIND` | `openText()` on a field that is not a text, `update()`/`set()` on a counter, set, list, text or tree field, `inc()` on a register, set, list, text or tree field, `add()`/`remove()` on a register, counter, list, text or tree field, `splice()`/`push()`/`updateText()` on a register, counter, set or tree field (and a string on a list, an array on a text), `move()` on anything but a list, `setAt()` on anything but a list or a text, `mark()`/`unmark()`/`unmarkById()`/`insertEmbed()`/`splitBlock()`/`joinBlock()`/`updateBlock()` on anything but a text, `treeMove()`/`treeRemove()` on anything but a tree — the patches of `applyPatches()` alike; a list or text op past a bound of the field — pending work (`sync.pendingMax`, 4 096), a run (1 048 576 slots), the field as a whole (4 194 304 slots; see [Costs and limits](./text#costs-and-limits)), a splice whose cut names more than 65 536 ranges (one per run a deleted stretch crosses: delete in parts, or `compact()` first) or a `mark()` on a text that holds 65 536 marks already (a `move()` counts its position run against the field); a `treeMove()`/`treeRemove()` on a tree field that holds 65 536 moves already; an `inc()` that would take this node's sum of the counter past ±`Number.MAX_SAFE_INTEGER` | `field`, `kind` (`'register'`, `'counter'`, `'set'`, `'list'`, `'text'`, `'tree'` — or `'bound'`, with `detail` (`'pending'`, `'run'`, `'field'`, `'cuts'`, `'marks'`, `'moves'`, `'counter'` or `'paths'`), `count` and `max`); `prefix` when the field lies under a prefix a counter, a set, a list, a text or a tree holds |
| `OUT_OF_RANGE` | `splice()` past the length of a list or text field — the index, or the index plus the count; `setAt()`/`move()` at an index the list has not; `mark()`/`unmark()` over a range the text has not; `treeMove()` to a place that would read below the 512 levels a tree shows, or between neighbours with no room left for another fractional index | `id`, `field`, `index`, `count`, `length`; for a tree `node` and `depth`, `max`, or `reason: 'fi'`, `length`, `max` |
| `STALE` | `applyDelta()` with `expect` on a text field that reads otherwise inside the mutation queue — a peer's edit landed between the reading the delta was made over and the delta; nothing written | `id`, `field` |
| `SURROGATE` | `splice()`, `mark()`, `unmark()` or `cursor()` on a text at an index between the two halves of a surrogate pair (a character outside the BMP) — decided inside the mutation queue, against the text as it is; `updateText()` never makes one, its diff keeps a pair whole, and a string with a lone half is a `TypeError` | `id`, `field`, `index` |
| `CYCLE` | `treeMove()` to a parent that hangs under the node — decided inside the mutation queue, against the tree as it is (the node itself as its parent is a `TypeError`) | `id`, `field`, `node`, `parent` |
| `HISTORY_GONE` | `get(id, { at })`, `diff()`, `restore()` for a version the log cannot give exactly, `history({ before })` with an event id of another incarnation: `reason` `'compacted'` (dropped entries the version depends on, or a cut before anything retained), `'scrubbed'` (a cut before a purge), `'merge'` (a stamp below a joined snapshot), `'epoch'` (an event id of another incarnation) | `id`, `reason` |
| `INVALID_VERSION` | `get(id, { at })`, `diff()`, `restore()` with a version of the wrong shape, or an event id this log has not reached; `history({ before })` with a malformed event id (a `TypeError`) | — |
| `TAG_EXISTS` | `tag()` of a name in use | `tag` |
| `TAG_NOT_FOUND` | `untag()`, `at()`, `get(id, { at: { tag } })`, `diff()`/`restore()` at `{ tag }` of a tag this node has not — or of one whose catalog could not be read when first used, which a tag view's reads (`has()`, `list()`, a collection's `get()`/`select()`/`count()`, `snapshot()`) find too (the tag is dropped then, with a `tags.dropped` warning) | `tag` |
| `BRANCH_EXISTS` | `branch()` (`@alexify/syncom/branch`) at a path that holds a `branch.json`, or any file — another storage, say — already: a branch opens in a new directory | `path` |
| `ENCRYPTED` | `openText()` on an encrypted record; any op beyond a whole-record write — `inc()`, `add()`, `remove()`, `splice()`, `push()`, `updateText()`, `setAt()`, `move()`, `mark()`, `unmark()`, `unmarkById()`, `insertEmbed()`, `splitBlock()`, `joinBlock()`, `updateBlock()`, `treeMove()`, `treeRemove()` — on an encrypted record; `get(id, { at })` (not at a tag), `history()`, `diff()`, `restore()`, `compact()` of one: it has no past in the log; `{ encrypted: true }` on a replicated record; `db.attachments.put()` on a sealed record (`id`): the blobs store holds bytes in the clear, which the record's key does not cover | `id` (from `attachments.put()`) |
| `INTEGRITY` | a read (`get()`, `has()`, a cursor) or a write (it loads the record first) of a record whose file fails its chain block check, under `integrity: 'verify'`, or cannot be parsed at all (a file torn by a crash; `repair(id)` rebuilds it) | `id`, `cause` (the parse error, where there is one), `reason` (`'unreadable'` for a record the medium holds as no record) |
| `CORRUPT` | `createDatabase()` when `node.json`, `schema.json` or `.blockchain.json` cannot be read, or a log file that is there fails to read (an I/O error, its `cause`; `file`); `tag()` while `tags.json` cannot be read — the open went on without tags, kept the file as `tags.corrupt.json` and keeps the copies the tags would need under `tags/.pending/` until the file is repaired; `branchInfo()` and `drop()` (`@alexify/syncom/branch`) when `branch.json` cannot be read or is no branch file; `db.local.get()` (`@alexify/syncom/local`) of a document that does not parse (`key`) | `cause`; `file` from `tag()`; `key` from `db.local` |
| `DOWNGRADE` | `createDatabase()` with `ahead: 'hold'` and a schema version below the one the directory ran | — |
| `LOCKED` | `createDatabase()` while another instance holds the directory — at once under `lock: 'fail'`, after `lock.timeout` ms under `'wait'`; over an engine with a lease of its own (MongoDB), while another instance holds the lease | `path` |
| `READ_ONLY` | any write, `applyRemote()`, `mergeSnapshot()`, `transact()`, `tag()`, `repair()` on a database opened with `readOnly: true`, or on a writer whose lease was lost (`lease: true`); `sync.unit()` on either without a shared log (`reason: 'hosting'`): its log and vector are as of its open, so it hosts a feed from a [shared log](../guide/server-scaling#serve-every-hub-from-one-log) alone | `path`, `lease`; `reason` from `sync.unit()` |
| `REVOKED` | the manager's `error` event: a host took scopes back from this node (`syncom/revoke`, or hello's `revoked`); the registry entry is narrower, `onRevoke` ran or the records of those scopes were forgotten, the feed is open again under the new grant | `scopes`, `node` |
| `UNPROVEN` | the manager's `error` event: a host asked for a proof of this node's key (`challenge`) and this node has no signing key (the signing plugin); nothing is pushed to or taken from it | `url`, `node` |
| `WRITE_REFUSED` | the manager's `error` event: a host refused an op this node pushed, and took it as a withheld scrub — its `authorizeWrite` said no (`reason: 'rule'`; one of its own, `own: true`, has the fields it `touched` brought back to `current` through the kinds' own ops, or the record forgotten where the host holds nothing; a revert refused again, or a purge, is reported alone) or the host reads the record as outside this node's scopes (`reason: 'scope'`: reported alone, `current` null — the host hands over no record outside the grant); one it relayed is reported alone | `origin`, `seq`, `id`, `current`, `own`, `touched` (the fields, or null for the whole record), `reason` |
| `SHARED_LOG_FAILED` | the manager's `error` event, on a hub over a shared log (`sync.sharedLog`): an append failed (`reason: 'append'`, once per run — what the log holds since the watermark is appended again once the log answers), the watermark is below what the log retains (`'lost'`), the consumer's cursor names a position the log no longer has — trimmed past, or another log's (`'gone'`: read from the oldest entry; `cursor`), an entry failed to apply three times (`'stuck'`: nothing past it is taken until `sync.stop()` and `start()`; `cursor` its id), a snapshot's marker was not reached in time (`'marker'`), the log was stopped under a waiting snapshot (`'stopped'`) | `reason`, `topic`, `cursor`, `appended`, `cause` |
| `TARGET_NOT_EMPTY` | `copyEngine()` (`@alexify/syncom/engines`) when the target engine already holds a database at `path` (`node.json`, or a record) | `path` |
| `MOVED` | `createDatabase()` of a directory whose database `rotateAtRest()` copied elsewhere: `moved.json` in its root namespace names where (`to: { path, engine }`), and the directory opens nowhere until `dropDatabase()` takes it — the same node never writes in two places; `copyEngine()`/`rotateAtRest()` of such a source the same (`path`, `to`) | `path`, `to` |
| `BLOBS_UNSUPPORTED` | `copyEngine()` (and `rotateAtRest()`) when the target engine has no blobs store while the source holds blobs — refused before anything is written, never a copy whose registers name bytes nowhere | `engine`, `blobs` |
| `SCHEMA_MISMATCH` | `importJSON()` (`@alexify/syncom/dump`) of a dump made under another schema hash than this database runs, without `force` | `expected`, `given` |
| `PIPELINE_FAILED` | the database's `error` event when a pipeline's handler threw (`@alexify/syncom/pipeline`): the pipeline stopped before the turn, its checkpoint stays, `start()` hands the turn over again | `pipeline`, `eventId`, `cause` |
| `REPLICATION_FAILED` | a connector's `error` event (`@alexify/syncom/connector`): a pull or push handler threw, or the landing of what it answered failed (`direction`), tried again after `retryIn` ms (`retryTime` doubled per failure in a row up to `maxRetryTime`, with jitter); `start()` on a canceled connector, `reSync()` on one not active (`direction` null) | `direction`, `connector`, `cause`, `retryIn` |
| `ENGINE_UNREACHABLE` | `remoteEngine()`/`connectEngine()` (`/syncom/engines`): the served side is gone — its port closed or its worker exited (`reason: 'closed'`), or a call waited past `timeout` ms (`reason: 'timeout'`, `ms`) — every call waiting fails so, and every call after | `reason`, `ms` |
| `NOT_LEADER` | `shared.sync`, `shared.serve()` or a write without a channel on a follower of `@alexify/syncom/shared`: replication, the served writers and a write of its own are the leader's | `path`, `what` |
| `LEADER_LOST` | a follower's write (`@alexify/syncom/shared`) that reached no leader within `failover` ms — the leader gone and none elected in time, or a channel answering nothing readable (`method`, `id`, `attempts`, `cause`; `maybeApplied` true where a call that may have reached a leader was never answered) — or one tried again at a leader that never saw it (`CALL_UNKNOWN` as the `cause`: the leader changed between the call and its retry, `maybeApplied: true` — read the record before writing again); `openShared()` on a fresh path whose elected instance wrote no identity within `failover` ms (`reason: 'fresh'`) | `path`, `method`, `id`, `attempts`, `maybeApplied`, `reason`, `cause` |
| `CALL_UNKNOWN` | the leader's `serve()` answer to a forwarded call flagged `retry` whose id this leader never saw (it keeps the answers of the last 256 calls per follower, 64 followers, for this `serve()`): the call is never run; the follower turns it into `LEADER_LOST` with `maybeApplied` | `id`, `method` |
| `PROMOTE_FAILED` | the shared facade's `error` event: the instance elected could not open the database as the leader — `LOCKED` past the retries, the engine's error — so it yielded the election (the next in line leads), and asks again after a backoff (`attempt`, counted up per failure in a row) | `path`, `attempt`, `cause` |
| `QUOTA` | a log append refused for want of room: the medium is full (node:fs's ENOSPC, the browser's QuotaExceededError, SQLite's SQLITE_FULL, better-sqlite3's or node:sqlite's — on the error or a `cause` under it), the platform's error as `cause`; the write is refused whole, its seqs taken back, and the next append goes once there is room (`db.quota()`, `db.persist()`) | `cause` |
| `BLOB_UPLOAD_FAILED` | the manager's `error` event: a host did not take the bytes of an attachment this node pushed the entry of (`syncom/blobPut`) — it refused them (400, 403, 404, 413: final, `retry: false`, never asked again — a hub whose lease was lost among them, 403 `READ_ONLY`) or the call failed on the way (`retry: true`: tried again at the next push, a reconnect's or a restart's hello included); never fails the push. A follower hub's "not yet" (425) is not reported: the entry waits for the hub's next idle page | `digest`, `id`, `attachment`, `cause`, `retry` |
| `BLOB_NOT_FOUND` | `db.attachments.get()`: the record names bytes this node lacks and no connected peer holds (`id`, `attachment`, `digest`), or `fetch: false`; `sync.fetchBlob(digest)`: no connected peer holds the blob (`digest`, `asked`, `cause`) | `id`, `attachment`, `digest`, `asked`, `cause` |
| `BLOB_MISMATCH` | `db.attachments.get()`: the bytes under the register's digest are not what the register says — a plain blob of another `length` (`reason: 'length'`), a compressed one that inflates past `length` (`'inflated'`: the inflating stops there, nothing is inflated whole on a register's word) or to another length | `id`, `attachment`, `digest`, `reason` |
| `ATTACHMENT_INVALID` | `db.attachments.get()`/`has()` of a name whose register is no register — a `digest` that is not SHA-256 as hex, a `type` that is no text, a `length` that is no integer within 64 MiB, an `encoding` the plugin does not know (a peer writes registers too: one is believed only as far as it is one; `list()` leaves it out and warns `attachments.register.invalid` once) | `id`, `attachment` |
| `LEASE_LOST` | the storage's `error` event: the engine's lease on the database went to another instance (not renewed in time, or taken) — the database is read-only from here on and writes nothing more; what was logged but not landed is held (`UNPERSISTED`) for the next holder's replay. Also what an engine's write set, log group, seal, index, kv or copies put answers when a newer lease's document sits where it would write (MongoDB's fence) | `path`, `cause` |
| `FOLLOW_LOST` | the storage's `error` event, on a follower (`readOnly: true`): the engine's change stream ended — an error, a close — so what the writer landed meanwhile was not heard; the follower subscribes again first and then reads every record again (a record removed meanwhile loses its row) | `path`, `cause` |
| `KEYS_INCOMPLETE` | `createDatabase()` with the `encryption` or `signing` plugin, `loadKeys()` (`@alexify/syncom/encryption`), `loadSigningKeys()` (`@alexify/syncom/signing`) when one file of a pair (RSA or signing) is missing | — |
| `IDENTITY_MISMATCH` | `createDatabase()` with the `signing` plugin when `node.json` names another signing key than `keys/sign-public.pem` — a key pair replaced or restored under a signed identity | `id` (what `node.json` names), `key` (the pair on disk) |
| `BAD_SIGNATURE` | the storage's `error` event, once per page: a peer's op whose signature does not verify against its origin, or whose payload its digest does not match (`sync.signatures` `'verify'` or `'require'`) | `op` (the first refused), `count` |
| `UNSIGNED` | the storage's `error` event, once per page, under `sync.signatures: 'require'`: a peer's op with no signature, or whose origin is no signing key | `op`, `count` |
| `EQUIVOCATION` | the storage's `error` event, once per page: a writer made two ops at one seq of one stream — a directory restored from an older copy, a second instance under one identity, a key holder that lies. `reason` `'seq'`: a peer's op at a seq this node holds another op at; `'chain'`: the next op of a stream whose `prev` is not the fingerprint of the op this node holds at the seq before it (or names none, signed). Refused like a forged op — not logged, not relayed, a gap for its stream — and counted `equivocations` (see [Equivocation](../guide/operation-log#who-wrote-it-and-nothing-else-the-hash-chain)) | `op` (the first refused), `origin`, `scope` (`null` for the global one), `seq`, `held` (the fingerprint this node holds — at the op's seq, or at the one before it), `received` (the op's fingerprint, or the `prev` it names; `null` for none), `count` |
| `BAD_ENVELOPE` | `decrypt()` (`@alexify/syncom/encryption`) of a ciphertext this version does not read | — |
| `DECRYPT_FAILED` | a read through `atRest()` (`@alexify/syncom/encryption`) of a file that is not the key's: `reason` `'key'` (another key, or a torn ciphertext; a blob never sealed or moved to another place too — a blob is iv ‖ ciphertext bytes with nothing to tell plain from sealed), `'plain'` (a text not encrypted), `'torn'` (not base64); through a storage the first such file fails `createDatabase()` — as `CORRUPT` with this as its `cause` when it is `node.json`, as is otherwise | `path`, `reason`, `cause` |
| `BLOCK_NOT_FOUND` | `Blockchain.readBlock()` (`@alexify/syncom/chain`), `SmartContract.load()` | `hash` |
| `NOT_CONTRACT` | `SmartContract.load()` of a block that is not a contract | `hash` |
| `NODE_EXISTS` | `addNode()` of a registered url | `url` |
| `NODE_NOT_FOUND` | `removeNode()`, `enableNode()` of an unknown url | `url` |
| `BAD_HELLO` | the sync `error` event: the host's hello answer has no node id | `url` |
| `BAD_PAGE` | the sync `error` event, bootstrapping: the host's snapshot page is no object or has no records (`reason: 'shape'`), its cursor does not move past the last one (`'cursor'` — it would page for ever), or a streamed page passed `sync.maxPageBytes` (`'bytes'`); nothing more is joined from that page on | `url`, `reason` |
| `HANDSHAKE_LOOP` | the sync `error` event: five fresh hellos answered 428 in a row | `url`, `cause` |
| `PAGE_FAILED`, `STUCK` | the sync `error` event: a page of the feed could not be applied; the third in a row | `url`, `cursor`, `attempt`, `cause` |
| `STREAMS_UNSUPPORTED` | the sync `error` event: the host streamed a snapshot and the link cannot read streams | `url` |
| `UNRECOVERABLE` | `repair()` when the log holds no whole-record op for the id | `id` |
| `UNPERSISTED` | the storage's `error` event: ops were logged — the write stands, and replicates — but their record files (or chain block, or a tag's copy) could not be written; the records are held in memory and the next open replays the batch onto the files. Also `tag()` while a record is held: no file to copy from until it lands A medium that is full says so: `quota: true` (ENOSPC, QuotaExceededError) | `ids`, `cause` (the event's), `quota` |
| `REWOUND` | the sync `error` event, at a hello: the host holds more of this node's own ops than its log does — a directory restored from an older copy, another instance with this identity, or a host that says so. On proof — the host's `proof`, this node's own op at the seq it claims, signed by its key — or under `sync.rewind: 'adopt'`, the node moves those streams past the host's and bootstraps from it (writes made since the restore and before this hello are lost to the host); without, they stay where its log has them and go to that host no more until the next hello | `url`, `local`, `remote` (vector keys of this node → seq), `adopted` (the keys moved → seq; `{}` when none) |
| `UNDELIVERABLE` | the sync `error` event, once per hello: the host lacks ops of this node's own that its log no longer retains (written before any node was registered, and compacted since); they are not sent | `url`, `missing` (key → `{ host, retained }`) |
| `UNLOGGED` | a text handle's flush (`openText()`): its edits could not be logged — the append failed, or a hook or a validator refused one; the handle drops what was not logged (the batch, the flushes taken behind it, what still waits) and reads the field as announced again, its observers told to read it again (`reset`), `flushed` rejects with it (the handle's `error` event too) and `handle.unlogged` is logged. The storage's `flush()` and `tag()` flush every open handle and reject with one `UNLOGGED` for all that could not be (`close()` logs `edits.unlogged` instead and closes). A step that fails after the append — an `afterWrite` hook — is that error, not `UNLOGGED`: the edits are logged and the handle keeps them | `id`, `field`, `edits` (how many were dropped), `cause`; from the storage: `handles`, `edits`, `cause` |
| `KINDS_MISMATCH` | the sync `error` event, when a bootstrap would start: the host's `hello` named fewer kinds than this node runs with (a text node joining a core-only host), so its snapshot would lack those fields and the adopted vector would hide the ops behind them; nothing is joined, the feed is left to resume | `url`, `node`, `missing` (the kind names) |
| `SKEW`, `OP_UNREADABLE`, `OP_REFUSED`, `OP_INVALID` | the storage `error` event — see [Database events](./events#database-events) and, for `OP_REFUSED`, [When a peer's op is refused](./text#when-a-peer-s-op-is-refused) | `op`, plus `rejected` / `entity` + `issues`; `cause` for `OP_UNREADABLE` |
| `INVALID_ID` | every writer, `repair()`, `diff()`, `applyPatches()`, `compact()`, `spans()`, `cursor()`, `index()` given an id that is not a [valid id](../guide/database#use-your-own-ids) — and `insert()` when `getId` mints one; a composite id (`id: { fields }`) whose field is missing, holds the separator, or is not a string, a number or a boolean; `upsert()`/`insertIfAbsent()`/`bulkUpsert()` of data that names no id (a `TypeError`); `get()`, `has()` and `history()` answer as for an absent record | `entity`, `field` on an id the data of a collection should have named (the composite id's field, the id field) |
| `TYPE_IMMUTABLE` | a local `set()`, `update()`, `swap()`, `record.save()`, `modify()` or patch whose data names another `$type` than the record's, and an `unset()` (or `$unset`/`$rename`) of `$type` (a `TypeError`) | — |
| `ID_IMMUTABLE` | a local `set()`, `update()` (fields or operators), `modify()`, `unset()` or patch that changes or unsets a field the record's composite id is derived from (a `TypeError`) | — |
| `NO_CHAIN` | `validate()` under `createDatabase({ chain: false })` or without the `chain` plugin (a `TypeError`; the message says which) | — |
| `PLUGIN_MISSING` | a method, a patch action or a local op of a kind the storage was not opened with — `splice()` without the `text` plugin — and `createDatabase()` of a directory that ran with a kind the call lacks; `createDatabase()` asking for what no registered plugin provides — `sync.signatures: 'require'` without `signing`, `chain: true` without `chain`, `encrypted: true` without `encryption` — and a per-call `{ encrypted: true }` without it; a collection's `select()`/`count()`, `update(id, delta, { ifMatch })` and `watch()` without `query`, `db.local` without `local`, `addCollections()` with a validator without `schema` (a `TypeError`; the message names the subpath) | — |
| `BLOB_TOO_LARGE` | `db.attachments.put()`, an engine's `blobs.put()`, `serveEngine()`'s served store: a blob past `MAX_BLOB_BYTES` (the cap on plain bytes; an engine's store takes the at-rest seal's 28 bytes more, `MAX_STORED_BYTES`; 64 MiB — the one cap, `src/blobs.js`; what a peer may be asked for over `syncom/blob` is bounded the same) (a `TypeError`) | `length`, `max` |
| `PRESENCE_SIZE` | a presence `set()` whose state is past its bounds — 16 KiB, 64 keys, 8 deep (a `TypeError`) | — |
| `HOOK_FAILED` | a `HookError` | `hook`, `cause` |
| `VALIDATION_FAILED` | a `ValidationError` | `entity`, `issues`, `cause` |

A refusal the host answers on the wire is not a `SyncomError`: it is a plain
error with the numeric `code` wrpc transports (`400` `BAD_HELLO` or
`PROTOCOL`, `403` `UNAUTHORIZED`, `SCOPES` or `UNSIGNED` (a `sync.signatures: 'require'`
host greeted by a node id that is no signing key), `409` `SELF`, `413`
`OPS_PER_PUSH` or `BYTES_PER_PUSH`, `428` `HELLO_FIRST`, `429`
`OPS_PER_SECOND`) and that constant as `reason` on the host's side — in the
`sync.hello.refused` log line and on the thrown error; wrpc carries the code
and the message. The dialer sees the numeric code through its `error` event.

### `HookError`

What an operation rejects with when one of its hooks threw: `name`
`'HookError'`, `code` `'HOOK_FAILED'`, `hook` (the hook's name), `cause` (the
original error). A `SyncomError`; exported from the package root.

### `ValidationError`

What a write rejects with when the record would not pass its entity's
validator — nothing was stamped, logged or written: `name`
`'ValidationError'`, `code` `'VALIDATION_FAILED'`, `entity` (the collection),
`issues` (`[{ path, message, code? }]`), and `cause` when the validator threw
something of its own. A `SyncomError`; exported from the package root.

### `isSyncLink(value)` / `outbound(log, { exclude, vector, scopes, own, allStreams })`

`isSyncLink` is the structural check for the [link contract](./wire#the-link-contract).
`outbound` is the selection a push and a branch merge make, as a function:
what `log` (`storage.log`) has that a receiver (`exclude`, its node id)
lacks by its version `vector`, in `scopes` (`null`: every scope), as `{ ops,
first }` — `first` the first seq the log retains per stream of the sender
(`own`), or of every origin with `allStreams`. With `applyRemote()` on the
receiving side it is the updates API of a transport of the application's
own, no `sync` plugin needed (see [Without the plugin](../guide/sync-protocol#sync-without-the-plugin)).

### `isSharedLog(value)`

Structural check for the `SharedLog` contract (`append`, `read`, `parseId` —
the shape of wrpc's `BrokerLog`, so a broker's `.log` fits with no adapter, and
so does `mongoSharedLog()` of `@alexify/syncom/mongodb`): what
`createDatabase({ sync: { sharedLog } })` takes — the log alone, or `{ log, topic,
inbox }` — for the hubs of a mesh to serve `changes` from one log, so a client
resumes on any of them; see [Scaling](../guide/server-scaling#serve-every-hub-from-one-log).

## Operation log and model

### `OpLog`

`await new OpLog(basePath, { rollAfter, retention, logger, telemetry, fsi, sealApplied, onRoll })` —
`storage.log` is the one you want; `telemetry` here is a writer
(`createTelemetry()` from `@alexify/syncom/telemetry`). With `sealApplied` (what the storage asks
for) a roll seals only the batches marked `applied`; `onRoll` is told
`{ sealed, dropped, floor, segments }` after every seal (the storage's `log`
event).

| Member | Notes |
| --- | --- |
| `epoch`, `floor`, `next`, `vector`, `length`, `lastEventId` | See [The log](../guide/operation-log) |
| `formatId(seq)`, `seqOf(key)` | The event id of a seq of this log; one key of the vector (`origin` or `origin@scope`) without copying it |
| `segments`, `retainedOps`, `latestTs`, `pins`, `corrupt` | Sealed segments on disk; how many ops retention keeps at least (`Infinity` when no count bounds it, as under `retention: 'all'`); the newest stamp held since the open (what the clock is seeded from); how many `pin()` readers there are; how many files failed their checksum at this open |
| `append(ops, { skipped, held }?)` | `Promise<LogEntry[]>` — entries with their seqs, once on disk; `skipped` ops are flagged, `held` ones with the version they wait for |
| `held()` | `LogEntry[]` — the entries held for a newer schema version |
| `droppedHeld`, `resetDroppedHeld()` | Held entries compaction dropped since the last reset |
| `droppedTs` | The newest stamp among the ops the log no longer holds — compacted, or unreadable at open; `0` while nothing was ever dropped. A record's past is whole from a reset (`write`, `delete`, `purge`) stamped above it |
| `retain(keep)` | Entries `keep(entry)` answers true for stay, with their segment and everything after it, whatever the retention; `null` clears it. One slot — the sync manager's, which keeps a dialing node's own ops until every node it syncs with has them |
| `pin(keep)` → `unpin()` | Like `retain`, for a reader of the past: the entries `keep(entry)` answers true for stay, with their segment and everything after it, until `unpin()`; pins add up, `retain` stays the sync manager's |
| `scrub(ids)` | `Promise<number>` — strips the payload of every entry of an id, or of each of an array of ids, and the nonce that salted its digest (`scrubbed: true`), in memory and on disk — a file holding entries of several of them rewritten once; the signature and the digest stay, so the header still verifies |
| `read(eventId, { scopes, limit }?)` | `{ entries, last }` — the entries in `scopes` after the id, and the seq of the last entry examined (in scope or not; where a feed's cursor may move), or `null` when it cannot be resumed |
| `since(eventId, { scopes, limit }?)` | `read(...).entries`, or `null` when it cannot be resumed |
| `entriesOf(id)` | Every retained entry of the record, oldest first — what `repair()` replays and `history()` folds |
| `advance(vector)` | Adopts a vector (after a snapshot) |
| `tail()` | The unsealed entries a reopen replays |
| `applied(from, to?)` | The batches within `from..to` are reflected in the records; under `sealApplied` a roll stops short of the oldest batch not yet applied |
| `flush()` | Seals the open files now (what `applied` allows) |
| `close()` | Seals what can be sealed and writes the index |

### `applyOp(entry, op, { pendingMax, plugins }?)` / `mergeEntry(a, b, { plugins }?)` / `isAlive(entry)`

The record-level model: apply one op to an entry (`{ entry, changed, delta,
rejected }`, `rejected` the refused fields as the `error` event carries them;
`pendingMax` the bound `sync.pendingMax` sets, 4 096 by default), join two
entries, and whether an entry is a live record or a tombstone. Pure functions;
`entry` may be `null`.

## CRDT

| Function | Returns |
| --- | --- |
| `diff(source, target)` | The delta turning `source` into `target` |
| `merge(source, delta)` | A new object with the delta applied |
| `apply(source, history)` | The state after replaying an operation log |

See [CRDT deltas](../guide/crdt) for the merge rules — numbers add rather than
replace. These are plain-object deltas, not how a storage replicates (its
op model is), and this `diff` is neither `storage.diff(id, from, to)` — the
versions plugin's [patches](#versions-subpath) — nor the editor's
`diffSpans`/`diffBlocks`, a delta between two readings of a text.

## Chain (subpath)

```js
const { chain, Blockchain } = require('@alexify/syncom/chain');
```

`chain` is the plugin: `createDatabase({ plugins: [chain] })` writes a block per applied
batch, checks a record file against its block on a cold read and gives
`validate()` something to walk (see [Blockchain log](../guide/chain)); without
it no block is written, `stats().chain` is `null` and `validate()` rejects
with `NO_CHAIN` naming the plugin, `createDatabase({ chain: true })` is `PLUGIN_MISSING`.
`createDatabase({ chain: false })` keeps the plugin registered and the chain off.
Blocks are SHA-256 of their JSON through Web Crypto on both platforms.

### `Blockchain`

`await new Blockchain(basePath, { fsi }?)` — the chain on its own (`{ kv }` opens it over an engine's kv store, as the plugin does).

| Method | Returns |
| --- | --- |
| `addBlock(data)` | `Promise<string>` — the new tail hash, written at once |
| `block(data)` | `Promise<{ hash, puts }>` — the next block and its tail as the kv puts of a write set; the storage lands them with the records they name, then `committed(hash)` |
| `committed(hash)` | `void` — the tail moves here once the puts are down |
| `readBlock(hash)` | `Promise<Block>` — throws if unknown |
| `writeBlock(block)` | `Promise<string>` |
| `writeChain()` | `Promise<void>` — persists the tail pointer |
| `validate(options?)` | `Promise<boolean>` — `{ last, from }`; an unknown `from` is `false` |

Properties: `path`, `tailHash`. A block is `{ prev, timestamp, data }`; its hash is the SHA-256 of that
object, and it is kept as `<hash>.json` (the `blockchain` kv namespace) with the tail's hash in
`.blockchain.json`, so a chain reopens without a listing. The genesis block has `prev: '0'`. `readBlock()`
rejects an unknown hash with `BLOCK_NOT_FOUND`; `validate()` answers `false` for one instead. Validation
re-hashes each block against the hash it is filed under, walking back to the genesis or the `last` limit: a
read per block visited, linear in the chain — bound it with `last` on a hot path.

What a storage commits: a local write `{ id, hash, from }` — the record, the SHA-256 of its data, its
event id in the log; an encrypted write, which makes no op, `{ id, hash }`; a batch `{ records: { [id]:
hash }, from, to }` for every record it touched — a peer's page, a snapshot page, the tail a reopen
replays, a `repair(id)`, the local writes `createDatabase({ defer })` held back. `validate(id, data,
block)` takes either shape, and a tag's copy of a record file keeps the block it named and is checked like
the file. Each node's chain is its own record of what it applied, in its order: two nodes that hold the same
records hold different chains, and the chain is no consensus. No block is ever dropped — `validate()` walks
from the genesis, so a block taken away would leave the records above it unverifiable: a block per landing,
a file on the files engine, a row or a document on SQLite and MongoDB, for as long as the database is
written. A hub that only replicates runs with `chain: false`.

## Contracts (subpath)

```js
const { SmartContract, DataReader } = require('@alexify/syncom/contracts');
```

Off the package root on purpose: `SmartContract.load` runs code from the
chain, and a process that never imports the subpath never does.

### `SmartContract`

`new SmartContract(name, proc, { storage, chain })`.

- `execute(args)` — runs `proc(reader, args)`, saves the result under
  `args.id`, records failures as chain blocks and re-throws.
- `SmartContract.save(name, chain, proc)` — `Promise<string>` (the block hash).
- `SmartContract.load(hash, { storage, chain })` — `Promise<SmartContract>`.

### `DataReader`

`new DataReader(storage)`; `get(id)` returns `Promise<unknown>`. The only
storage access a contract has.

## Signing (subpath)

```js
const { signing, calculateHash, generateSigningKeys, loadSigningKeys, sign, verify } = require('@alexify/syncom/signing');
```

`signing` is the plugin: `createDatabase({ plugins: [signing] })` makes the node id its
Ed25519 public key (`keys/sign-public.pem`, made at the first open), signs
every op the node makes and verifies a peer's against its origin under
`sync.signatures` (see [Signatures](../guide/signing)). Without it
the node id is what `getId` mints (a UUID by default), nothing is signed and
nothing is checked — the semantics of an unsigned op under `'verify'`, now for
every op — and `sync.signatures: 'require'` is `PLUGIN_MISSING` at `createDatabase()`.
A directory that ran with the plugin keeps the key as its id without it; one
born without it is rekeyed once, with an `identity.rekeyed` warning, when the
plugin arrives.

| Function | Node.js | Browser |
| --- | --- | --- |
| `calculateHash(data)` | `string` | `Promise<string>` |
| `generateSigningKeys()` | `Promise<SigningKeyPair>` | `Promise<SigningKeyPair>` |
| `loadSigningKeys(basePath, { fsi }?)` | `Promise<SigningKeyPair>` | `Promise<SigningKeyPair>` |
| `sign(message, privateKey)` | `string` | `Promise<string>` |
| `verify(message, signature, publicKey)` | `boolean` | `Promise<boolean>` |

`calculateHash` is SHA-256 over `JSON.stringify(data)`, hex-encoded.
`SigningKeyPair` is `{ publicKey, privateKey, id }`: a PEM-encoded Ed25519 pair
and `id`, the raw public key in base64url (43 characters) — the node id of a
storage that loaded it. `loadSigningKeys` reads `sign-public.pem` /
`sign-private.pem` from `basePath`, generating and writing them when neither
exists, and rejecting with `code: 'KEYS_INCOMPLETE'` when only one does.
`sign` takes a string (UTF-8) and gives the 64-byte signature in base64url;
`verify` takes the message, that signature and an `id`, and answers `false` —
never a throw — for an id that is no key or a signature of the wrong shape.

## Encryption (subpath)

```js
const { encryption, atRest, generateKeys, loadKeys, encrypt, decrypt } = require('@alexify/syncom/encryption');
```

`encryption` is the plugin behind `{ encrypted: true }` — a record sealed for
this node's RSA pair (`keys/public.pem`, `keys/private.pem`), written outside
the op log, never replicated (see [Encryption at rest](../guide/encryption));
without it `createDatabase({ encrypted: true })` and a per-call `{ encrypted: true }` are
`PLUGIN_MISSING`.

`atRest(fsi, { key | password, salt, iterations })` wraps a backend so that
every file a storage writes through it — the records, the log, the catalog,
the tags, `node.json`, the lock, the keys — is AES-256-GCM ciphertext under one
key (`enc1:` and base64 of iv ‖ ciphertext ‖ tag), decrypted on the way back;
`exists`, `remove`, `list`, `sync` and `create` pass through. `key` is 32
bytes (a `Uint8Array`) or a Web Crypto AES-GCM `CryptoKey`; `password` with a
`salt` of 8 characters or more derives one by PBKDF2-SHA-256 (`iterations`
600 000 by default, 1 000 at least). The key is never written. A file that
is not the key's is `DECRYPT_FAILED` (`reason` `'key'`, `'plain'`, `'torn'`);
through a storage the first such file fails `createDatabase()`. The options are
checked when the wrapper is made (a `TypeError`). See
[Encrypted at rest](./engines#encrypted-at-rest).

| Function | Node.js | Browser |
| --- | --- | --- |
| `generateKeys()` | `Promise<KeyPair>` | `Promise<KeyPair>` |
| `loadKeys(basePath, { fsi }?)` | `Promise<KeyPair>` | `Promise<KeyPair>` |
| `encrypt(data, publicKey)` | `string` | `Promise<string>` |
| `decrypt(data, privateKey)` | `unknown` | `Promise<unknown>` |

`KeyPair` is `{ publicKey, privateKey }`, PEM-encoded RSA-2048. `encrypt`
returns a JSON envelope — AES-256-GCM under a fresh key, that key wrapped with
RSA-OAEP (SHA-256) — identical on both platforms. `loadKeys` reads
`public.pem` / `private.pem` from `basePath`, generating and writing them
(`private.pem` owner-only where the backend has permissions) when neither
exists, and rejecting with `code: 'KEYS_INCOMPLETE'` when only one does.

A field sealed end to end — for the readers of a scope, not this node alone — is the application's: wrpc's
`createSealer`/`createOpener` (`@alexify/wrpc/encryption`) seal in `beforeWrite` and open in `afterRead`,
nothing of this package involved. What the op model makes of it: a register holding ciphertext converges
like any register; a counter cannot be sealed (its sum needs the number); an index, a unique key, a query or
a `$text` search over a sealed field sees ciphertext and cannot work; and a peer that cannot open it reads the
ciphertext.

## Schema (subpath)

```js
const { schema, ValidationError } = require('@alexify/syncom/schema');
```

`schema` is the plugin: `createDatabase({ plugins: [schema], schema, validator })` reads
the entity definitions once — the validators adapted (Standard Schema, a
function, what `validator.compile` gives), the id fields, the indexes and
search fields, the migrations and the lens — and the core applies them:
collections on the storage, validation on the write path, the catalog's
indexes, `schemaInfo` for hello, `migrate()` and `check()` (see
[Schema and validation](../guide/schema)). Without the plugin `createDatabase({ schema })`
and `createDatabase({ validator })` are `PLUGIN_MISSING`, as are `migrate()` and
`check()`, and records are untyped — `$type` a field like any other.
`ValidationError` is the root's, re-exported, and so are the types a schema
carries for TypeScript: `Shapes`, `SchemaOutput<S>`, `SchemaInput<S>`,
`RecordData` (see [TypeScript](../guide/typescript)).

### Schema options

| Option | Where | Meaning |
| --- | --- | --- |
| `schema.version` | `createDatabase({ schema })` | A positive integer, default 1; on every op as `v`, on a record as `meta.v` — what its newest whole-record write or migration said |
| `schema.snapshot` | `createDatabase({ schema })` | Any JSON describing the schema (`model.toJSON()`); hashed into `schemaInfo.hash`, kept in `schema.json`, exchanged in hello — the same version with another hash on a peer is a `schema` event `{ kind: 'drift' }` |
| `schema.entities[name]` | `createDatabase({ schema })`, `addCollections()` | `{ schema?, idField?, validate?, index?, unique?, fields?, search?, id?, refs?, methods?, statics? }`; `{}` is a bare collection; a plain object or a `Map`; any other key is a `TypeError` naming the keys it takes |
| `schema.entities[name].schema` | | A Standard Schema (`~standard`: metaschema, zod, valibot, arktype), a function (returns the value, `true` or nothing for "as given", throws, or returns `false` with `fn.errors` as ajv does), or a plain object `validator.compile(schema, { entity })` turns into such a function; anything else is a `TypeError` |
| `schema.entities[name].idField` | | The key the record id is handed to the validator under, dropped from its output again; `false` passes none. Default: `id` when the schema's field map (`fields`, zod's `shape`, valibot's `entries`) has it, metaschema's `<entityName>Id` when it has that, `false` when it shows fields and has neither, `id` when it shows none (a function, a JSON Schema). Without `id` below, a string under it in the data names the record (and leaves the data) |
| `schema.entities[name].validate` | | `false`: read the schema's indexes and fields, validate nothing (`@alexify/metaschema/definition`) |
| `schema.entities[name].index` | | Fields and compound keys — `['orgId', ['orgId', 'createdAt']]` — each a sorted index the catalog keeps; read off a metaschema schema's `indexes` (a compound one stays a key) and `index: true` fields when absent. See [Query optimizer](../guide/query-optimizer) |
| `schema.entities[name].unique` | | Unique keys, single fields or composites; read off a metaschema schema's `indexes` (`{ unique: [...] }`) and `unique: true` fields when absent. A local write that would take a key another live record holds is a `ValidationError`, issue `{ code: 'unique', path: fields, conflict }`, after validation and before anything is logged; across peers both records are kept and the `conflict` event `{ kind: 'unique', entity, fields, id, other, op }` names them. A unique key over an array compares the whole array |
| `schema.entities[name].id` | | A composite id: `{ fields, separator? }` — the record id is the fields' values (strings, numbers or booleans, every one present, none holding the separator) joined by `separator` (`'.'` unless given; of the id class), derived on `insert()`, `upsert()`, `insertIfAbsent()` and the bulk writes; the fields stay in the record and are immutable; a field missing, of another type or holding the separator is `INVALID_ID` with `entity` and `field` |
| `schema.entities[name].refs` | | `{ author: 'Author', tags: ['Tag'] }` — the records a field names; a `Document` reads it as a `Reference`, `populate()` resolves it; read off a metaschema relation (`author: 'Author'`, `{ many: 'Tag' }`) when absent. See [Population](../guide/population) |
| `schema.entities[name].methods`, `.statics` | | Functions on every `Document` of the collection (bound, non-enumerable), and on the collection; a name a Document or a Collection answers to already is a `TypeError`. See [ORM methods](../guide/orm) |
| `schema.entities[name].search` | | Field paths `$text` searches; explicit for every validator, never read off a schema; needs `createDatabase({ search })` — see [Full-text search](../guide/fulltext-search) |
| `schema.entities[name].fields` | | Free-form field notes, kept as given |
| `schema.migrations` | `createDatabase({ schema })` | `{ [toVersion]: { up } \| { [entity]: { up } } }` — see [Schema migration](../guide/migration-schema) |
| `schema.ahead` | `createDatabase({ schema })` | `'apply'` (default) or `'hold'` (needs `sync.retention.ops` of 1000 or more, or `0`) |
| `schema.lens` | `createDatabase({ schema })` | `'both'` (default), `'migrations'`, `'validate'` (refused together with `migrations`) |
| `validator` | `createDatabase({ validator })` | `{ compile(schema, { entity }) }` for plain-object schemas; must return a function |
| `db.check(entity, data)` | — | The validator's value, nothing written |
| `db.schemaInfo` | — | `{ version, hash, previous, held }`; `null` without a schema — `previous` `{ version, hash }` of what the directory ran when it differs, `held` `{ replayed, lost }` under `ahead: 'hold'` (see [Versions and the lens](#versions-and-the-lens)) |
| `db.migrate(options?)` | — | `{ migrated, counters, sets, lists, texts, trees }` — how many records, then how many fields of each kind were laid again (none where the lens changed registers alone) |

### What a metaschema entity brings

An entity whose `schema` is a metaschema `Schema` is read whole:

| From the metaschema `Schema` | What syncom does |
| --- | --- |
| `~standard.validate` | Validates every write of the collection; its value — defaults, decoders, aliases resolved — is what is written and replicated |
| The kind's id field (`projectId` of a `Registry` entity `Project`) | The record id is handed to the validator under it; a `Struct` without an id-like field is handed none |
| `indexes` (`{ index: [...] }`, `{ unique: [...] }`) and `unique: true` / `index: true` fields | The catalog's sorted indexes and unique keys; a `many` relation is left alone |
| A relation (`author: 'Author'`, `{ many: 'Tag' }`) | The entity's `refs`, when it names none |
| `model.toJSON()` given as `schema.snapshot` | Hashed into `schemaInfo.hash`, exchanged in hello, drift reported |
| `unknown: 'reject'` (metaschema's default) | A key the schema does not know is a `ValidationError` with `code: 'unexpected'`; `unknown: 'ignore'` lets peers on a newer schema add fields |

zod's `shape` and valibot's `entries` are read for `idField` the way `fields` is; their indexes are explicit
(`{ schema, index, unique }`), since such a schema has none to read.

### Versions and the lens

`schema.version` is stamped on every op this node makes as `v`, and a record remembers the version it is of as
`meta.v`, which tells a node on another version which shape the record is in: the `v` of its newest whole-record
`write` or `version` op (a migration), last writer wins by the op's stamp (`meta.vs`), so every node agrees on it
whatever order the ops arrived in — a whole-record write of an older version stamped after a migration makes the
record that version again.
`schema.json` (the root kv namespace, `{ version, migrated, hash }`) remembers the version and the snapshot
hash this directory last ran: when either differs at open, `schemaInfo.previous` is `{ version, hash }` of
what it was — an upgrade to run `migrate()` after, a snapshot change of the same version (`schema.changed`,
info), or a downgrade (`schema.upgrade` at warn; refused as `DOWNGRADE` under `ahead: 'hold'`) — and `null`
otherwise. `migrated` is when this version first ran here, kept across a snapshot change.

A record of an older version is read through the **lens**, nothing rewritten, the view computed once per
cached entry: first the migrations from its version up to this one — `migrations` keyed by the version each
migrates *to*, storage-wide `{ up }` or per entity `{ Post: { up } }`, `up(data, { entity, id, from, to })`
given the record without `$type` and returning it as it is under `to` (anything but an object is a
`TypeError`) — then the entity's Standard Schema validator, whose aliases and defaults are a rename and a
fill for free. A validator that refuses the record leaves the migrations' result (`schema.lens.issues` at
debug). `lens` picks the steps: `'both'`, `'migrations'`, `'validate'`.

What reads through the lens: `get()` and everything over it, `swap()`'s comparison, a cursor, the catalog's
indexed values, a `Document` as it loads, `diff()`. What reads raw: `snapshot()`, `getCachedData()`,
`spans()`, the `commit` event's `before`/`after`, the ops and replication — a peer on the older version sees the record exactly
as it was written. A write validates the record as it reads and carries only the keys it changed (see
[How a write is validated](#how-a-write-is-validated)).

A local op of a field — `set` (an `update()`, a `swap()`, `modify()`'s difference), `unset`, `inc`, `add`,
`remove`, a list, text or tree op, in a transaction or alone — on a live record whose `meta.v` is below this
version first migrates the record as `migrate()` would, then the op — one transaction, one turn, so nothing reads
the record in between (the lens, run over the record and the op's fields at once, would read them over). The
migration is not validated alone: the op after it is, over the record as they leave it. An op made alone that
makes nothing (a `swap()` mismatch, an `unset` of nothing) throws the transaction away, the migration with it; a
whole-record write needs none; an editor's handle (`openText()`) edits the record as it is.

The migration of one record is one `version` op and, rarely, the ops that lay a field again. The record is
compared as it reads, name by name (a top-level name with everything under it), stored against lensed:

- A name the lens left as it read is not written, whatever its kind: a text keeps its runs, their authors and its
  marks, a counter its slots, a set its tags, a list and a tree their elements and moves, every stamp as it was.
  A peer's op on such a field — made before or after it heard of the migration — lands as on any record.
- A name the lens removed is unset, and a register it wrote or added is set, both by the `version` op itself, at
  its stamp.
- A counter, a set, a list, a text or a tree the lens rewrote is unset by the `version` op and laid again after
  it from what it reads as now — one `inc`, one `add`, one `splice` per list or text, one move per tree node —
  where the new value is still one of that kind; a new name that reads exactly as a removed counter, set, list,
  text or tree did is that field renamed, laid the same way under the new name — a renamed text with its marks
  and the values of its embeds, a rewritten one without. Its earlier state is gone with the unset: who wrote
  what, the cursors into it, a peer's op on the old field stamped below the migration. Two migrations of one record leave such a field laid once, the later one's — unless their stamps
  interleave (two nodes migrating within the same milliseconds), where both lay it.
- A value of another type than the kind reads as, and a name with paths (or a list's or a tree's members' fields)
  under it that the lens changed, are written as registers. A set, a list, a text or a tree that reads empty after
  the lens is left out — no op makes an empty one — so the record holds no such field until the kind's next op.

`migrate({ entities, batch, actor })` migrates what the lens only reads: every live record of an older version,
each in a transaction of its own, read again inside the queue (one a local write or a peer migrated meanwhile is
left alone). It resolves to `{ migrated, counters, sets, lists, texts, trees }` — the records, then the fields of
each kind laid again. Run it on one node after an upgrade; the peers receive ordinary ops. It is idempotent, and
`entities` keeps it to those collections.

An op from a **newer** version is `ahead`: `'apply'` applies it as it is, unvalidated (registers are
forward-tolerant; the validator does not know its shape), with the `schema` event `{ kind: 'ahead', op,
held: false }`; `'hold'` keeps it in the log, skipped and flagged with its version, relays it, and applies it
at the first open that runs that version — `schemaInfo.held` is then `{ replayed, lost }`, `lost` the held
ops retention dropped before the upgrade. A hold needs `sync.retention.ops` of 1 000 or more, or `0`.

### How a write is validated

The validator sees the record **as the op leaves it**, under its id field and without `$type`: for a
`write` the whole new record, for a `set` the whole record after the delta, for an `inc`, `add`, `remove`
or a list, text or tree op (`splice`, `assign`, `move`, `mark`, `tree`) the record with that field as it
reads after the op. A counter, set, list, text or tree op carries no record data, so for it the verdict
alone counts — and a field the schema does not name is an unknown key there too. What the validator
returns is folded back into a `write` or a `set`, taken as JSON:

- a `write` becomes the validated record — defaults filled, aliases renamed, unknown keys stripped if the
  validator strips;
- a `set` keeps only the keys it named (in their validated form, read by path) and the top-level keys whose
  validated value differs from how the record read before — a default on a record that lacked it, an alias
  target. A delta key the validator dropped drops out of the op. A `set` is never promoted to a `write`:
  that would reset the record and erase concurrent sets and counters from other peers. So a field is
  written by its own name, not an alias: a delta under an alias of a field the record already has changes
  nothing, and the alias key an older record holds stays until a whole-record write replaces it.

A failed write rejects with a `ValidationError` — `code: 'VALIDATION_FAILED'`, `entity`, `issues` as
`[{ path, message, code? }]` (ajv's `instancePath` and `keyword` map onto `path` and `code`), `cause` when
the validator threw something of its own — and nothing was stamped, logged or written. A peer's op is
validated against this node's schema and never rewritten — a default this node's validator would fill is not
filled into a peer's write — and one that would leave the record invalid is skipped exactly like a
`beforeApply` returning `false` (logged, relayed, replay-safe), reported through the
`error` event (`OP_INVALID`, `error.entity`, `error.issues`) and the `syncom.ops.rejected` metric with
reason `validation`. The writer's record and this node's then differ in those fields until a newer write of
them. The verdict is this node's, over the record as it holds it when the op arrives: a validator whose
verdict for a field depends on other fields can pass two concurrent ops where each was made and fail them
together, each node then skips the one it applies second, and the nodes hold different records — such a rule
is the host's (`authorizeWrite`, asked once and told to the writer), see
[Schema validation](../guide/schema-validation#check-a-rule-that-spans-two-fields). `merge`, `delete` and
`purge` are not validated. `delete()` and `purge()` are never validated locally
either.

## Query (subpath)

```js
const { query } = require('@alexify/syncom/query');
```

`query` is the plugin: `createDatabase({ plugins: [query] })` gives every collection
its `select(query)` cursor, `count(query)` and `watch()`, and a view at a tag
its `select()`/`count()` (see [Queries](../guide/query)). The catalog, its
indexes and the text index behind `$text` (`createDatabase({ search })`) are the
core's, kept whether or not anything queries them; without the plugin
`select()` and `count()` throw `PLUGIN_MISSING`.

### The query

| Form | Matches when |
| --- | --- |
| `{ field: value }` | The field equals the value (deep); an **array** field holds the value as an element (indexed or not — a set, a list, or any array); an array value matches an array field whole, in order |
| `{ 'a.b': value }` | A dotted path reaches into the record; a number reaches into an array by position (`'items.0.n'`) |
| `{ id: … }` | The record id; a data field named `id` is not it, in a query, a write by query or an `ifMatch` |
| `$eq`, `$ne` | Equality, as above, and its negation (a record without the field matches `$ne`) |
| `$in`, `$nin` | Any of the values matches (the array rule applies), or none does |
| `$gt`, `$gte`, `$lt`, `$lte` | Ordered comparison between values of **one kind** — number with number, string with string, boolean with boolean; anything else is false. An array field: any element |
| `$exists` | `true`: the field is present (`null` counts); `false`: absent |
| `$type` | What the value is, in JSON's terms: `'null'`, `'boolean'`, `'number'`, `'string'`, `'array'`, `'object'` |
| `$regex`, `$options` | A `RegExp` or a source string, with flags; strings only (an array field: any element); the `g` and `y` flags are dropped; a `RegExp` given as a plain value is compared for equality |
| `$size` | An array of exactly that many elements |
| `$mod: [divisor, remainder]` | A number with that remainder |
| `$all: [...]` | An array holding every one of the values |
| `$elemMatch: {...}` | An array with an element matching the query — an object element by a query of its fields, a scalar one by the operators (`{ $elemMatch: { $gt: 3 } }`) |
| `$and: [...]`, `$or: [...]`, `$nor: [...]`, `$not: {...}` | Nest freely |
| `$text: 'words'` | Full-text, over the entity's `search` fields through the injected index; top level only, once — see [Full-text search](../guide/fulltext-search) |

A query sees a record as it reads (the lens applied, the paths composed): a list field is its array, a text
its string, a tree its array of `{ id, children }`. A malformed query — an unknown operator, `$in` without an
array, an invalid regex, a `$text` that is not a string, is over 1000 characters or sits inside
`$and`/`$or`/`$not`, a `$text` on a collection with no search fields — is a `TypeError` at `select()`, not at
`fetch()`. A query nests 32 levels at most (`$and`, `$or`, `$nor`, `$not`, `$elemMatch` within one another):
deeper is a `TypeError`. A field name is not checked: a name no record has matches nothing. A `$regex` is
the application's: a pattern runs on this node's event loop, and a pathological one (`^(a+)+$` over a long
string) runs for minutes — so a host serving queries to peers (`unit({ query })`, see
[`unit()` options](#unit-options)) refuses a `$regex` from the wire unless told to take them, `'safe'`
letting through what `safeRegex` passes (no nested quantifier, no backreference, no lookaround — the
shape, not a proof).

The sort order of `order()`/`desc()` is one order for every value: nothing (`null`, absent) first, then
booleans, numbers, strings; arrays and objects stay where they were. A result has one order — the keys,
then the id — so an unordered cursor hands its rows out by id (a `$text` query without keys keeps the
index's ranking). A cursor reads the records themselves — like `snapshot()` and `swap()`, not through
`get()`, so `beforeRead`/`afterRead` do not run. Records outside the collection, deleted ones and, unless
the collection's `select()` reads them at the key holder, encrypted ones are never rows. A cursor at a tag
(`db.at(name).collection(entity).select(query)`) reads the records as they were then, over the tag's
catalog: `watch()` on it throws, and a `$text` query there is a `TypeError`.

### The plan

The entity's `index` (fields and compound keys) and its `unique` keys are what the
[catalog](#the-catalog-and-the-cache) keeps per record, in memory on every engine: a posting list per indexed
field for equality, and a sorted index per declared key (the rows in key order, then id). A cursor is
planned over them once — and again where the collection is defined anew (`addCollections()`,
`removeCollection()`) — and `explain()` shows the plan:

- **An index** serves a query by its longest prefix of fields the query holds an equality on (`field: value`,
  `$eq`), then a `$in` of up to 16 values on the next field (`in`: one sub-scan per value, in key order),
  then one field more for a range (`$gt`/`$gte`/`$lt`/`$lte`) or the sort. The scan is bounded — a binary
  search to each edge — and comes sorted by the index where the order's keys are the index's next fields in
  one direction, reaching its end (`desc` scans backwards); an ordered, limited cursor then reads
  `offset + limit` records and no more. A sort the index cannot serve reads by the prefix and sorts after.
  Of several indexes the one expected to read the fewest records wins (`estimate`: the scan's entries, no
  more than the narrowest posting list of the indexed equalities it leaves to the catalog — those `narrow`
  the scan before a record is read — no more than the window where sorted); a tie goes to the sorted one,
  then the longer prefix. An index that serves the sort alone is taken only for a finite window where no
  indexed equality could narrow instead. An array-valued key is entered once per element and never trusted
  for a sort.
- **The posting lists** narrow a query no index serves but which holds an equality (or `$in`) on an indexed
  field, before any record is read. The narrowing follows every `$and` branch, and an `$or` whose branches
  all name an indexed equality; a `$not`, a `$nor` or a branch without one is left to the predicate. An
  indexed array field — a set, a list or any array — is posted under each of its elements as well.
- **Covered**: a query whose fields, order and projection are all indexed, with no `filter`, is answered
  from the catalog alone, not one record read.
- **The collection**: everything else reads the candidates — from the cache for the recent ones, from the
  engine otherwise, sixteen at a time — and evaluates the predicate on each. An unordered cursor with a
  `limit` stops at enough matches (its candidates in id order, the result's order); an ordered one keeps
  only the best `offset + limit` rows as the candidates go by.

A `$text` query is the text index's ranking, best first, every equality narrowing that order rather than
replacing it; it plans no index. A record's text is the strings of its `search` fields as it reads (the lens
applied) — a string, the strings of an array, and those of objects down to four levels (a list's elements that
carry fields) — joined by a space. The text index follows the rows lazily: a put or a removal waits, the last per
id, until a `$text` query asks. The text is kept in the catalog's rows and saved with `index/catalog.json`, so a reopen rebuilds the text index with no record read — and the file grows
with it, rewritten whole on OPFS. Changing an entity's `search` fields rebuilds the catalog once, from the
records; an index that throws is logged (`catalog.search`) and the write lands all the same.

### The query cache

Every `watch()` of one query — the same entity, query, order, window, projection and populated fields,
whatever the key order — shares one live run, and a `fetch()` of it reads nothing while the run lasts. After
the run stops its last result stays, as do up to 100 unobserved results holding 10 000 rows between them (a
larger result alone is not kept), the least recently used let go of first, each as current as its collection
was when it was read: a `fetch()` of a query whose collection has not changed since — no record of it
written, folded or purged, the collection not defined again, the catalog not loaded again — reads nothing,
whatever the other collections did meanwhile. A cursor with a `filter(fn)` has no key and runs every time; a
cursor at a tag is never cached. `syncom.query.cache` counts the hits and the misses.

## Versions (subpath)

```js
const { versions } = require('@alexify/syncom/versions');
```

`versions` is the plugin: `createDatabase({ plugins: [versions] })` gives the storage
its past — `get(id, { at })` and `history()` folded from the log, `diff()`
between two versions and `restore()` the way back — and the tags (`tag`,
`untag`, `tags`, `at`), named versions kept on this node, copy-on-write at
the record-file seam (see [Versions and history](../guide/versions)). The
present and its patches — `applyPatches()`, `compact()` — are the core's,
and so is the `commit` event the undo subpath stands on. Without the plugin
those methods throw `PLUGIN_MISSING`, `stats().tags` is `null`, and a
directory that holds tags is refused at `createDatabase()`: its copies would not be
kept. The rules — what a version is, when the log can vouch for one, the tags on disk, the patches, the
`commit` event, undo and branches — are in [Versions and tags](./versions).

## Local (subpath)

`@alexify/syncom/local` — local documents: `createDatabase({ plugins: [local] })` hands the core `db.local`, JSON
values kept in the `local` kv namespace beside the records that never become an op (not logged, not in the
catalog or a snapshot, never at a peer). A key is a kv key (no `/`).

| Member | Notes |
| --- | --- |
| `db.local` | `get(key)` → the value or null (`CORRUPT` for a document that does not parse); `set(key, value)` (JSON; resolves to it) or `set(key, fn)` (what `fn` answers over the value as it is — null for none; `undefined` back leaves it) — the changes of one key go one at a time, so read-modify-writes made at once compose; `delete(key)`; `list()` (the keys, sorted); `observe(key, listener)` → `listener(value)` after every `set`/`delete` of the key in this instance (null once deleted; a listener that throws is contained, `listener.error`), returns the stop; `scoped(prefix)` → the same store under `<prefix>.`. `PLUGIN_MISSING` without the plugin |
| `collection.local` | `db.local.scoped(name)`: keys `<name>.<key>` |
| `local` event | On the database: `({ key, value })` after every write or removal, the full key |
| `toStore(db.local, key)` | A store of the value (`@alexify/syncom/store`) |

## State (subpath)

`@alexify/syncom/state` — persistent app state: `createState(db, name, { local }?)`, one object a node keeps by
name, read and written by path. Over the record `state.<name>` by default — every path a register of its own, so
two nodes that write different paths both keep theirs, and the record replicates like any other — or, with
`{ local: true }`, over the local document `state.<name>` (the `local` plugin's; this node's alone, written whole).

| Member | Notes |
| --- | --- |
| `get(path?)` | The value at the path (`undefined` for none), or the whole object |
| `set(path?, value \| fn)` | Writes the value at the path — or what `fn(current)` answers, run inside a transaction over the record as it is — and resolves to it; `set(object)` replaces the whole state (a `write`). A path set while the record does not exist yet makes it with that one path (a `set`, never a whole-record write), so two nodes making one state at once, or a device writing before its first sync, keep every path either side set; on a record deleted through the database, the path is a `write`, which brings it back |
| `delete(path?)` | Removes the path (an `unset`), or empties the whole state: the record written empty (a `write` of `{}`), no tombstone, so a path set afterwards on any node lands |
| `observe(path?, listener)` | `listener(value)` with the value at the path after every change of it; returns the stop |
| `toStore(state, path?)` | A store of the value at the path, or of the whole object |

## Dump (subpath)

`@alexify/syncom/dump` — a database as JSON and back; a backup, an import from another database, a move between
engines.

| Member | Notes |
| --- | --- |
| `exportJSON(db, { collections, scopes, meta, limit }?)` | `Promise<Dump>` — `{ format: 1, node, schema: { version, hash }, kinds, eventId, vector, meta, records }`: every record a snapshot would hand a peer, live ones and tombstones, each with its meta (`meta: false`: the live records as they read, data alone); `collections` keeps to those, `scopes` to the records in them |
| `exportPages(db, options?)` | The same a page at a time (`limit` records, 500), an async iterator; each record `{ id, data, meta, deleted }` — `deleted` whether its meta reads as dead |
| `importJSON(db, dump, { mode, force, batch }?)` | `merge` (the default) joins the records with their meta as a bootstrap does — one op per record, this node's own; `insert` writes each record's data under its id as a plain write (new ops; a record dead by its meta — or `deleted: true` without one — is deleted, one a whole-record write revived above its tombstone is written alive) and takes a foreign `{ records: [{ id, data }] }` the same way; a dump of another `format` is a `TypeError`; one made under another schema hash rejects with `SCHEMA_MISMATCH` unless `force`. `{ mode, records }` |
| `migrateStorage({ from, to, path, mode, batch }?)` | `copy` (the default; `from`, `to` engines): `copyEngine` — the same node on the new engine, its identity, log and vector; `merge` (`from`, `to` open databases): `from` exported and merged into `to`, a new node that holds what the old one held |

A backup is `JSON.stringify(await exportJSON(db))` to a file and `importJSON(db, JSON.parse(text))` back; a live backup
follows the `transaction` event and exports the records it names. A dump carries no log, no chain and no identity:
a node restored from one by `merge` is a new node holding the same records, which its peers receive as its own
ops. To move a node whole — the same identity, log and vector, so no peer bootstraps — move the engine
(`migrateStorage({ mode: 'copy' })`, `copyEngine`).

## Pipeline (subpath)

`@alexify/syncom/pipeline` — `createPipeline(db, { name, source, handler, leader })`: a handler run over every
change of the `source` collection, once, in order — a derived collection, a counter, an index kept elsewhere.

| Member | Notes |
| --- | --- |
| `handler(batch, tx)` | Per turn of the database that changed a record of the source: `batch` is `{ ids, changes, replay, rebuilt, eventId }` — the records that changed (each once), their changes (null on a replay), the turn's log position — and `tx` the one transaction the handler writes through (the derived writes land whole, or not at all); a throw keeps the error (`errors`, the `error` event) and moves the checkpoint nothing past the turn |
| `start()` | Reads the checkpoint from the `pipeline` kv namespace, replays the turns the log holds since it (their ids, `replay: true`), or — where the log cannot resume from it, or there is none, or it does not parse (`pipeline.checkpoint.unreadable`) — hands every record of the source over once (`rebuilt: true`), then follows the `transaction` events. A replay or a rebuild goes 500 ids a batch, one transaction each, the checkpoint written after the last batch alone (a failure in the middle starts it over); `start()` resolves once those batches are queued, before they are handled — `awaitIdle()` waits for them. A live turn that comes while one is handled joins the one batch waiting (the ids each once, the changes in order, the newer `eventId`) while it holds fewer than 500 ids |
| `stop()`, `idle()`, `awaitIdle()` | Stops following (what is queued waits for the next start); whether nothing is queued or running; a promise of that |
| `checkpoint`, `rebuilt`, `stopped`, `errors` | The log position handled last; whether the last start rebuilt; whether the pipeline follows nothing now (not started, stopped, or a handler that threw — under `leader`, a started pipeline on an instance that follows waits, not stopped); the handler's errors, the newest twenty |
| `leader` (option) | What `openShared()` answers, `db` its instance (`leader.db`; another database, or a handle without `live`/`isLeader`, is a `TypeError`): the pipeline runs on the instance that leads, through `live()` — at `start()` and at every change of instance it follows the leading instance's database from the checkpoint in the shared engine's `pipeline` kv (the next leader resumes where the last left), and lets go of the instance that loses the lead (a batch in flight there may be handed over again by the next; its failure is not `PIPELINE_FAILED`). Without it, on `db` |

A handler that throws stops the pipeline before the turn: the checkpoint stays, the database's `error` event carries
`PIPELINE_FAILED` (`pipeline` — the pipeline's name — `eventId`, `cause`), nothing is handed over meanwhile, and `start()` hands the turn over
again — a turn is handled at least once, never skipped.

The `transaction` event carries `eventId`, the log position of the turn's last op, which is what a pipeline keeps.
A handler's write to the source is another turn, handed over again: derive into another collection.

## Connector (subpath)

`@alexify/syncom/connector` — `replicate(db, { name, collection, pull, push, live, retryTime, maxRetryTime,
safetyTime, batchSize, modifier, resolve, autoStart })`: one collection kept in step with a backend of its own
through two handlers — see the guide's [Connectors](../guide/connectors) page; the options and the rules are
specified in [Connectors](./connectors).

| Member | Notes |
| --- | --- |
| `pull.handler(checkpoint, batchSize)` → `{ documents, checkpoint }` | The backend's documents since the checkpoint (`[{ id, data, deleted }]`) and the position after them; landed as one transaction per page of this node's writes (`source: 'connector:<name>'`), each judged against the backend's state as known: an echo makes no op (over an unpushed edit too), another state over an unpushed edit is a conflict (`resolve`, the `conflict` event), another state otherwise lands; a document the database refuses is not learned: a later edit of it is a conflict, `reSync()` asks for it again |
| `pull.stream(emit, { checkpoint })` → stop | The backend's live changes from the checkpoint: `emit({ documents })` (landed; the checkpoint moves with the pulls alone), `emit('RESYNC')` (pull again), `emit('END')` (followed again after the backoff, pulled); a pull from the checkpoint every `safetyTime` anyway; without a stream a live connector pulls every `retryTime` |
| `push.handler(rows)` → conflicts | The collection's records as the turns change them, `[{ id, data, deleted, assumed }]` — `assumed` the backend's state as this node last knew it (`undefined`: a probe, "tell me what you hold" — answered among the refused as the backend holds it, nothing written); a row that reads as the backend is known to hold it is not pushed; answers the rows refused, each as the backend holds it (a conflict), or `{ id, error }` for one refused by name (parked until a turn of the record or `reSync()`) |
| `resolve({ id, local, remote, deleted })` | What a refused row's record should be: the data to keep (pushed back, the backend's state assumed), `null` to delete; the backend's state otherwise, and when `resolve` throws |
| `start()`, `cancel()`, `reSync()` | Reads the checkpoint, pulls from it, pushes what the log holds since `pushed` (every record once where it cannot resume), then follows; stops for good (the database's `close` does the same); asks the backend again about the documents the database refused, then pulls and pushes again, the parked rows too |
| `awaitInitialReplication({ signal }?)`, `awaitInSync({ signal }?)` | The first pull and push succeeded (a failure keeps it waiting for the retry); nothing waiting to go out and nothing in flight either way |
| `checkpoint`, `active`, `canceled`, `errors`, `stats()` | `{ pull, pushed }` (the kv text `connector/<name>` holds them with `known`, the digest of the backend's state per record, and `refused`, the ids whose state the database refused to land); whether it follows now; stopped for good; the handlers' failures, the newest twenty; the counts (`pulled`, `applied`, `pushed`, `probed`, `conflicts`, `refused`, `pulls`, `pushes`, `pending`, `parked`) |

Events (contained): `received` `({ documents, applied })`, `sent` `({ rows })`, `conflict` `({ id, local, remote,
deleted, resolved })`, `refused` `({ direction, id, reason, cause })` — a document or a row left out by name: on pull
`collection`, `sealed`, `value` (no JSON), `modifier`, or the code of the write the engine refused; on push the
backend's code for a row refused by name (`backend` without one), `modifier`, `answer`, `conflict` (a backend
refusing a row that assumed exactly what it holds, twice), or the code of a resolution the engine refused — `error`
(`REPLICATION_FAILED` with `direction` and `retryIn`), `active` `(boolean)`.

## Shared (subpath)

`@alexify/syncom/shared` — `openShared({ createDatabase, path, engine, …, channel, election, grace, failover })`:
several instances over one database, one leading and the others following and writing through it — see
[Leader election](../guide/leader-election#let-the-leader-own-the-database) and
[SharedWorker](../guide/storage-shared-worker).

| Option | Default | Meaning |
| --- | --- | --- |
| `createDatabase` | — | The constructor of the flavour in use (the core's, `/all`'s): the subpath bundles nothing of the core |
| `path`, `engine`, … | — | What `createDatabase()` takes; the engine must be one several instances may open (`capabilities.shared`: memory, IndexedDB, MongoDB) — the files engine and SQLite refuse a follower with a `TypeError` |
| `election` | `{}` | `{ locks }` — Web Locks: `syncom:leader:<path>` requested exclusive, granted when free, let go with its holder; `{ channel, heartbeat, misses }` — a `BroadcastChannel`-shaped heartbeat: a candidate claims with its token and waits one beat, a leader says `lead` every `heartbeat` ms (1 000), a candidate that hears no leader for `misses` beats (3) and no smaller claim in its round leads, two leaders settle by token (the smaller stays); `{ follower: true }` — never leads (`mode: 'follower'`); none of them — leads as soon as `elect()` returns (`mode: 'alone'`) |
| `channel` | — | `async () => ({ call(method, payload) })` — a follower's way to the leader, called again for a fresh channel after a failure; without it a follower's write is `NOT_LEADER` |
| `grace` | `50` | Milliseconds `openShared()` waits for the grant before it opens as a follower: the first instance leads at once, the next follows without a pause |
| `failover` | `10000` | Milliseconds a follower's write is tried again while no leader answers, then `LEADER_LOST`; on a fresh path, how long a follower waits for the elected instance to write the identity (`LEADER_LOST`, `reason: 'fresh'`) |

The database's own lock is the last word whatever the election: an instance granted leadership opens the
database as the leader and tries `LOCKED` again, 40 times 50 ms apart, while the old holder lets go. Elected
but unable to open — `LOCKED` past those tries, the engine's error — it reports `PROMOTE_FAILED` (`attempt`
counted up per failure in a row, `cause`), yields the election so the next in line leads, and asks again after
50 ms · 2^`attempt`, 5 s at most. A promotion is the same node — the same `nodeId`, log, vector and registry —
so peers see a reconnect; `generation` counts up, and `rebind` and `leader` say so. `close()` closes the
database first and lets the election go last. `openShared()` never resolves with `db` null: a first open that
fails rejects and lets the election go.

A follower's write is a **call** `{ id, args, retry? }`, `id` `'<token>:<n>'` (the follower's election token
and a count, 128 characters at most); the leader answers every call as a value, `{ ok: true, value }` or
`{ ok: false, error }` (the error made again on the follower with its code and fields), so a refusal
round-trips whatever the wire does with a thrown error. A call whose answer was lost goes again under the same
id with `retry: true` and is answered from what the leader kept — in flight or done, never run twice; the
leader keeps the answers of the last 256 calls per follower token and 64 tokens, in memory, per `serve()`. A
transport that knows a request never left says so with `sent: false` on the error it throws: the retry then
goes without the flag. A dial that reached nobody, or a `NOT_LEADER` or `CLOSED` answer from an instance that
follows again or is going, marks nothing sent, so the next try is a new call; concurrent writes waiting on a
channel share one dial. A follower raises no `transaction` event and runs no `observe()`; it reads the engine
beside the leader and hears its writes through the engine's change stream.

The lists are exported: `MUTATORS`, the database's writers a follower forwards — `insert`, `saveData`, `set`,
`update`, `swap`, `unset`, `delete`, `purge`, `forget`, `inc`, `add`, `remove`, `splice`, `push`, `setAt`,
`move`, `mark`, `unmark`, `unmarkById`, `updateText`, `insertEmbed`, `updateBlock`, `treeMove`, `treeRemove`,
`applyPatches`, `restore`, `compact`; `TX_WRITERS`, what a recorded transaction may call (the writers a
transaction's api has, `insert` excepted); `READERS`; `COLLECTION_WRITERS`; and `PROCEDURES`, what `serve()`
mounts — one per entry of `MUTATORS`, then `transact`, `collection`, `local` and `fetchBlob`.

| Member | Notes |
| --- | --- |
| `db` | The current instance: the leader's `Database`, or a follower's read-only one (`CLOSED` after `close()`) |
| `leader`, `isLeader()`, `mode`, `generation`, `token` | Whether this instance leads; how leadership is decided (`'locks'`, `'heartbeat'`, `'follower'` — never this instance — or `'alone'`); how many times the instance changed; the election's token |
| `waitForLeadership({ signal }?)`, `onLeader(fn)` | Resolves when this instance leads (rejects `CLOSED`, or aborted); the `leader` event's listener, with its off |
| `stats()` | `{ leader, generation, mode, forwarded, retried, lost, answered, dials, promotions, demotions, yields }` — the calls carried to a leader and answered, tried again, lost (`LEADER_LOST`); on a leader the retries answered from what it kept; the channels dialed; the changes of role (promoted at a failover, demoted, yielded under `PROMOTE_FAILED`) |
| `get`, `has`, `hasRecord`, `list`, `getCachedData` | The current instance's readers; everything else is `db`'s |
| `collection(name)` → `SharedCollection` | Its readers (`get`, `select`, `count`, `findByIds`, `distinct`, `countBy`, `document`) the current instance's collection's; its writers (`insert`, `upsert`, `insertIfAbsent` → the id on either role; `set`, `update`, `unset`, `delete`; `bulkInsert`/`bulkUpsert`/`bulkRemove` → `{ success, error }` with the errors made again) the leader's, forwarded from a follower; `modify()` and `remove()` are `NOT_LEADER` (with a `hint`) on a follower; `collection` the instance's own |
| `attachments` | `put(id, name, bytes, { type })` from either role — the blob into the shared store (content-addressed, outside the write set), the register through the leader; `get(id, name, { fetch })` reads this instance's store and asks the leader to fetch what it lacks (`fetchBlob`, the bytes landing in the shared store); `has`, `list`; `remove` a forwarded `unset`; `sweep()` the leader's (`READ_ONLY` on a follower); `PLUGIN_MISSING` without the plugin |
| `local` | `get`, `list`, `scoped(prefix)` this instance's; `set(key, value)` and `delete(key)` the leader's, forwarded as the full key; `set(key, fn)` is a `TypeError` on either role; no `observe` |
| `insert`, `set`, `update`, `delete`, … every writer of the database's API | The leader's own writes; a follower's carried over the channel as a call `{ id: '<token>:<n>', args, retry }` and answered as the leader answers them (an error made again with its code and fields), tried again — the same id, `retry` once it may have reached a leader — while a leader comes within `failover` ms, then `LEADER_LOST` (`maybeApplied`); the leader answers a retry from the answer it kept, never running a call twice, and one it never saw is `LEADER_LOST` with `maybeApplied: true`; `NOT_LEADER` on a follower without a channel |
| `transact(fn, options?)` | The leader's transaction; on a follower a recorded one — the writers noted and carried whole (no `insert`, no read of its own writes); typed as `SharedTransaction`, the api both roles have |
| `live(make)` | `make(db)` subscribes over the current instance and answers what stops it; run again over the next; answers the stop for good |
| `document(id)` | A `SharedDocument`: `data()`, `document` (the instance's), the `update` event — and once after a failover (delta `null`); `close()` |
| `sync` | The leader's `SyncManager`; `NOT_LEADER` on a follower |
| `serve({ access }?)` | The procedures a leader mounts for its followers (`defineRouter({ 'syncom-db': shared.serve() })`) — `PROCEDURES`: every writer, `transact`, `collection` (`[name, method, args]`), `local` (`[method, args]`) and `fetchBlob` (`[digest, id, name]`) — each taking a call `{ id, args, retry? }` and answering `{ ok, value }` or `{ ok, error }` — a call tried again from the answer kept (256 per follower, 64 followers), one never seen `CALL_UNKNOWN`; `access` is wrpc's, `'session'` by default; `NOT_LEADER` on a follower |
| `close()` | The live things stopped, the leadership waiters rejected, the channel closed, a promotion in flight waited for, the instance closed — and the election let go of last |

Events (contained): `leader`, `follower`, `rebind` `({ path, generation })`, `error` (the instance's, and `PROMOTE_FAILED` when the
elected instance could not open as the leader: it yields and asks again). `elect({ name, locks, channel, follower, heartbeat, misses })`
is the election on its own, re-armable: `{ leader, token, mode, onLead(fn) → off, onLost(fn) → off, yield(), request(), release() }` —
`onLead` at every grant, the first included: the lock is asked for a microtask after `elect()` returns (`alone` leads then too), so
`leader` is `false` on return and a listener attached in the same tick hears the first grant; a `yield()` or `release()` in that tick asks nothing.
`createSharedChannel(client, { unit }?)` of `@alexify/syncom/wrpc` is the follower's channel over a `WrpcClient`.

## Attachments (subpath)

`@alexify/syncom/attachments` — `attachments({ compression })`, a plugin: `db.attachments`, bytes beside a record
in the engine's blobs store, named on it as the register `_attachments/<name>` — see [Attachments](../guide/attachments).

| Member | Notes |
| --- | --- |
| `put(id, name, bytes, { type }?)` → `{ digest, type, length, encoding? }` | The bytes (a `Uint8Array`, an `ArrayBuffer`, a string as UTF-8) kept under their SHA-256 — compressed where the plugin was told to — and named on the record (an `update`); `NOT_FOUND` for a record that is not there; a name is up to 128 letters, digits, `.`, `_`, `@`, `-` |
| `get(id, name, { fetch }?)` → `{ bytes, type, length, digest, encoding? }` or null | The attachment named; bytes this node lacks are asked of the connected peers (`syncom/blob`), checked by digest and kept once (by `sync.fetchBlob`; a store that refuses them is a `sync.blob.keep.failed` warning, the bytes answered all the same) — `fetch: false` asks nobody; none has them, `BLOB_NOT_FOUND`; bytes that are not what the register says, `BLOB_MISMATCH` (a length, or an inflating past `length`, stopped there) |
| `has(id, name)`, `list(id)` | Whether this node holds the bytes; the record's attachments by name — a register that is no register (a peer's) is `ATTACHMENT_INVALID` from `get`/`has`, left out of `list` with a warning |
| `prepare(name, bytes, { type }?)` → `{ stored, entry, field }`, `field(name)` | What a `put` would store and write, without storing or writing — what a follower of `@alexify/syncom/shared` puts into the shared store itself; the register's field name |
| `remove(id, name)` | The name off the record (an `unset`, replicated); the bytes stay in the store until a `sweep()` |
| `sweep({ dryRun, tags }?)` → `{ blobs, marked, removed, pending }` | Mark-and-sweep over the blobs store: every digest a live record's register names, a tag's copy names (`tags`, on by default; the pending copies among them) or a put in flight holds is kept, every other blob removed — `dryRun` counts alone; the log is not marked (a register restored names bytes a peer may hold, fetched on the read); `READ_ONLY` on a follower, `CLOSED` after close; one `attachments.sweep` info line |
| `stats()` | `{ puts, gets, fetched, mismatches, missing, sweeps, pending }` — the puts, the gets whose bytes read whole, the gets that fetched from a peer, the mismatches (`BLOB_MISMATCH`), the misses (`BLOB_NOT_FOUND`), the sweeps, the puts in flight |

A node that pushes a register uploads the bytes it holds to the host that took the push (`syncom/blobPut`), and a hub uploads on what it receives, so a node behind a hub reads them there; a host that does not take them is `BLOB_UPLOAD_FAILED` on the manager's `error` event, never a failed push. What still has to go up is saved with the database (`uploads.json`, 1 024 attachments a host) and uploaded at the next hello, a restart's included. Both ways the bytes cross as a stream of the transport's in 64 KiB chunks where the link carries one ([`blobPut`](./wire#blobput), [`blob`](./wire#blob)), and as base64 in one call over a text-only link. `FIELD` is `'_attachments'`. The engine must have a blobs store (`capabilities.blobs`); the plugin is refused at
`createDatabase()` otherwise. `db.sync.fetchBlob(digest, { id, name })` is the same fetch by hand: the record and the name the host serves the digest for (by digest alone only from a host with `allow.blob: 'any'`).

## Testing (subpath)

`@alexify/syncom/testing` — what a test over syncom stands on, and what this repository's suite runs on — see
[Testing](../guide/testing).

| Member | Notes |
| --- | --- |
| `memoryEngine()` | The memory engine of `@alexify/syncom/memory`: one engine, a database per path, nothing on disk |
| `createMesh(names, edges, { createStorage, link, sync, nodes, unit, scopes })` → `Promise<Mesh>` | A database per name through `createStorage(name, options)` (`options` carries `sync.connect` to the mesh's links and `autoStart: false`), each hosting `sync.unit(unit)` (public by default), every edge `['A', 'B']` an `addNode('mem://B')` of A with `scopes[A]`, every manager started; `link` is every link's hazards |
| `Mesh` — `storages`, `links`, `units`, `servers`, `connect(node)`, `get(name)`, `close()` | The databases by name; the links by the url dialed (two dialers of one host: the last one — the host's `servers.get(name).links` has every one); the units; every database closed |
| `MemoryLink(unit, { latency, drop, duplicate, streams, maxMessage, server })` | An in-process `SyncLink` over a host's unit: JSON across the boundary, `changes` driven as an async generator, `disconnect()` (calls fail, feeds stop, `close` announced) and `reconnect({ freshClient })` (every subscription re-opened from the last event id it delivered, `reconnect` announced — wrpc's restore); `drop(page)` answering true takes the link down with that page, as a socket that died (`disconnect()`: nothing after it is delivered until `reconnect()`, which hands it over again), `duplicate(page)` delivers it twice; `streams: true` makes it a binary transport — `link.createStream`/`link.stream` and the host's `client.createStream`/`client.getStream`, wrpc 2.1's binary streams in process (a writer paced by `drain`, `writeAll`, a reader's `terminate()` that stops its writer, every stream closed with the socket), so a snapshot page and an attachment's bytes cross as chunks instead of inline and as base64; `maxMessage` (bytes) takes the link down for a call or a chunk past it, as a socket closed for a message too big; a call the socket went under fails (503) whatever the host answered; `calls` and `sent` record what crossed |
| `settle(storages, { timeout, step })` | Resolves once every vector is equal and nothing is in flight (no queue holds a turn, no peer has a page pending), three polls in a row; rejects past `timeout` (5000 ms) |
| `waitUntil(predicate, { timeout, step })`, `sameVectors(storages)`, `prng(seed)` | A poll until `predicate()` is true; whether every vector is the same; deterministic numbers in [0, 1) for a seeded run |
| `withDatabase(open, fn)` | A database — or what opens one — for `fn`, closed after it whatever `fn` does; `fn`'s answer |

A timeout of `settle()` or `waitUntil()` is a plain `Error` (a test's failure, not a condition a program handles).

## Agent tools (subpath)

`@alexify/syncom/mcp` — `createTools(db, { collections, tools, readOnly, limit, sealed, regex })`: the tools an agent calls
over a database, in the Model Context Protocol's shape — see [Agent tools](../guide/mcp).

| Member | Notes |
| --- | --- |
| `createTools(db, options?)` → `AgentTool[]` | A set per collection (every one of `db.collections`, or `collections` by name): `<Collection>_query`, `_count`, `_get`, `_changes`, `_wait_changes`, and `_insert`, `_upsert`, `_delete` unless `readOnly` (`tools` names the verbs to make); `limit` caps a query's window and a `changes` page (1000 by default and at most); the collections' sealed records left out of `_query`, `_count` and `_get` unless `sealed`; `$regex` refused unless `regex`; a TypeError for a name that is no collection or a verb that is none |
| `tool.name`, `tool.description`, `tool.inputSchema`, `tool.annotations` | The definition as `tools/list` answers it — `inputSchema` is JSON Schema, every object closed (`additionalProperties: false`); `annotations` the protocol's hints: `title`, `readOnlyHint` and `idempotentHint` (the readers), `destructiveHint` (`upsert`, `delete`), `openWorldHint` false |
| `tool.execute(args?)` → `Promise<json>` | `checkArgs(inputSchema, args)` first — a wrong type, a member not named as the schema's own (`constructor`, `__proto__` are none), a required one missing, a window past the cap is a `TypeError` naming the member; a `$regex` in a query the same unless `regex` — then the collection's call; its own refusals (`NOT_FOUND`, a validator's, `PLUGIN_MISSING` without the query plugin) come through as they are |
| `_query { query, order, limit, offset }` → `{ rows }` | A Mango query over the collection, `order` the fields (`'-field'` descending), `limit` (100 by default) and `offset` |
| `_count { query }` → `{ count }`; `_get { id }` → `{ record }` | How many match; one record by id, or null |
| `_changes { since?, limit? }` → `{ eventId, changes, more }` | Without `since`: the `eventId` to start from. With one: the collection's records the log touched since, an id once with `deleted`, at most `limit` of them, the `eventId` to ask from next and `more` while the log holds more; `changes: null` where the log cannot resume there (another epoch, a position compacted away) — list again then |
| `_wait_changes { since, limit?, timeout? }` → the same | What `_changes` answers once there is a change after `since`, or at `timeout` ms (30 000 by default, 120 000 at most) with none |
| `_insert { data }` → `{ id }`; `_upsert { id?, data }` → `{ id }`; `_delete { id }` → `{ id, deleted }` | A new record; a record written whole under `id` or the id its data names; a delete — `deleted: false` where there is none (no tombstone written), `NOT_FOUND` for a record of another collection |
| `checkArgs(schema, args)`, `MAX_LIMIT` | The check on its own; 1000 |

## Cleanup (subpath)

`@alexify/syncom/cleanup` — `cleanup(db, { minimumDeletedTime, runEach, awaitSync, leader, now }?)`: a deleted record
keeps a tombstone (its file, with the stamps that keep it dead); a sweep folds an old one whole — its collection, the
data the delete carried, its meta — into the `tombstones` kv namespace and removes the file and its pieces in ONE
write set. The catalog row stays (a tombstone's row keeps its collection and its `deleted` stamp); a read of the id
finds the tombstone in the namespace.

| Member | Notes |
| --- | --- |
| `run({ drop }?)` | One sweep: every tombstone deleted `minimumDeletedTime` (31 days) ago or more by its row's stamp — and, with `awaitSync` (true), one whose delete this node made only once every enabled registered node acknowledged it (a peer's delete is theirs to deliver; an own delete the log no longer retains folds but is never dropped) — folded, a hundred a turn of the queue; `drop: true` takes the kv entries and the rows too (a late op then makes a new record, a peer that never saw the deletion keeps its copy). `Promise<{ folded, dropped, skipped }>` |
| `start()`, `stop()` | A sweep every `runEach` ms (5 minutes) until `stop()` or the database closes; a failed sweep is logged (`cleanup.failed`) |
| `stats` | The counts over every run |
| `leader` (option) | What `openShared()` answers, `db` its instance (`leader.db`; another database, or a handle without `live`/`isLeader`, is a `TypeError`): `run()` sweeps the leading instance's database where this instance leads and nothing elsewhere (`{ folded: 0, dropped: 0, skipped: 0 }`, no run counted); `start()`'s timer runs while this instance leads, armed again through `live()` on the instance a failover makes the leader. Without it, on `db` |

A folded tombstone still wins: a peer's op stamped below it is moot (below an unset or a set removal above the delete
too; one of a field above it lands unseen), a revival by a whole-record write above it writes a file again and takes the kv entry away in the same write set, a snapshot page hands
the tombstone on whole, and a rebuild of the catalog reads the namespace beside the records.

## Telemetry (subpath)

```js
const { telemetry, createTelemetry } = require('@alexify/syncom/telemetry');
```

`telemetry` is the plugin: `createDatabase({ plugins: [telemetry], telemetry })` adapts
`{ api }` (the `@opentelemetry/api` module) or `{ tracer, meter }` into the
writer the engine records through (see [OpenTelemetry](../guide/telemetry)).
`createTelemetry(options)` builds that writer by hand — for an `OpLog` opened
on its own, or to give `createDatabase({ telemetry })` as it is, which the core takes
without the plugin (duck-typed: `enabled`, `withSpan`); nothing usable is the
frozen disabled writer, whose `withSpan` still runs its callback. Without the
plugin an api or a tracer given to `createDatabase()` is `PLUGIN_MISSING`.

## Engines and backends

An **engine** (`Engine`) is a factory of databases: `name`, `capabilities`
(`EngineCapabilities`: `atomicBatch`, `indexes`, `changeStream`,
`exclusiveCreate`, `lock`, `shared`, `blobs`, `append`), `open(path, { logger,
durable }?)` → `EngineDb` and `remove(path)`. An `EngineDb` is a set of stores —
`kv` (`get/has/list/put/remove`, `create?` by namespace and key), `records`
(`get/raw/has/getMany/ids`), `pieces` (`get/remove`), `copies`
(`get/has/ids/put/remove/drop`), `log` (the op log's medium), `write(batch)` one
write set (`EngineWriteSet`: records with their `row` and pieces, kv puts and
removals, copies) and `close()`. `isEngine(value)` is the contract check;
`filesEngine(fsi)` the engine every backend becomes — what `createDatabase({ fsi })`
builds, today's layout byte for byte. `createDatabase({ engine })` opens through an
engine; with `fsi` as well it is a `TypeError`. `storage.engine` is the engine,
`storage.fsi` the files engine's backend (`null` under a native engine). The
contract as a test is `tests/suites/engine.js`.

A backend — an **fsi** — is five functions over "a directory and a file name":
`read(dir, file)` → `Promise<string>`, `write(dir, file, content, options?)`
(`options.mode` is a permissions hint the `node:fs` adapter honours),
`exists(dir, file)` → `Promise<boolean>`, `remove(dir, file)`,
`list(dir)` → `Promise<string[]>` (file names, sorted; an absent directory is
empty). `write` creates the directory; `remove` is a no-op when the file is
absent. An optional `sync(dir, file)` is fsync.

The package root exports the platform's own — `node:fs/promises` on the
server, OPFS in the browser — as those five functions, and:

| Export | Notes |
| --- | --- |
| `defaultFsi` | The platform's backend whole, frozen: on the server the five functions and the three optional ones (`sync`, `create`, `append`), in the browser OPFS's five — what a backend built by hand starts from (`{ ...defaultFsi, sync: spy }`, `atRest(defaultFsi, …)`, `layered([…, defaultFsi])`) without losing fsync, the exclusive create or the journal's append. Not the three by name: `sync` is the replication plugin's name in `/all` and `/sync` |
| `createDatabase({ fsi })` | Any object with the five functions, as `filesEngine(fsi)`; the storage, its log, chain, keys and registry all go through it. `storage.fsi` is what was given (wrapped when `durable`) |
| `createDatabase({ durable: true })` | Every write is followed by the backend's `sync`, by the files engine at `open()` — the one the database builds and one built by hand (`engine: filesEngine(fsi)`) alike; a backend without one (OPFS, memory, the five functions alone) logs `durable.noop` at debug |
| `create(dir, file, content)` *(optional)* | Exclusive create (`EEXIST` when the file is there) — `node:fs` and the memory backend have it; the directory lock uses it to make a race deterministic |
| `isFsi(value)` | Whether `value` has the five functions |
| `memory()` (`@alexify/syncom/memory`) | A backend in memory: `size`, `dump()`, the exclusive `create`; two storages opened over one share it |
| `memoryEngine()` (`@alexify/syncom/memory`) | The engine in memory (`MemoryEngine`): records as the objects given, the log as rows, the catalog's rows as they are; `paths`; a path outlives its instance until `remove(path)` — see [Memory engine](./engines#memory-engine) |
| `sqliteEngine({ file, database, driver, durable }?)` (`@alexify/syncom/sqlite`) | The engine over SQLite (`SqliteEngine`: `file`, `close()`, `destroy()`), Node only: eight tables keyed by the database's path in one file (`:memory:` by default), `node:sqlite` required inside the factory or a driver with `exec` and `prepare` → `{ run, get, all }` (`SqliteDriver`, `SqliteDatabase`, `SqliteStatement`; answers may be promises); one transaction per write set and per log group — see [SQLite engine](./engines#sqlite-engine) |
| `mongoSharedLog({ client, db, name, collection, changes, poll, gapTimeout, retention: { maxEntries, topics }, logger })` (`@alexify/syncom/mongodb`) | A [shared log](../guide/server-scaling#serve-every-hub-from-one-log) over MongoDB (`MongoSharedLog`: `append`, `read`, `parseId`, `trim(topic, keep)`, `trimBefore(topic, id)`, `head(topic)`, `close()`), Node only, the driver's client injected: a topic's entries in `collection` (`'shared'`), numbered by its head document in `<collection>_heads` with one `findOneAndUpdate`, ids `<epoch>.<n>`; a read is a range by number (the head read once a page) then a tail woken by a change stream (`changes`; no poll then) or polled every `poll` ms; a number handed out whose entry never comes is waited for `gapTimeout` ms, read once more, then yielded as a hole (`value: null`) the hub tells — never skipped in silence; an insert that failed or took longer than `gapTimeout` leaves a tombstone readers pass (the slow one appended again under a fresh number); `retention.maxEntries` trims the topics `topics` names (every one without the list) on every 64th append |
| `mongoEngine({ client, db, name, transactions, changes })` (`@alexify/syncom/mongodb`) | The engine over MongoDB (`MongoEngine`: `database`, `close()`, `destroy()`), Node only, the driver's client injected (`MongoLikeClient`, `MongoLikeDb`): eight collections keyed by the database's path and `locks`, a lease document per path, a bulk write per collection per write set — one session transaction under `transactions: true` — and change streams as `db.changes` — see [MongoDB engine](./engines#mongodb-engine) |
| `serveEngine(engine, port, { allow })`, `remoteEngine(port, { name, capabilities, timeout })`, `connectEngine(port, { timeout })` (`@alexify/syncom/engines`) | An engine answered over a message port (a worker thread, a Web Worker, a SharedWorker) and the same engine on the other side — every call a message, errors with their codes, a change stream and a lease's loss pushed back; `connectEngine` asks the served side what it is. A port is a web `MessagePort` (`addEventListener`, `start()`) or a Node.js one (`on('message')` handing the data); Electron's `MessagePortMain` hands its listeners an event and is neither, so it goes through a few-line adapter (see [Electron](../guide/electron)) — see [An engine over a port](./engines#an-engine-over-a-port) |
| `copyEngine(from, to, { path, targetPath, batch })` (`@alexify/syncom/engines`) | The database at `path` copied between engines (to `targetPath` there, `path` by default; never onto itself) — records with their pieces, a tag's copies, every kv text (not `lock.json`, `copy.json` or `moved.json`), the attachments' blobs, the op log with its index — so the node opens on the new engine as itself and no peer bootstraps; both databases closed and held for the copy, the target empty (`TARGET_NOT_EMPTY`; one marked `copy.json` without an identity is a copy cut short, taken away first) and keeping blobs where the source holds some (`BLOBS_UNSUPPORTED`); the target carries `copy.json` while the copy runs; answers `{ records, pieces, copies, kv, entries, blobs }` — see [Copying a database between engines](./engines#copying-a-database-between-engines) |
| `layered(layers, { write, fill, queue }?)` (`@alexify/syncom/layered`) | One backend over several: a read is the first hit top down, filled upward; a write lands on every layer in order — `'through'` (default) or `'back'` from a queue the top answers ahead of; `flush()`, `close()`, `pending`, `layers`; `create` is exclusive across the layers — see [Layers](./engines#layers) |
| `new OpLog(base, { fsi \| store })`, `loadKeys(base, { fsi \| kv })` (`/encryption`), `loadSigningKeys(base, { fsi \| kv })` (`/signing`), `new Blockchain(base, { fsi \| kv })` (`/chain`) | The pieces take the backend too — or a store of an engine's database: the log's `store` (`db.log`), a `kv` (the `keys` and `blockchain` namespaces) |
| `atRest(fsi \| engine, options)` (`/encryption`) | A wrapper: every file of a backend — or every value of an engine's stores (records, pieces, copies, kv, the log's entries and index; `indexes` off) — is ciphertext under one key, bound to its place — see [Encryption](#encryption-subpath) |
| `rotateAtRest(engine \| { fsi, filesEngine }, { path, from, to, into, batch })` (`/encryption`) | The at-rest key rotated by a copy: the database at `path` sealed under `from` copied whole into `into` (`{ path }`, `{ engine }`, `{ fsi }`, or a path with either) sealed under `to` — the same node; over a backend (the files engine, wrapped at its backend) with the files engine's factory given; never in place (a TypeError); the source is then fenced — `moved.json`, `MOVED` at `createDatabase()` until `dropDatabase()`; a copy cut short marks its target (`copy.json`) and the next copy takes it away first; answers what `copyEngine` answers — see [Encryption at rest](../guide/encryption) |

`@alexify/syncom/idb` is IndexedDB as a backend and as an engine: `createIdbFsi({ name, store,
indexedDB }?)` returns an fsi over one object store, with a `close()` of its
own; `idbEngine({ name, indexedDB, IDBKeyRange, durability, channel }?)` the engine over
seven object stores (`IdbEngine`: `close()`, `destroy()`), one transaction per write set, a
`BroadcastChannel` for another tab's writes (see [IndexedDB engine](./engines#indexeddb-engine)).
The contract, every store and every shipped engine are specified in [Engines and backends](./engines).

## Plugins

### `createPlugins(modules)`

The registry one `createDatabase({ plugins })` builds, frozen: `names`, `rank` (every
kind's place in the precedence — register 0, counter 1, set 2, then the
plugins' kinds) and what the core calls per module. A module that gets
something wrong — a rank below 3 or taken, a block code or an op type claimed
twice, a type the protocol has not, a `requires` not registered before it —
is a `TypeError` naming it. `storage.plugins` lists the names a storage runs
with, `storage.kinds` the kind plugins among them (what `hello` carries).

A kind the storage was not opened with: a method, a patch action or a local
op of it is a `TypeError` with `code: 'PLUGIN_MISSING'` naming the subpath; a
peer's op of it is refused as `reason: 'kind'` — logged and relayed, so a hub
without the plugin still carries it; a snapshot block of it is left out
(`sync.record.kind`); a reopen of a directory that ran with it is refused the
same way (`node.json` names the kinds); and the node does not bootstrap from a
host that lacks one of its own (`KINDS_MISMATCH`).

A plugin that is not a kind sets the core up before the log opens — the
identity (`signing`), the sealing of records (`encryption`), the chain
(`chain`), the definitions of `schema`, the writer of `telemetry`, the
cursor of `query`, the tags of `versions`, the stores of `local` and `attachments` — through `setup(ctx)`, where `ctx`
carries `db` (the engine's database: its `kv` namespaces, `copies`), `fsi`
(the files engine's backend, `null` under a native engine), `path`, `logger`,
`options`, `settings`, `storage`, `hash` and `catalogOf(name)` — or once it is
open (the manager of `sync`, whose `open(ctx)` has `db` too), and what the options ask for and no plugin provides is refused at
`createDatabase()` the same way: `sync.signatures: 'require'` without `signing`,
`chain: true` without `chain`, `encrypted: true` without `encryption` (and a
per-call `{ encrypted: true }` at the call), `schema` or `validator` without
`schema`, an OpenTelemetry api or tracer without `telemetry`, a directory
that holds tags without `versions`. Without them the node id is what
`getId` mints, ops go unsigned and unchecked, no block is written,
`validate()` is `NO_CHAIN` and `storage.sync` is `PLUGIN_MISSING`.
`storage.plugins` lists them all.

A plugin's `methods` (`{ name: (core, …args) }`) are the storage's: the
shipped ones through the facade's own methods, an application's plugin's
installed at `createDatabase()` — `storage.greet(id, word)` calls `greet(core, id,
word)` — and a transaction's alike (`tx.greet(…)`, inside it). A method named
like a member of the storage, or `then`, is a `TypeError` at `createDatabase()`.

## All (subpath)

```js
const { createDatabase, Database, applyOp, mergeEntry, text, tree, signing, chain, encryption, sync, schema, telemetry, query, versions, local, PLUGINS } = require('@alexify/syncom/all');
```

Everything the root and the `/signing`, `/chain`, `/encryption` and `/sync` subpaths export, `memory` and
`memoryEngine` (`/memory`), `layered` (`/layered`), `createTelemetry` (`/telemetry`), plus
`createDatabase()`/`Database` with the eleven shipped plugins registered ahead of the caller's (`text`,
`tree`, `signing`, `chain`, `encryption`, `sync`, `schema`, `telemetry`, `query`, `versions`, `local`, in
that order; a plugin given twice is given once), `applyOp`/`mergeEntry` folding under the same registry, the
plugins themselves and `PLUGINS`, the list. `matches` stays on `/query`, and `attachments` — a plugin made
with its options, refused over an engine without blobs — is not among them. The API of the package before it
was taken apart into blocks: what the tests and the examples open.

## Text (subpath)

```js
const { text } = require('@alexify/syncom/text');
const storage = await createDatabase({ plugins: [text] });
```

The `list` and `text` kinds: the sequence engine (Fugue runs, run-length
content, marks, cursors) and the methods it adds — `splice`, `push`,
`updateText`, `mark`, `unmark`, `unmarkById`, `spans`, `cursor`, `index`,
`setAt`, `move`, the embeds and blocks, `openText()`, `toDelta()`/`applyDelta()`
(see [Lists](../guide/lists) and [Text](../guide/text)). Patches of `splice` and `mark`, `migrate()` of the
two kinds and `compact()`'s marks are its too. The merge rules, the bounds and what travels are in
[Lists, text and trees](./text).

## Tree (subpath)

```js
const { tree } = require('@alexify/syncom/tree');
const storage = await createDatabase({ plugins: [tree] });
```

The `tree` kind: a movable tree per field and `treeMove`, `treeRemove`; the
`treeMove`/`treeRemove` patches and `migrate()` of trees (see [Trees](../guide/trees); the rules in
[Trees](./text#trees)).

## Order (subpath)

```js
import { between, spread, compare, isKey } from '@alexify/syncom/order';
```

Fractional indexes: strings that sort with `<`, with room between any two.
Keep one in a register field (`position`) and `order('position')` the
records — tasks in a column, blocks of a document. Adapted from Loro's
fractional index (see THIRD_PARTY_NOTICES.md); off the main entry, about 1 KB
min+gzip. The core uses the same module for a tree's places.

| Function | Returns | Notes |
| --- | --- | --- |
| `between(lower?, upper?, { jitter }?)` | `string` | A key between the two; `null`/`undefined` leaves a side open; `jitter` appends that many random digits so two nodes inserting between the same keys at once rarely mint the same one; `RangeError` for bounds out of order |
| `spread(lower, upper, n, options?)` | `string[]` | `n` increasing keys between the bounds |
| `compare(a, b)` | `-1 \| 0 \| 1` | What `a < b` says |
| `isKey(key)` | `boolean` | A well-formed key |

## Undo (subpath)

```js
import { createUndo, UndoManager } from '@alexify/syncom/undo';
```

An undo stack over one node's own writes, fed by the storage's `commit`
event and applied through `applyPatches()` — see [Undo and redo](../guide/undo); the rules in
[Undo](./versions#undo). Off the main entry; its patch
vocabulary, Myers and Emitter are the core's. `UndoManager` is the class
`createUndo()` builds, exported too.

| Member | Notes |
| --- | --- |
| `createUndo(storage, { mergeInterval = 500, limit = 100, scope, exclude, actor, trackedSources, records, paths, onPush, onPop }?)` | `UndoManager` — commits within `mergeInterval` ms of a step's first make one step (a [transaction](../guide/database#make-several-writes-atomic)'s commits one whatever the interval), `limit` steps are kept, `scope` keeps to one scope's ops (`'*'` the global one), `exclude(op)` leaves ops out, `actor` is who the undo's ops say made them; `trackedSources` keeps to commits whose `source` (a transaction's, a `Document`'s save) is one of them, `records` to these ids (or a predicate on the id), `paths` to these fields and what hangs under them (a step's inverse keeps to them; a whole-record change is then not tracked); `onPush`/`onPop` are the `push`/`pop` listeners; holds the log from its oldest step (`log.pins`); stops itself on `close()`; a wrong option is a `TypeError` |
| `undo({ force }?)`, `redo({ force }?)` | `Promise<{ applied, skipped }>` — the newest step taken back (done again) as new ops; a field anyone else changed since is left alone and counted in `skipped`, a whole-record step with such a conflict is skipped whole, unless `force` |
| `canUndo`, `canRedo`, `size` | `boolean`, `boolean`, `{ undo, redo }` |
| `mark()` | Closes the current step: the next commit starts a new one |
| `group(fn)`, `groupStart()`, `groupEnd()` | Everything committed while `fn` runs — or between `groupStart()` and the outermost `groupEnd()` — is one step, whatever the interval; `group()` resolves to what `fn` returned |
| `steps` | `{ undo, redo }` — the steps each way, newest last, `{ id, meta, records, at, source, message, txn }` each: `meta` the application's object, the same on every event of the step, carried to its redo step and back (a selection kept as cursor tokens, restored through `position()`) |
| `clear()`, `stop()` | Drops the stacks; `stop()` also stops listening and lets the log compact |
| `on('push' \| 'pop' \| 'change', fn)` | An `Emitter`: `push` `({ direction: 'undo', records, step })` a step began or grew; `pop` `({ direction, applied, skipped, step })` a step was undone or redone (`step` the one taken back or done again, its `meta` to read); `change` `()` after anything that moved the stacks — those two, `clear()`, a purge forgetting its record |

## Presence (subpath)

`@alexify/syncom/presence` — who is here and what they are doing, per node, never logged. See [Presence](../guide/presence).

| Member | Notes |
| --- | --- |
| `createPresence(storage, { scope = '*', timeout = 30000 }?)` | `Presence` — an `Emitter` holding this node's state and the states it heard of, for one sync `scope`; a state lives `timeout` ms without a renewal (this node's renews itself); signed with the node's key when the [signing](#signing-subpath) plugin is registered; a wrong option is a `TypeError` |
| `set(state)`, `delete()` | `Promise<PresenceUpdate>` — this node's state (a JSON object of at most 64 keys, 8 deep, 16 KiB as JSON; `PRESENCE_SIZE` otherwise), newer by this node's clock, announced as an `update` event; `delete()` leaves (a null state) |
| `local`, `get(node)`, `states()`, `nodes()` | This node's state or null; a node's state or undefined; every state by node (`Map`); the nodes with a state |
| `encode(nodes?)` | `PresenceUpdate` — `{ p: 1, scope, s: [[node, clock, ts, state, sig?]] }` of every state known here, for a newcomer; `nodes` narrows it |
| `apply(update, { from }?)` | `Promise<{ applied, stale, forged, unsigned, refused }>` — takes what a transport brought: per node the newest by clock, a state older than the timeout is stale, a signature that does not verify is forged, an unsigned state under `sync.signatures: 'require'` is refused, a malformed or oversized entry too; with `from`, every entry must be that node's; another scope's update and this node's own entries are ignored |
| `destroy()` | `Promise<void>` — leaves (a last `update` with a null state), clears the timers, forgets every state |
| `on('change' \| 'update' \| 'refused', fn)` | `change` `({ added, updated, removed })` the nodes whose state came, changed, went (an expiry included); `update` `(update)` this node's state to send — what `storage.sync.presence(instance)` carries; `refused` `({ from, forged, unsigned, refused })` an update `apply()` refused entries of (a listener that throws is logged as `listener.error`) |

## Inspect (subpath)

`@alexify/syncom/inspect` — a record's anatomy and an anonymized copy. See [Devtools](../guide/devtools).

| Member | Notes |
| --- | --- |
| `inspect(storage, id)` | `Promise<Inspection>` — `{ id, present, encrypted, alive, data, reading, base, deleted, purged, v, fields, log }`: the data in the op model's terms and the composed reading (lens and hooks aside), the reset stamps, every field with its `kind`, whether it is `reachable` in the reading and the kind's counts and stamps (a register's `stamp`, a counter's `sums`, a set's `elements`/`live`, a block's `runs`/`cuts`/`ext`/`pos`/`vals`/`marks` or `nodes`/`moves`), and the record's retained log entries (`seq`, `eventId`, `type`, `origin`, `stream`, `ts`, `scope`, `field`, `actor`, `message`, `signed`, `skipped`, `scrubbed`); nothing written; `INVALID_ID` for an id that is none |
| `indexAdvisor(db)` | `{ suggest(), stop() }` — watches every plan the database's cursors make from here on; `suggest()` is `[{ entity, index, queries }]`, most asked for first: the key — the query's equalities, a range field, the sort's fields — that would serve the queries no index served (`scan` other than `index`) or sorted (`sortedByIndex` false), as a copy; a plan well served asks for nothing; `stop()` takes the watch off |
| `anonymize(value, { salt, keys = true }?)` | A copy of any JSON value with every string — and every key unless `keys: false` — replaced by a stable hash of it under `salt` (`~` and sixteen hex digits, two xxHash32; the same string reads the same throughout; a fresh random salt when none is given); numbers, booleans and nulls as they are. Pseudonymous, not anonymous: the shape, lengths and numbers stay, and a guessable string is found again by whoever holds the salt. A value JSON cannot carry is a `TypeError` |

## Editor (subpath)

`@alexify/syncom/editor` — the editor-agnostic binding every editor adapter
builds on. See [Editors](../guide/editors).

| Member | Notes |
| --- | --- |
| `createTextBinding(storage, id, path, adapter, { source, window, onReset, onError, onStop }?)` | Binds an editor, through an adapter (`setContents(ops)`, `updateContents(delta)`, `onChange(listener)`), to text field `path` of record `id` over a [text handle](./text#the-text-handle) (`openText()`): the editor's edits are made at once over the handle's reading and logged `window` ms later (the storage's `defer` by default) as one transaction, keystrokes that continue each other as one op; every other writer's change reaches the editor as a delta in its indices. `{ id, field, source, ready, shadow, pending, flush(), stop() }`; a reset, the record gone or a flush not logged (`UNLOGGED`) reloads the editor and drops what was not logged (`onReset`); five failures in a row stop it (`onStop`) |
| `compose(a, b)`, `transform(a, b, priority?)`, `transformIndex(index, delta, priority?)`, `applyToText(text, delta)` | Deltas (Quill's form): the two as one; `b` rewritten to apply after `a` (with `priority`, `a`'s insert first at a tie); where an index is once a delta has applied; a text once a delta has applied (an embed slot as U+FFFC) |
| `spansToDelta(spans)`, `deltaToSpans(ops)`, `spansToBlocks(spans)`, `blocksToSpans(blocks)` | A reading as a document delta and back; typed spans cut at the block markers (what `blocks()` reads) and back |
| `diffSpans(before, after)`, `diffBlocks(before, after)` | The delta that takes one reading to another — cuts and inserts, a marker changed as `{ retain: 1, attributes: { embed } }`, marks changed over what stays — for `applyDelta()` |
| `selectionToTokens(storage, id, path, { anchor, head? })`, `tokensToSelection(storage, tokens)` | A selection as cursor tokens `{ id, field, anchor, head }` that survive the edits around it, and back to indices (`null` once a place is gone) |
| `presenceCursors(presence, storage, id, path, { key }?)` | The cursors a presence room holds on the field — each state's `key` (`cursor`) as tokens — resolved: `[{ node, state, anchor, head }]` |
| `createFit(read, diff)` | For an adapter: what its document differs from the field by, held for the editor's next edit — `{ unfit, base, hold(base, unfit?, back?), send(local, base), toDoc(index), toField(index) }` |
| `undoSteps(manager, binding, report)` | For an adapter's commands: `{ undo(run), redo(run) }` over an undo manager — whether there is a step and, with `run`, the step taken once the binding's edits are logged; a failure to `report` |
| `failureReporter(storage, id, path)` | `(event, onError?) => (error) => void`: a failure of an adapter's own work to `onError`, or a warn `event` |

## ProseMirror (subpath)

`@alexify/syncom/prosemirror` — a ProseMirror editor bound to a text field. See [Editors](../guide/editors#bind-prosemirror).

| Member | Notes |
| --- | --- |
| `createProseMirror(storage, id, path, { model, state, transform, view? }, options?)` | The prosemirror-* modules are the caller's, injected. `{ key, plugin, source, binding, attach(view), cursorPlugin(presence, { field, render, className }?), commands(undoManager), stop() }`; `options` as `createTextBinding`'s |
| `docToSpans(doc)`, `spansToDoc(spans, schema)` | A document as typed spans — a marker `{ type, parents, attrs }` per block-level node in document order, a textblock's text and inline nodes after it — and back; what the schema cannot hold is left out |
| `indexOfPos(doc, pos)`, `posOfIndex(doc, index)` | A document position as a text index of the field, and back |

## CodeMirror (subpath)

`@alexify/syncom/codemirror` — a CodeMirror 6 editor bound to a text field. See [Editors](../guide/editors#bind-codemirror).

| Member | Notes |
| --- | --- |
| `createCodeMirror(storage, id, path, { state, view? }, options?)` | The @codemirror modules are the caller's, injected. `{ extension, source, binding, attach(view), cursors(presence, { field, className, render }?) → { extension, stop() }, commands(undoManager) → { undo, redo, keys }, stop() }`; `options` as `createTextBinding`'s |
| `deltaOfChanges(changeSet)`, `changesOfDelta(delta)` | A ChangeSet as a delta over the document before it, and a delta as change specs |

## Store (subpath)

`@alexify/syncom/store` — a source of syncom's as a framework store. See [Frameworks](../guide/frameworks).

| Member | Notes |
| --- | --- |
| `toStore(cursor, options?)` | A query's rows, as `watch()` gives them; `undefined` until the first fetch |
| `toStore(record, options?)` | A live `Document`'s data — a copy per change; `null` once deleted |
| `toStore(presence, options?)` | A presence room's states, a `Map` by node |
| `toObservable(store)` | An interop Observable over a store — `subscribe(observer \| next)` → `{ closed, unsubscribe() }`, itself at `Symbol.observable` — for Angular's `async` pipe and `toSignal()`, RxJS's `from()`; never errors or completes, `unsubscribe()` lets the store go |
| `toStore(storage, id, { path }?)` | The record as `get()` reads it — or the field at `path` (`'profile/city'`) — read again after every turn that changed it; the newest read wins |
| `toStore(db.local, key, options?)` | A [local document](../guide/local)'s value by key (`db.local`, `collection.local`); `null` once deleted |
| `toStore(state, path?, options?)` | [App state](../guide/state): the value at `path`, or the whole object; the options come third, after a `null` path for the whole object |
| `fromEvents(emitter, events, read, options?)` | `read()` (a value or a promise of one) at the start and after each of `events` — the sync manager's `peers()` on `peer` and `sync`, say |

A store is `{ subscribe(run), getSnapshot(), value, error, ready }`: `subscribe` calls `run(value)` at once and on every change and returns the stop function (Svelte's contract); `getSnapshot()` keeps its identity until a change (React's `useSyncExternalStore`). The source is watched from the first subscriber to the last; without one the store answers the last value it saw. `options`: `initial` (what the store holds before the source gave anything), `onError` (a failure of the source; `error` holds it until the next value).

## Branch (subpath)

```js
import { branch, merge, branchInfo, drop } from '@alexify/syncom/branch';
```

A storage forked from another and merged back — see
[Branches](../guide/branches); the rules in [Branches](./versions#branches). Off the main entry; opens the branch
through the parent's own constructor, so it bundles no engine.

| Function | Returns | Notes |
| --- | --- | --- |
| `branch(parent, { path, from?: { tag } \| { at }, ...options })` | `Promise<Database>` | A storage at `path` — a new identity — standing at the parent's state, or at the tag; opened with `options` (`fsi` the parent's unless given; `sync` gets `retention: { ops: 0 }` and `autoStart: false`); writes `branch.json`; rejects with `BRANCH_EXISTS` for a path that holds a `branch.json` or any other file (another storage is never taken over), `TAG_NOT_FOUND` for a tag the parent has not, `HISTORY_GONE` for a `from.at` version its log no longer gives exactly (`branchInfo().forkedAt.at` keeps the version as given); a fork that fails leaves nothing behind |
| `merge(source, { into })` | `Promise<{ ops, pages, joined }>` | Hands `into` the ops it lacks through `applyRemote`, in pages — of every stream the source holds; `joined: true` when the source's log no longer held what `into` needs of any of them (a third node's included) and its state was joined instead, never a gap. Either way round; a storage into itself is a `TypeError` |
| `branchInfo(storage)` | `Promise<BranchInfo \| null>` | `{ parent, forkedAt: { eventId, vector, ts, tag }, createdAt }` from the directory's `branch.json`, or `null`; rejects with `CORRUPT` when the file cannot be read |
| `drop(storage)` | `Promise<void>` | Closes the branch and removes its files (the directories stay); a storage with no `branch.json` is refused with a `TypeError`, an unreadable one with `CORRUPT` — this is the one call that deletes data, and it takes only what `branch()` made |

## Search (subpath)

```js
const { createSearch, normalize, trigrams, cosine, euclidean, manhattan, dot, isVector } = require('@alexify/syncom/search');
```

| Export | Notes |
| --- | --- |
| `createSearch({ minOverlap }?)` | For `createDatabase({ search })`: a function that makes a fresh trigram index per searchable entity. `minOverlap` (0 to 1, default 0.3) is the share of a query's distinct trigrams a record must hold to match; anything else is a `TypeError` |
| `normalize(text)` | What the index sees: decomposed, combining marks stripped, lower case, letters and digits only, one space between words |
| `trigrams(text)` | The per-word, space-padded trigrams of the normalized text |
| `cosine(a, b)`, `euclidean(a, b)`, `manhattan(a, b)`, `dot(a, b)` | The distances a cursor's `nearest(field, vector, k, { distance })` takes by name or as a function — over two arrays of numbers of one length, smaller is nearer: 1 − the cosine of the angle (1 for a zero vector), the Euclidean length, the sum of absolute differences, and the negated dot product (a larger product is nearer) |
| `isVector(value)` | Whether `value` is a non-empty array of finite numbers — what a row's field must be for `nearest()` to measure it |

An index is a `TextIndex` — `put(id, text)`, `remove(id)`, `query(text)` →
`[{ id, score }]`, every match, best first, ties by id — plus `size`, the
records it holds. Any object with the three methods can stand in for it. The
ranking and the costs are in [Full-text search](../guide/fulltext-search).

## wrpc adapter

```js
const { createWrpcLink, isSyncLink, SYNC_INTROSPECTION } = require('@alexify/syncom/wrpc');
```

`createWrpcLink(client, { unit = 'syncom' }?)` wraps a `WrpcClient` into a
[link](./wire#the-link-contract); see [wrpc transport](../guide/replication-websocket). The link's `stream(id)`
and `createStream(name, size)` are the client's `getStream` and `createStream`: wrpc's binary streams, which
snapshot pages and attachments' bytes cross as, written with the writable's `writeAll` — wrpc 2.1 or later.
`SYNC_INTROSPECTION` is what the adapter feeds `client.use()` (under `unit`), so
the four procedures exist on `client.api` without a `load()`.
