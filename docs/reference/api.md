# API reference

Everything below is exported from the package root — the core: records with
registers, counters and sets, the log, the write paths, queries, versions and
sync — except the subpaths. The kinds beyond those are plugins:
[`@alexify/syncom/text`](#text-subpath) (lists and texts) and
[`@alexify/syncom/tree`](#tree-subpath), registered with `open({ plugins })`;
[`@alexify/syncom/all`](#all-subpath) is the core with every shipped plugin
registered — the API as one import (see [Entry points](../guide/entry-points)).
The other subpaths: the
wrpc adapter, [`@alexify/syncom/wrpc`](#wrpc-adapter), the smart contracts,
[`@alexify/syncom/contracts`](#contracts-subpath), the IndexedDB backend,
[`@alexify/syncom/idb`](#backends) (`createIdbFsi`), the text index,
[`@alexify/syncom/search`](#search-subpath) (`createSearch`), fractional indexes,
[`@alexify/syncom/order`](#order-subpath), the undo stack,
[`@alexify/syncom/undo`](#undo-subpath) (`createUndo`), and branches,
[`@alexify/syncom/branch`](#branch-subpath). The browser build exports
the same names — see [Browser](../guide/browser) for the five signatures that
differ.

```js
const syncom = require('@alexify/syncom');
```

## Storage

### `open(options?)`

Returns `Promise<Storage>` — typed by the options: a collection per entity
of `schema`, its records typed by the entity's Standard Schema or by
`Schema<Shapes>` (see [TypeScript](../guide/typescript)), and the methods of
every plugin in `plugins`, all inferred. Takes an options object only — `open('./dir')` is a
`TypeError`. Options: `path` (default `'syncom'`), `name`
(alias for `path`), `fsi`, `durable` and `defer` (see [Backends](#backends) and
[the storage guide](../guide/storage)), `lock`
(`'fail'` | `'wait'` | `false`, or `{ mode, staleAfter, poll, timeout }` — see
[One instance per directory](../guide/storage#one-instance-per-directory)),
`maxListeners` (the listener cap of the storage and its sync manager, default
100), `cache`, `integrity` and `catalog` (see
[The catalog and the cache](../guide/storage#the-catalog-and-the-cache)),
`chain` (`false` keeps no [chain](../guide/chain#through-storage)),
`actor` (see [Operations](../guide/sync#operations)), `schema` and `validator` (see
[Collections](../guide/storage#collections)), `search` (the text index behind
`$text`, see [Full-text search](../guide/query#full-text-search)), `getId` (must mint a
[valid id](../guide/storage#custom-identifiers)), `logger`, `encrypted`,
`sync` (see [Sync options](../guide/sync#options)), `telemetry` (see
[OpenTelemetry](../guide/telemetry)), `hooks` (see
[Hooks and events](../guide/hooks)), `plugins` (the plugins this storage runs
with — `text`, `tree`, `signing`, `chain`, `encryption` from their subpaths;
see [Plugins](#plugins)).

### `Storage`

`await new Storage(options)` — `open()` is the shorthand. Extends `Emitter`.
The list, text and tree methods below (`splice` … `treeRemove`, `spans`,
`cursor`, `index`) are the `text` and `tree` plugins' — on a storage opened
without the plugin they reject with a `TypeError` `code: 'PLUGIN_MISSING'`
naming the subpath; `@alexify/syncom/all` has both.

| Method | Returns | Notes |
| --- | --- | --- |
| `insert(data, options?)` | `Promise<string>` | Generates an id via `getId` (a UUID by default) and writes; rejects with `code: 'INVALID_ID'` when the generator mints one that is not a [valid id](../guide/storage#custom-identifiers) |
| `get(id, { at }?)` | `Promise<R \| null>` (`get<Post>(id)`; `RecordData` by default) | `null` when absent or deleted; verifies against the chain; a copy — editing it changes nothing. With `at` (the `versions` plugin's) — an event id, a stamp (a number or a `Date`), `{ vector }` or `{ tag }` — the record at that version, folded from the log, or a tag's copy (see [Versions and history](../guide/versions)); rejects with `HISTORY_GONE` when the log cannot give it exactly, `INVALID_VERSION` for a malformed `at` or a seq not reached, `TAG_NOT_FOUND` for a tag this node has not, `ENCRYPTED` for an encrypted record (at a tag one reads as its data) |
| `tag(name)` | `Promise<Tag>` | Names the storage as it is now — `{ name, eventId, seq, ts, vector, createdAt }`, kept on this node as the catalog of the moment plus a copy of each record's file taken before its first change after the tag (see [Tags](../guide/versions#tags)); `name` is of the record-id form (a `TypeError` otherwise); deferred files land first. Rejects with `TAG_EXISTS`, `UNPERSISTED` while a record's file lags the log after a failed write, `CORRUPT` while `tags.json` is unreadable; the `versions` plugin's (`PLUGIN_MISSING` without it) |
| `untag(name)` | `Promise<void>` | Drops a tag; the copies the next older tag needs move there; rejects with `TAG_NOT_FOUND`; the `versions` plugin's (`PLUGIN_MISSING` without it) |
| `tags()` | `Tag[]` | The tags, oldest first — from memory; the `versions` plugin's (`PLUGIN_MISSING` without it) |
| `at(name)` | `TagView` | The storage at a tag: its fields plus `get(id)` (the record as it was, through the lens and the read hooks with `at: { tag }`; `null` when it was not there), `has(id)` and `list()` (every live id then; promises — the tag's catalog is read at the view's first read), `collection(entity)` (`name`, `select()`, `count()`, `get()` as it was — `watch()` throws, no `$text`; an entity the schema has not is a `TypeError`) and `snapshot(options)` (pages like `snapshot()`, at the tag's position); throws `TAG_NOT_FOUND`; the `versions` plugin's (`PLUGIN_MISSING` without it) |
| `atVersion(at)` | `VersionView \| TagView` | The storage at any version the log can still give exactly — an event id, a stamp, `{ vector }` (or `{ tag }`: the tag's view): `eventId`, `vector` (the ops within it, per stream), `ts`, `get(id)`, `has(id)`, `list()` and `snapshot(options)` — the pages another storage joins to stand there, what `branch(parent, { from: { at } })` forks from; a record compacted past the version, or a stream cut by compaction with nothing of it inside, is `HISTORY_GONE` (never under `retention: 'all'`); the `versions` plugin's |
| `diff(id, from?, to?)` | `Promise<Patch[]>` | The patches that turn the record at `from` into the record at `to` (the present when omitted), per field by kind — see [Diff and restore](../guide/versions#diff-and-restore); raw, through the lens, no read hooks; a text's marks are not diffed; rejects as `get(id, { at })` would, `ENCRYPTED` for an encrypted record; the `versions` plugin's (`PLUGIN_MISSING` without it) |
| `applyPatches(id, patches, { actor, source, message }?)` | `Promise<number>` | Realizes patches as ops of this node's own, as one [transaction](../guide/storage#transactions) (`put`, `unset`, `write`, `inc`, `add`, `remove` with `elements` — `own: true` for this node's adds alone — or exact `removals`, `splice` (with `vals`), `setAt`, `mark`, `treeMove`, `treeRemove`, `delete`, `purge`); `source` rides on the `commit` events, `message` on every op; resolves to how many ops. A patch is checked as the method of its name checks its arguments — the wrong shape is a `TypeError` with nothing minted — and every patch is first resolved and applied over a scratch record, so an index out of range, a kind clash, a cycle or a type change refuses the whole batch with nothing written; a hook or a validator that throws on a later op leaves nothing written either |
| `transact(fn, { actor, source, message }?)` | `Promise<T>` | Runs `fn(tx)` as one transaction: every write made through `tx` — the write API less `purge()`, the plugins' methods included, plus `get(id)`/`has(id)` reading the records as the transaction left them (through the lens, without the read hooks) — is one op, prepared in one turn of the mutation queue with the hooks, the validator and the unique keys of each, and appended with the others as one group once `fn` returns: all durable or none, one chain block, each record's file written once, the `commit` events after, in order. `message` (at most 1 024 characters) rides on every op — signed, logged, relayed, listed by `history()` — and `source` on their `commit` events. A throw from `fn`, or a write refused (`OUT_OF_RANGE`, `FIELD_KIND`, a validator…), leaves nothing appended and rejects with the error; an encrypted write inside is `ENCRYPTED`, `tx.purge()` a `TypeError`. Resolves to what `fn` returned once the transaction has landed |
| `restore(id, at, { actor, source, message }?)` | `Promise<number>` | Makes the record read as it did at `at` (required) with new ops that lead back — `diff(id, undefined, at)` applied; rejects as `diff()` would; lands whole or not at all (see `applyPatches`); the `versions` plugin's (`PLUGIN_MISSING` without it) |
| `compact(id, { actor, source, message }?)` | `Promise<number>` | Rewrites the record as the ops its reading takes today — a `write` of the registers, then one op per field of another kind: an `inc`, an `add`, one `splice` (a text or a list becomes one run), one `tree` move per node — so what lies under it goes by the reset rule here and on every peer, and `get()` and `spans()` read the same: a text's marks are laid again in the order they were made, with their expand rules, and a list or text over 1 048 576 elements is made again in several runs. It names every element anew, so the cursors into its lists and texts read `null` after, and a stacking mark has a new id; a list, text, set or tree that reads empty is left out. A peer's op stamped before the rewrite and arriving after it is dropped, as with any whole-record write. Resolves to how many ops; `0` for a record that is not there; `ENCRYPTED` for an encrypted one |
| `history(id, { limit = 50, before }?)` | `Promise<{ versions, complete, exact }>` | The record's past, newest first: `{ eventId, seq, ts, origin, actor, message, type, fields, data, scrubbed? }` per op this node applied, `data` the record after it through the lens and `afterRead` — run for the versions handed out alone; `limit` a positive integer or `Infinity`; `before` (an event id of this log — `HISTORY_GONE` `epoch` for another incarnation's) pages back to the versions older than it; `complete` when the page reaches the first op the node applied and nothing was dropped, `exact` when the versions are what the node held; rejects with `ENCRYPTED` for an encrypted record; the `versions` plugin's (`PLUGIN_MISSING` without it) |
| `lastEditorOf(id, field)` | `Promise<{ origin, ts } \| null>` | Who last wrote `field` — the node and the stamp of a register's value, a counter's newest increment, a list's, text's or tree's newest run, mark or move — from the record's metadata; `null` for a set (its slots carry counts, no stamps), a field the record has not, a record that is not there. `origin` is a node id, not a user: `actor` on the ops is the application's word |
| `editorsOf(id)` | `Promise<string[]>` | Every node that wrote something the record still carries — its registers' writers, its counters' contributors, the adders of its sets' live elements, the writers of every run, mark and value of its lists and texts, the movers of its trees — sorted; `[]` for a record that is not there |
| `has(id)` | `Promise<boolean>` | `false` for a tombstone |
| `list()` | `Promise<string[]>` | Every live id, sorted — from the catalog, no I/O |
| `check(entity, data)` | `Promise<unknown>` | Runs the entity's validator as a write would and returns its value; rejects with `ValidationError`; writes nothing. The `schema` plugin's: `PLUGIN_MISSING` without it, as is `migrate()` |
| `migrate({ entities, batch = 100, actor }?)` | `Promise<{ migrated, counters, sets, lists, texts, trees }>` | Rewrites records of an older schema version through the lens — a `write` of the view, then the counters and the sets added back, a list or a text as one run, a tree as one move per node (an empty one is dropped); idempotent; `actor` rides on the ops it writes; a `TypeError` without `open({ schema })` (see [Reading across versions](../guide/storage#reading-across-versions)) |
| `set(id, data, options?)` | `Promise<void>` | Replaces the record (a `write` op); keeps `$type` — data naming another is a `TypeError` with `code: 'TYPE_IMMUTABLE'`; rejects with `FIELD_KIND` for a field held by another kind than a register. Every writer rejects an invalid id with `TypeError` `code: 'INVALID_ID'` |
| `update(id, delta, { actor }?)` | `Promise<void>` | Sets the listed fields (a `set` op) — a key may be a path (`'profile/city'`, see [Paths](../guide/storage#paths)); rejects with `NOT_FOUND` when absent, `FIELD_KIND` on a counter, set, list, text or tree field, or under a prefix one holds |
| `unset(id, fields, { actor }?)` | `Promise<void>` | Removes fields of any kind — one name or an array of them (an `unset` op: the fields' own reset, which an older concurrent write of them loses to and a newer one makes them again); a field the record does not hold is no op, so an absent record is too; also on a collection and a `Record` |
| `inc(id, key, value = 1, { actor }?)` | `Promise<void>` | Adds to a counter field (an `inc` op); `FIELD_KIND` on a field of any other kind |
| `add(id, key, elements, { actor }?)` | `Promise<void>` | Adds JSON values to a set field (an `add` op); creates the field and the record when absent; `FIELD_KIND` on a field of any other kind |
| `remove(id, key, elements, { actor }?)` | `Promise<void>` | Removes from a set field the elements this node has seen added (a `remove` op; none seen: no op); `FIELD_KIND` on a field of any other kind |
| `elementAt(id, key, index)` | `Promise<string \| null>` | The name of the element at `index` of list field `key` — what a path under it is spelled with (`items/<name>/body`, see [Children of elements and nodes](../guide/lists#children-of-elements-and-nodes)); `null` out of range or when the field is not a list; the `text` plugin's |
| `elements(id, key)` | `Promise<string[]>` | The names of the elements of list field `key`, in order; `[]` when the field is not a list; the `text` plugin's |
| `splice(id, key, index, count = 0, content?, { actor }?)` | `Promise<void>` | Removes `count` elements at `index` of a list or text field and inserts `content` there (a `splice` op) — an array for a list, a string for a text; the first write decides the kind (see [Lists, text and trees](../guide/lists)). Creates the field and the record when absent; rejects with `OUT_OF_RANGE` past the length, `FIELD_KIND` on a register, counter, set or tree field, for a string on a list or an array on a text, or past a bound of the field |
| `push(id, key, content, { actor }?)` | `Promise<void>` | Appends to a list or text field — a `splice` at the end |
| `updateText(id, key, text, { actor }?)` | `Promise<number>` | Makes a text field read as `text`: diffed against the field inside the mutation queue (Myers, UTF-16 units), one `splice` per hunk, last first, in one turn of the queue; resolves to the number of ops. A difference deeper than a thousand edit steps is one op replacing the middle |
| `setAt(id, key, index, value, { actor }?)` | `Promise<void>` | Replaces the element at `index` of a list field (an `assign` op) — a register per element that follows it through a concurrent move; on a text, the marker of the embed slot at `index` (`{ type, parents, attrs, isEmbed }`, or `null`; `NOT_FOUND` for a slot that is no embed); rejects with `OUT_OF_RANGE`, `FIELD_KIND` on the other kinds |
| `move(id, key, from, to, { actor }?)` | `Promise<void>` | Moves the element at `from` of a list field to `to`, its index once out (a `move` op); concurrent moves of one element leave it once, at the newer one's place; `from === to` is nothing; rejects with `OUT_OF_RANGE`, `FIELD_KIND` on a text and on the other kinds |
| `treeMove(id, key, node, parent = null, { after, before, actor }?)` | `Promise<void>` | Puts `node` of a tree field under `parent` (`null`: a root) — after sibling `after`, before sibling `before`, or last (a `tree` op); creates the node, the field and the record when absent. Two nodes moving concurrently so that each would hang under the other: the older move stands, the newer is kept without effect, on every node. `parent === node` is a `TypeError`; rejects with `CYCLE` for a parent under the node, `NOT_FOUND` for a sibling not under `parent`, `OUT_OF_RANGE` for a move that would reach below the 512 levels a tree reads or a place with no room left among its neighbours; a move to where the node already is makes no op; `FIELD_KIND` on the other kinds |
| `treeRemove(id, key, node, { actor }?)` | `Promise<void>` | Removes `node` of a tree field with everything under it — a `tree` op moving it under `$trash`; a node not known here is created there, so a concurrent creation lands removed; twice is nothing |
| `mark(id, key, start, end, name, value, { expand, many, actor }?)` | `Promise<string \| null>` | Marks visible range `[start, end)` of a text field with `name: value` (a `mark` op); `expand` (`'after'` by default, `'before'`, `'both'`, `'none'`) says whether text typed at the edges takes the style; per name the newest mark wins; `many: true` stacks with every other of its name. Resolves to the mark's id; rejects with `OUT_OF_RANGE`, `FIELD_KIND` on a list and on the other kinds |
| `unmark(id, key, start, end, name, { expand, actor }?)` | `Promise<void>` | Removes a style over a range: a null mark under the reversed expand rule, so the removal grows where the style would not |
| `unmarkById(id, key, markId, { actor }?)` | `Promise<void>` | Switches one mark off by its id (what `mark()` resolved to) — the only way for a `many` mark |
| `spans(id, key)` | `Promise<TextSpan[] \| null>` | The text field as runs of equal style, `[{ type: 'text', text, marks }]`, its embed slots told apart — `{ type: 'embed', value, marks }` for an inline embed (`value` its marker, `null` for a slot without one), `{ type: 'block', value }` for a block marker (see [Embeds and blocks](../guide/lists#embeds-and-blocks)); raw — no lens, no read hooks; `null` unless the field is a text |
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
| `toDelta(changes, field?)` | `DeltaOp[] \| null` | The [changes](../guide/versions#changes) of text field `field` (every text change when not given) composed into one delta in Quill's form — `[{ retain, attributes? }, { insert, attributes? }, { delete }]` — over the reading before them: a splice's cut and insert, a mark as attributes over its range (`null` removes), an embed slot as `{ insert: { embed: marker } }`, a marker changed as `{ retain: 1, attributes: { embed } }`; `null` when a change is no edit a delta can say (a reset, an unset): read the field again then; the `text` plugin's |
| `applyDelta(id, key, delta, { actor, message }?)` | `Promise<number>` | Makes `delta` the edits of text field `key`, as one [transaction](../guide/storage#transactions): a `retain` moves on (with `attributes`, a mark — or an unmark, for a null — over what it retains; `{ embed }` sets the slot's marker), an `insert` splices text in (`{ embed: marker }` a slot with it) and marks it with its attributes, a `delete` cuts; every mark it lays has `expand: 'none'` — a delta says each insert's attributes itself; resolves to how many ops; a delta of the wrong shape is a `TypeError` with nothing written; the `text` plugin's |
| `swap(id, changes, prev, { actor }?)` | `Promise<boolean>` | CAS, compared inside the mutation queue — `false`, and no write, on mismatch; rejects with `NOT_FOUND` when absent |
| `repair(id)` | `Promise<{ ops, alive }>` | Rebuilds a record whose file fails its integrity check from the log's entries of it (see [Repair](../guide/storage#repair)); rejects with `code: 'UNRECOVERABLE'` when the log holds no whole-record op for it |
| `delete(id, { actor }?)` | `Promise<void>` | Leaves a tombstone |
| `purge(id, { actor }?)` | `Promise<void>` | Forgets the record for good: a `purge` op and a scrub of its log entries, here and on every peer (see [Purge](../guide/storage#purge)) |
| `record(id)` | `Promise<Record>` | Cached per id |
| `saveData(id, data, options?)` | `Promise<void>` | `{ encrypted: true }` seals the record for this node only; `{ actor }` names the writer |
| `loadData(id)` | `Promise<unknown>` | Alias of `get()`; throws if the record no longer matches its block |
| `validate(options?)` | `Promise<boolean>` | `{ last, from }`; no argument walks the whole chain; rejects with `code: 'NO_CHAIN'` under `open({ chain: false })` or without the `chain` plugin (the message says which) |
| `validate(id, data, blockHash)` | `Promise<boolean>` | One record against its block |
| `getCachedData(id)` | `unknown \| null` | Synchronous cache peek, raw (no lens) |
| `hasRecord(id)` | `boolean` | Whether the id is a live record — from the catalog, no I/O |
| `stats()` | `{ closed, queue, cache: { size, max, pinned }, catalog: { entries, dirty }, tags: { count, corrupt }, held, deferred, inflight, log: { length, floor, next, epoch, segments, latestTs, droppedTs, corrupt, pins }, chain: { tail } \| null, lock: { mode } \| null }` | The node's health, from memory — no I/O; `tags.corrupt` while `tags.json` could not be read; `log.corrupt` the log files whose checksum did not match at this open (a segment lost, an open file dropped); `held` records whose files lag the log — after a failed write, or waiting under `open({ defer })` — and `deferred` the latter alone; `inflight` local writes appended but not on disk yet; `log.pins` readers holding segments past retention |
| `flush()` | `Promise<void>` | Lands what waits: the writes in flight, then the record files deferred under `open({ defer })` — one block, every file — so what was written is on disk when it resolves |
| `applyRemote(ops, { via, scopes, peer, adoptFrom, bound }?)` | `Promise<{ applied, skipped, duplicates, gaps, malformed, unsigned, forged, outOfScope }>` | Applies a peer's ops, in order per origin; `peer` is `{ url, node }` for the hooks; `malformed` ops (shape, id, a stamp beyond `sync.maxSkew`) and ops refused for their signature (`forged`; `unsigned` under `sync.signatures: 'require'`) are counted and dropped; an `advance` is adopted only when its origin is `adoptFrom`; under `bound` (a host's push passes the peer's granted scopes) an op whose record is outside them, before or after it, is counted `outOfScope` and dropped |
| `snapshot({ cursor, limit, scopes }?)` | `Promise<{ records, cursor, eventId, vector }>` | One page of state, tombstones included |
| `mergeSnapshot(records, { via, from }?)` | `Promise<void>` | Joins a page (as `merge` ops of this node) |
| `adoptVector(vector, { via, from }?)` | `Promise<SyncOp \| null>` | Records what a joined snapshot covers (an `advance` op) |
| `observe(id, path?, listener)` | `() => void` | Watches record `id`: `listener(changes, event)` after every turn that changed it — a local write, a transaction, a peer's page, a joined snapshot — with the record's [changes](../guide/versions#changes) of that turn, tagged by `id`, and the `transaction` event they came in; under `path` (a field or a [path](../guide/storage#paths)), the changes of that field, of what hangs under it and of a prefix of it (a reset above), and the whole record's (a delete, a purge). A listener is contained like an event listener; a throw or a rejection is logged (`listener.error`). Returns the function that stops watching |
| `close()` | `Promise<void>` | Stops sync, lands what is in flight and the deferred files, and seals the log; further writes are refused (`CLOSED`) |

Properties: `fsi` (the backend given to `open()`, wrapped when `durable`, or
the platform's), `schema`, `schemaInfo` (`{ version, hash, previous, held }`,
`null` without a schema — see [Schema versions](../guide/storage#schema-versions)),
`sync`, `nodeId` (this node's Ed25519 public key, base64url — what its ops are
verified against), `signatures` (`'verify'`, `'require'` or `false`), `path`,
`log`, `vector`, `logger` (the writer built from
`open({ logger })` — `debug`/`info`/`warn`/`error`), `telemetry` (the writer
the engine records through — the `telemetry` plugin's from `{ api }` or
`{ tracer, meter }`, one given as it is, or the disabled one).
Statics: `Storage.Collection`, `Storage.Record`, `Storage.generateId()` — the
default `getId`, synchronous in both halves.

Events — listeners are contained, a throwing one is logged and never fails
the operation (see [Hooks and events](../guide/hooks#events)):

| Event | Payload | When |
| --- | --- | --- |
| `change` | `(op, via)` | Every op applied here; `via` is `null` for a local write, otherwise `{ url, node }` of the peer it came from (`url` null on the hosting side) |
| `commit` | `({ op, seq, source, before, after, kinds })` | A local op is durable — never a peer's, a snapshot's merge or an encrypted write; `before`/`after` the record around it as copies (`null` when absent or deleted), `kinds` every field's kind, `source` the Record whose `save()` it was or what `applyPatches()` was given, else `null`; built only while someone listens (see [The commit event](../guide/versions#the-commit-event)) |
| `apply` | `({ via, peer, ops, applied, skipped, duplicates, gaps, malformed, unsigned, forged, outOfScope })` | A peer's batch is durable |
| `error` | `(error)` with `error.code` and `error.op`, plus `error.rejected` (`OP_REFUSED`: `[{ field, reason }]`, `reason` a kind, `'bound'` — with `detail`, `count`, `max` — or `'malformed'`) or `error.entity` + `error.issues` (`OP_INVALID`); `error.count` for `BAD_SIGNATURE` and `UNSIGNED`; `error.ids` for `UNPERSISTED` | A peer's op of a kind the field's holder outranks (register, counter, set, list, text, tree, in that order), past a bound of a list or text field, or carrying a payload the engine does not admit; skipped as invalid under this node's schema, skipped because this node cannot read the record's file (`OP_UNREADABLE`), or refused for a stamp beyond `sync.maxSkew` (`SKEW`); signatures refused (`BAD_SIGNATURE`, `UNSIGNED`); logged ops whose record files could not be written (`UNPERSISTED`) |
| `conflict` | `({ kind: 'unique', entity, fields, id, other, op })` | A peer's op left a unique key shared by two records; both are kept |
| `schema` | `({ kind: 'drift', peer, version, hash, local })` / `({ kind: 'ahead', op, held })` | A peer runs this schema version with another snapshot hash (see [Schemas](../guide/sync#schemas)) / a peer's op is from a newer version, applied or held |
| `log` | `({ kind: 'roll', sealed, dropped, floor, segments })` | The log sealed a segment and maybe dropped old ones; `floor` is where a resume is still possible |
| `close` | — | After `close()` sealed the log |

Hooks (`open({ hooks })`): `beforeWrite`, `afterWrite`, `beforeRead`,
`afterRead`, `beforeApply`, `afterApply` — see
[Hooks and events](../guide/hooks).

### `Record`

Extends `Emitter`. Emits `update` with `(data, delta)` — on a staged
assignment, and when the record changes in storage (`null` data once deleted).

`id`, `data()`, `delta()`, `save({ actor }?)`, `inc(key, value?, { actor }?)`,
`add(key, elements, { actor }?)`, `remove(key, elements, { actor }?)`,
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
live property per field of the loaded object. `SyncomRecord<R>` types
`data()` as `R | null`, `delta()` as `Partial<R>` and the live properties by
`R` — a typed collection's `record()` and `storage.record<R>(id)` give it;
`RecordData` otherwise (see [TypeScript](../guide/typescript)).

### `Collection`

Created per schema entity and exposed as `storage.<EntityName>`; a name the
storage already answers to (`get`, `close`, `log`, `sync`…) is refused at
`open()` with a `TypeError`.

`SyncomCollection<R, I>` — `R` the record as it reads, `I` what a write
takes; both from the entity's Standard Schema or the schema's `Shapes`,
`RecordData` otherwise (see [TypeScript](../guide/typescript)).
`name`, `insert(data, options?)` (resolves to the new record's `Record`),
`get(id, { at }?)` (null for a record of another collection),
`set(id, data, options?)` (stamped as the collection's),
`update(id, delta, { actor }?)` (refuses a delta naming `$type`),
`delete(id, { actor }?)`, `record(id)` — `update`, `delete` and `record`
reject with `NOT_FOUND` for a record of another collection —
`select(query?)` → a cursor, `count(query?)` (the `query` plugin's:
`PLUGIN_MISSING` without it).
Writes through a collection with a `schema` are validated — see
[Validation](../guide/storage#validation); `unique` keys are refused with a
`ValidationError` whose issue has `code: 'unique'` and `conflict`.

#### `Cursor`

`collection.select(query)` — the `query` plugin's (see
[Queries](../guide/query) and [Query](#query-subpath)); `$text` in the
query searches the entity's `search` fields, best first unless ordered.

| Member | Notes |
| --- | --- |
| `order(field)`, `desc(field)` | Sort keys, in order; nothing first, then booleans, numbers, strings; stable |
| `limit(n)`, `offset(n)` | Applied after the sort |
| `filter(fn)` | A predicate over the loaded row |
| `projection(fields)` | The fields each row carries, plus `id` |
| `fetch()` | `Promise<QueryRow<R>[]>` — `{ id, ...data }` as the record reads |
| `count()` | `Promise<number>` |
| `one()` | `Promise<QueryRow<R> \| null>` |
| `watch(listener, { onError }?)` | Runs now and after every change to the collection; returns the stop function |
| `[Symbol.asyncIterator]` | `for await (const row of cursor)` |

The shapes on the wire and on disk — the op's slots, the payloads, the
signed header, the log and record files, the procedures — are in
[Wire format](./wire).

## Sync (subpath)

```js
const { sync, SyncManager, isSyncLink } = require('@alexify/syncom/sync');
```

`sync` is the plugin: `open({ plugins: [sync] })` gives the storage its
manager at `storage.sync`, built once the log is open; without it
`storage.sync` is `PLUGIN_MISSING`, and a transport of the application's own
carries ops with the core's `outbound()` and `applyRemote()` (see
[Without the plugin](../guide/sync#without-the-plugin)). The options
(`open({ sync })`), the hooks, the link contract and the apply path are the
core's.

### `SyncManager`

`storage.sync`; `await new SyncManager(storage, options)` builds one by hand.
Extends `Emitter`. See [Sync](../guide/sync).

| Method | Returns | Notes |
| --- | --- | --- |
| `addNode({ url, token?, scopes? })` | `Promise<void>` | Registers a peer to dial; dials it at once when started |
| `removeNode(url)` | `Promise<void>` | Hangs up too |
| `enableNode(url, enabled = true)` | `Promise<void>` | Keep a node without dialing it |
| `listNodes()` | `Node[]` | `{ url, token, scopes, enabled, lastSync, cursor, remote, acked }`; `remote` is `{ id, epoch, schema }` after a hello; `acked` is how far the node holds this node's own streams (vector keys → seq), what the log keeps them for |
| `start()` | `Promise<void>` | Dials every enabled node; needs `sync.connect` |
| `stop()` | `Promise<void>` | Closes every link |
| `sync(url?)` | `Promise<Array<{ url, pushed }>>` | Pushes what the peers lack now |
| `peers()` | `Array<{ url, node, connected, subscribed, cursor, lastSync, pending, behind, stuck, lastError }>` | Live view; `behind` after a failed push until the next recovery, `stuck` once a page failed three times in a row (see [Protocol](../guide/sync#protocol)), `lastError` `{ code, message, at }` or null |
| `hosted()` | `Array<{ node, scopes, since, cursor }>` | Hosting side: every peer with a live `changes` feed here (`scopes` null means every scope) |
| `unit({ access, authorize, tracked, pageSize, pageBytes, limits, meta, presence }?)` | router unit | The procedures a host mounts: `hello`, `push`, `snapshot`, `changes`, and the inbound event `on.presence` — a peer's [presence](../guide/presence) update, checked (its own node, a scope it asked for, `presence.rate` per second — 20 — signed under `'require'`) and relayed to the scope's room but the sender; the host keeps the newest state per node (`presence.max` per scope, 1 024; for `presence.timeout` ms, 30 000) and hands them to a newcomer at hello — see [Hosting](../guide/sync#hosting) |
| `presence(instance)` | `() => void` | Carries a [presence](../guide/presence) instance: its updates go to every connected host as the `syncom/presence` event, a host's come back to it, a host hands its room's at hello; returns the function that stops carrying it |

Properties: `storage`, `started`.

Events (contained, like the storage's): `peer` `({ url, connected, node?,
reconnected?, schema? })`, `sync` `({ url, pushed })` after a push and `({ url,
received, applied, skipped, duplicates, gaps, malformed, unsigned, forged,
outOfScope })` after a received page, `bootstrap` `({ url, records })`, `error`
(with `.url`; `code: 'PAGE_FAILED'` / `'STUCK'`
with `cursor` and `attempt` for a page of the feed that could not be applied,
`'HANDSHAKE_LOOP'` for a host that keeps answering 428), `start`, `stop`,
`node` `({ url, action: 'add' | 'remove' | 'enable' | 'disable' })`, `connect`
`({ url })` once a link is accepted (before hello), and on the hosting side
`hello` `({ node, scopes, schema })` once a peer is authorized and `refused`
`({ node, reason, count })` when a push carried ops it would not take: `reason`
`'scope'` for ops outside the scopes that hello granted — the scope an op
declares, or the scope of the record it writes, before or after it (see
[Scopes](../guide/sync#scopes)) — `'forged'` and `'unsigned'` for signatures
refused (see [Signatures](../guide/sync#signatures)). The dialer's `error`
event also carries `'REWOUND'` and `'UNDELIVERABLE'` (see the codes below).

Hooks (`open({ sync: { hooks } })`): `beforeConnect`, `beforeBootstrap` — see
[Hooks and events](../guide/hooks#sync-hooks).

### `SyncomError`

What syncom rejects with when an operation cannot be done: `name`
`'SyncomError'`, a `code` from the table below, the fields the code lists,
and `cause` when an underlying error exists. A `TypeError` is the other kind
— a wrong argument, option or hook result, a bug in the calling code — and
carries no code, except `INVALID_ID`, `TYPE_IMMUTABLE`, `INVALID_VERSION`,
`NO_CHAIN` and `PLUGIN_MISSING`, whose value is data or configuration (the rows below say "a
`TypeError`"). `HookError` and `ValidationError` are
`SyncomError`s. Exported from the package root; the union of codes is the
`SyncomErrorCode` type.

| Code | Raised by | Fields |
| --- | --- | --- |
| `CLOSED` | any write, `applyPatches()`, `tag()`/`untag()`, `repair()`, `applyRemote()`, `mergeSnapshot()` or `adoptVector()` after `close()` | — |
| `IN_HOOK` | a write issued from inside a write or apply hook (the `cause` of the `HookError` the operation rejects with) | — |
| `NOT_FOUND` | a write under a list element or a tree node that is not there (`items/<name>/body` with no element `name`: `id`, `field` the list or tree, `elem` the name); `update()`, `swap()` on a record that is absent, deleted or purged; a collection's `update()`, `delete()`, `record()` on a record of another collection; `treeMove()` with an `after`/`before` sibling not under the parent; `joinBlock()`, `updateBlock()`, `setAt()` on a text at a slot that is no block marker and no embed | none from `update()`/`swap()`; `id`, `entity` (the collection's) from a collection; `id`, `field`, `node` (the sibling) for a tree; `id`, `field`, `index` for a text's slot |
| `FIELD_KIND` | `update()`/`set()` on a counter, set, list, text or tree field, `inc()` on a register, set, list, text or tree field, `add()`/`remove()` on a register, counter, list, text or tree field, `splice()`/`push()`/`updateText()` on a register, counter, set or tree field (and a string on a list, an array on a text), `move()` on anything but a list, `setAt()` on anything but a list or a text, `mark()`/`unmark()`/`unmarkById()`/`insertEmbed()`/`splitBlock()`/`joinBlock()`/`updateBlock()` on anything but a text, `treeMove()`/`treeRemove()` on anything but a tree — the patches of `applyPatches()` alike; a list or text op past a bound of the field — pending work (`sync.pendingMax`, 4 096), a run (1 048 576 slots) or the field as a whole (4 194 304 slots; see [Costs and limits](../guide/lists#costs-and-limits)); an `inc()` that would take this node's sum of the counter past ±`Number.MAX_SAFE_INTEGER` | `field`, `kind` (`'register'`, `'counter'`, `'set'`, `'list'`, `'text'`, `'tree'` — or `'bound'`, with `detail` (`'pending'`, `'run'`, `'field'`, `'counter'` or `'paths'`), `count` and `max`); `prefix` when the field lies under a prefix a counter, a set, a list, a text or a tree holds |
| `OUT_OF_RANGE` | `splice()` past the length of a list or text field — the index, or the index plus the count; `setAt()`/`move()` at an index the list has not; `mark()`/`unmark()` over a range the text has not; `treeMove()` to a place that would read below the 512 levels a tree shows, or between neighbours with no room left for another fractional index | `id`, `field`, `index`, `count`, `length`; for a tree `node` and `depth`, `max`, or `reason: 'fi'`, `length`, `max` |
| `STALE` | `applyDelta()` with `expect` on a text field that reads otherwise inside the mutation queue — a peer's edit landed between the reading the delta was made over and the delta; nothing written. The editor binding rebases the delta and sends it again | `id`, `field` |
| `SURROGATE` | `splice()`, `mark()`, `unmark()` or `cursor()` on a text at an index between the two halves of a surrogate pair (a character outside the BMP) — decided inside the mutation queue, against the text as it is; `updateText()` never makes one, its diff keeps a pair whole, and a string with a lone half is a `TypeError` | `id`, `field`, `index` |
| `CYCLE` | `treeMove()` to a parent that hangs under the node — decided inside the mutation queue, against the tree as it is (the node itself as its parent is a `TypeError`) | `id`, `field`, `node`, `parent` |
| `HISTORY_GONE` | `get(id, { at })`, `diff()`, `restore()` for a version the log cannot give exactly, `history({ before })` with an event id of another incarnation: `reason` `'compacted'` (dropped entries the version depends on, or a cut before anything retained), `'scrubbed'` (a cut before a purge), `'merge'` (a stamp below a joined snapshot), `'epoch'` (an event id of another incarnation) | `id`, `reason` |
| `INVALID_VERSION` | `get(id, { at })`, `diff()`, `restore()` with a version of the wrong shape, or an event id this log has not reached; `history({ before })` with a malformed event id (a `TypeError`) | — |
| `TAG_EXISTS` | `tag()` of a name in use | `tag` |
| `TAG_NOT_FOUND` | `untag()`, `at()`, `get(id, { at: { tag } })`, `diff()`/`restore()` at `{ tag }` of a tag this node has not — or of one whose catalog could not be read when first used, which a tag view's reads (`has()`, `list()`, a collection's `get()`/`select()`/`count()`, `snapshot()`) find too (the tag is dropped then, with a `tags.dropped` warning) | `tag` |
| `BRANCH_EXISTS` | `branch()` (`@alexify/syncom/branch`) at a path that holds a `branch.json`, or any file — another storage, say — already: a branch opens in a new directory | `path` |
| `ENCRYPTED` | any op beyond a whole-record write — `inc()`, `add()`, `remove()`, `splice()`, `push()`, `updateText()`, `setAt()`, `move()`, `mark()`, `unmark()`, `unmarkById()`, `insertEmbed()`, `splitBlock()`, `joinBlock()`, `updateBlock()`, `treeMove()`, `treeRemove()` — on an encrypted record; `get(id, { at })` (not at a tag), `history()`, `diff()`, `restore()`, `compact()` of one: it has no past in the log; `{ encrypted: true }` on a replicated record | — |
| `INTEGRITY` | a read (`get()`, `has()`, a cursor) or a write (it loads the record first) of a record whose file fails its chain block check, under `integrity: 'verify'`, or cannot be parsed at all (a file torn by a crash; `repair(id)` rebuilds it) | `id`, `cause` (the parse error) |
| `CORRUPT` | `open()` when `node.json`, `schema.json` or `.blockchain.json` cannot be read; `tag()` while `tags.json` cannot be read — the open went on without tags, kept the file as `tags.corrupt.json` and keeps the copies the tags would need under `tags/.pending/` until the file is repaired; `branchInfo()` and `drop()` (`@alexify/syncom/branch`) when `branch.json` cannot be read or is no branch file | `cause`; `file` from `tag()` |
| `DOWNGRADE` | `open()` with `ahead: 'hold'` and a schema version below the one the directory ran | — |
| `LOCKED` | `open()` while another instance holds the directory — at once under `lock: 'fail'`, after `lock.timeout` ms under `'wait'` | `path` |
| `KEYS_INCOMPLETE` | `open()` with the `encryption` or `signing` plugin, `loadKeys()` (`@alexify/syncom/encryption`), `loadSigningKeys()` (`@alexify/syncom/signing`) when one file of a pair (RSA or signing) is missing | — |
| `IDENTITY_MISMATCH` | `open()` with the `signing` plugin when `node.json` names another signing key than `keys/sign-public.pem` — a key pair replaced or restored under a signed identity | `id` (what `node.json` names), `key` (the pair on disk) |
| `BAD_SIGNATURE` | the storage's `error` event, once per page: a peer's op whose signature does not verify against its origin, or whose payload its digest does not match (`sync.signatures` `'verify'` or `'require'`) | `op` (the first refused), `count` |
| `UNSIGNED` | the storage's `error` event, once per page, under `sync.signatures: 'require'`: a peer's op with no signature, or whose origin is no signing key | `op`, `count` |
| `BAD_ENVELOPE` | `decrypt()` (`@alexify/syncom/encryption`) of a ciphertext this version does not read | — |
| `DECRYPT_FAILED` | a read through `atRest()` (`@alexify/syncom/encryption`) of a file that is not the key's: `reason` `'key'` (another key, or a torn ciphertext), `'plain'` (not encrypted), `'torn'` (not base64); through a storage the first such file fails `open()` — as `CORRUPT` with this as its `cause` when it is `node.json`, as is otherwise | `path`, `reason`, `cause` |
| `BLOCK_NOT_FOUND` | `Blockchain.readBlock()` (`@alexify/syncom/chain`), `SmartContract.load()` | `hash` |
| `NOT_CONTRACT` | `SmartContract.load()` of a block that is not a contract | `hash` |
| `NODE_EXISTS` | `addNode()` of a registered url | `url` |
| `NODE_NOT_FOUND` | `removeNode()`, `enableNode()` of an unknown url | `url` |
| `BAD_HELLO` | the sync `error` event: the host's hello answer has no node id | `url` |
| `HANDSHAKE_LOOP` | the sync `error` event: five fresh hellos answered 428 in a row | `url`, `cause` |
| `PAGE_FAILED`, `STUCK` | the sync `error` event: a page of the feed could not be applied; the third in a row | `url`, `cursor`, `attempt`, `cause` |
| `STREAMS_UNSUPPORTED` | the sync `error` event: the host streamed a snapshot and the link cannot read streams | `url` |
| `UNRECOVERABLE` | `repair()` when the log holds no whole-record op for the id | `id` |
| `UNPERSISTED` | the storage's `error` event: ops were logged — the write stands, and replicates — but their record files (or chain block, or a tag's copy) could not be written; the records are held in memory and the next open replays the batch onto the files. Also `tag()` while a record is held: no file to copy from until it lands | `ids`, `cause` (the event's) |
| `REWOUND` | the sync `error` event, at a hello: the host holds more of this node's own ops than its log does — a directory restored from an older copy, or another instance with this identity. The node moves its streams past the host's and bootstraps from it; writes made since the restore and before this hello are lost to the host | `url`, `local`, `remote` (vector keys of this node → seq) |
| `UNDELIVERABLE` | the sync `error` event, once per hello: the host lacks ops of this node's own that its log no longer retains (written before any node was registered, and compacted since); they are not sent | `url`, `missing` (key → `{ host, retained }`) |
| `KINDS_MISMATCH` | the sync `error` event, when a bootstrap would start: the host's `hello` named fewer kinds than this node runs with (a text node joining a core-only host), so its snapshot would lack those fields and the adopted vector would hide the ops behind them; nothing is joined, the feed is left to resume | `url`, `node`, `missing` (the kind names) |
| `SKEW`, `OP_UNREADABLE`, `OP_REFUSED`, `OP_INVALID` | the storage `error` event — see [`Storage`](#storage) | `op`, plus `rejected` / `entity` + `issues`; `cause` for `OP_UNREADABLE` |
| `INVALID_ID` | every writer, `repair()`, `diff()`, `applyPatches()`, `compact()`, `spans()`, `cursor()`, `index()` given an id that is not a [valid id](../guide/storage#custom-identifiers) — and `insert()` when `getId` mints one (a `TypeError`); `get()`, `has()` and `history()` answer as for an absent record | — |
| `TYPE_IMMUTABLE` | a local `set()`, `update()`, `swap()`, `record.save()` or patch whose data names another `$type` than the record's (a `TypeError`) | — |
| `NO_CHAIN` | `validate()` under `open({ chain: false })` or without the `chain` plugin (a `TypeError`; the message says which) | — |
| `PLUGIN_MISSING` | a method, a patch action or a local op of a kind the storage was not opened with — `splice()` without the `text` plugin — and `open()` of a directory that ran with a kind the call lacks; `open()` asking for what no registered plugin provides — `sync.signatures: 'require'` without `signing`, `chain: true` without `chain`, `encrypted: true` without `encryption` — and a per-call `{ encrypted: true }` without it (a `TypeError`; the message names the subpath) | — |
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

`isSyncLink` is the structural check for the [link contract](../guide/sync#the-link-contract).
`outbound` is the selection a push and a branch merge make, as a function:
what `log` (`storage.log`) has that a receiver (`exclude`, its node id)
lacks by its version `vector`, in `scopes` (`null`: every scope), as `{ ops,
first }` — `first` the first seq the log retains per stream of the sender
(`own`), or of every origin with `allStreams`. With `applyRemote()` on the
receiving side it is the updates API of a transport of the application's
own, no `sync` plugin needed (see [Without the plugin](../guide/sync#without-the-plugin)).

### `isSharedLog(value)`

Structural check for the reserved `SharedLog` contract (`append`, `read`,
`parseId` — the shape of wrpc's `BrokerLog`): what a broker-backed hub mode
will take after this version. `open({ sync: { sharedLog } })` is refused.

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
| `epoch`, `floor`, `next`, `vector`, `length`, `lastEventId` | See [The log](../guide/sync#the-log) |
| `formatId(seq)`, `seqOf(key)` | The event id of a seq of this log; one key of the vector (`origin` or `origin@scope`) without copying it |
| `segments`, `retainedOps`, `latestTs`, `pins`, `corrupt` | Sealed segments on disk; how many ops retention keeps at least (`Infinity` when no count bounds it, as under `retention: 'all'`); the newest stamp held since the open (what the clock is seeded from); how many `pin()` readers there are; how many files failed their checksum at this open |
| `append(ops, { skipped, held }?)` | `Promise<LogEntry[]>` — entries with their seqs, once on disk; `skipped` ops are flagged, `held` ones with the version they wait for |
| `held()` | `LogEntry[]` — the entries held for a newer schema version |
| `droppedHeld`, `resetDroppedHeld()` | Held entries compaction dropped since the last reset |
| `droppedTs` | The newest stamp among the ops the log no longer holds — compacted, or unreadable at open; `0` while nothing was ever dropped. A record's past is whole from a reset (`write`, `delete`, `purge`) stamped above it |
| `retain(keep)` | Entries `keep(entry)` answers true for stay, with their segment and everything after it, whatever the retention; `null` clears it. One slot — the sync manager's, which keeps a dialing node's own ops until every node it syncs with has them |
| `pin(keep)` → `unpin()` | Like `retain`, for a reader of the past: the entries `keep(entry)` answers true for stay, with their segment and everything after it, until `unpin()`; pins add up, `retain` stays the sync manager's |
| `scrub(id)` | `Promise<number>` — strips the payload of every entry of `id` and the nonce that salted its digest (`scrubbed: true`), in memory and on disk; the signature and the digest stay, so the header still verifies |
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
replace.

## Chain (subpath)

```js
const { chain, Blockchain } = require('@alexify/syncom/chain');
```

`chain` is the plugin: `open({ plugins: [chain] })` writes a block per applied
batch, checks a record file against its block on a cold read and gives
`validate()` something to walk (see [Blockchain log](../guide/chain)); without
it no block is written, `stats().chain` is `null` and `validate()` rejects
with `NO_CHAIN` naming the plugin, `open({ chain: true })` is `PLUGIN_MISSING`.
`open({ chain: false })` keeps the plugin registered and the chain off.
Blocks are SHA-256 of their JSON through Web Crypto on both platforms.

### `Blockchain`

`await new Blockchain(basePath, { fsi }?)` — the chain on its own.

| Method | Returns |
| --- | --- |
| `addBlock(data)` | `Promise<string>` — the new tail hash |
| `readBlock(hash)` | `Promise<Block>` — throws if unknown |
| `writeBlock(block)` | `Promise<string>` |
| `writeChain()` | `Promise<void>` — persists the tail pointer |
| `validate(options?)` | `Promise<boolean>` — `{ last, from }`; an unknown `from` is `false` |

Properties: `path`, `tailHash`. A block is `{ prev, timestamp, data }`.

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

`signing` is the plugin: `open({ plugins: [signing] })` makes the node id its
Ed25519 public key (`keys/sign-public.pem`, made at the first open), signs
every op the node makes and verifies a peer's against its origin under
`sync.signatures` (see [Signatures](../guide/sync#signatures)). Without it
the node id is what `getId` mints (a UUID by default), nothing is signed and
nothing is checked — the semantics of an unsigned op under `'verify'`, now for
every op — and `sync.signatures: 'require'` is `PLUGIN_MISSING` at `open()`.
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
the op log, never replicated (see [Encryption at rest](../guide/storage#encryption-at-rest));
without it `open({ encrypted: true })` and a per-call `{ encrypted: true }` are
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
through a storage the first such file fails `open()`. The options are
checked when the wrapper is made (a `TypeError`). See
[Backends](../guide/backends#encrypted-at-rest).

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

## Schema (subpath)

```js
const { schema, ValidationError } = require('@alexify/syncom/schema');
```

`schema` is the plugin: `open({ plugins: [schema], schema, validator })` reads
the entity definitions once — the validators adapted (Standard Schema, a
function, what `validator.compile` gives), the id fields, the indexes and
search fields, the migrations and the lens — and the core applies them:
collections on the storage, validation on the write path, the catalog's
indexes, `schemaInfo` for hello, `migrate()` and `check()` (see
[Schema and validation](../guide/schema)). Without the plugin `open({ schema })`
and `open({ validator })` are `PLUGIN_MISSING`, as are `migrate()` and
`check()`, and records are untyped — `$type` a field like any other.
`ValidationError` is the root's, re-exported, and so are the types a schema
carries for TypeScript: `Shapes`, `SchemaOutput<S>`, `SchemaInput<S>`,
`RecordData` (see [TypeScript](../guide/typescript)).

## Query (subpath)

```js
const { query } = require('@alexify/syncom/query');
```

`query` is the plugin: `open({ plugins: [query] })` gives every collection
its `select(query)` cursor, `count(query)` and `watch()`, and a view at a tag
its `select()`/`count()` (see [Queries](../guide/query)). The catalog, its
indexes and the text index behind `$text` (`open({ search })`) are the
core's, kept whether or not anything queries them; without the plugin
`select()` and `count()` throw `PLUGIN_MISSING`.

## Versions (subpath)

```js
const { versions } = require('@alexify/syncom/versions');
```

`versions` is the plugin: `open({ plugins: [versions] })` gives the storage
its past — `get(id, { at })` and `history()` folded from the log, `diff()`
between two versions and `restore()` the way back — and the tags (`tag`,
`untag`, `tags`, `at`), named versions kept on this node, copy-on-write at
the record-file seam (see [Versions and history](../guide/versions)). The
present and its patches — `applyPatches()`, `compact()` — are the core's,
and so is the `commit` event the undo subpath stands on. Without the plugin
those methods throw `PLUGIN_MISSING`, `stats().tags` is `null`, and a
directory that holds tags is refused at `open()`: its copies would not be
kept.

## Telemetry (subpath)

```js
const { telemetry, createTelemetry } = require('@alexify/syncom/telemetry');
```

`telemetry` is the plugin: `open({ plugins: [telemetry], telemetry })` adapts
`{ api }` (the `@opentelemetry/api` module) or `{ tracer, meter }` into the
writer the engine records through (see [OpenTelemetry](../guide/telemetry)).
`createTelemetry(options)` builds that writer by hand — for an `OpLog` opened
on its own, or to give `open({ telemetry })` as it is, which the core takes
without the plugin (duck-typed: `enabled`, `withSpan`); nothing usable is the
frozen disabled writer, whose `withSpan` still runs its callback. Without the
plugin an api or a tracer given to `open()` is `PLUGIN_MISSING`.

## Backends

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
| `open({ fsi })` | Any object with the five functions; the storage, its log, chain, keys and registry all go through it. `storage.fsi` is what was given (wrapped when `durable`) |
| `open({ durable: true })` | Every write is followed by the backend's `sync`; a backend without one (OPFS, memory) logs `durable.noop` at debug |
| `create(dir, file, content)` *(optional)* | Exclusive create (`EEXIST` when the file is there) — `node:fs` and the memory backend have it; the directory lock uses it to make a race deterministic |
| `isFsi(value)` | Whether `value` has the five functions |
| `memory()` (`@alexify/syncom/memory`) | A backend in memory: `size`, `dump()`, the exclusive `create`; two storages opened over one share it |
| `layered(layers, { write, fill, queue }?)` (`@alexify/syncom/layered`) | One backend over several: a read is the first hit top down, filled upward; a write lands on every layer in order — `'through'` (default) or `'back'` from a queue the top answers ahead of; `flush()`, `close()`, `pending`, `layers`; `create` is exclusive across the layers — see [Backends](../guide/backends#layers) |
| `new OpLog(base, { fsi })`, `loadKeys(base, { fsi })` (`/encryption`), `loadSigningKeys(base, { fsi })` (`/signing`), `new Blockchain(base, { fsi })` (`/chain`) | The pieces take the backend too |
| `atRest(fsi, options)` (`/encryption`) | A wrapper: every file through it is ciphertext under one key — see [Encryption](#encryption-subpath) |

`@alexify/syncom/idb` is the IndexedDB backend: `createIdbFsi({ name, store,
indexedDB }?)` returns an fsi over one object store, with a `close()` of its
own (see [Browser](../guide/browser)).

## Plugins

### `createPlugins(modules)`

The registry one `open({ plugins })` builds, frozen: `names`, `rank` (every
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
cursor of `query`, the tags of `versions` — or once it is open (the manager
of `sync`), and what the options ask for and no plugin provides is refused at
`open()` the same way: `sync.signatures: 'require'` without `signing`,
`chain: true` without `chain`, `encrypted: true` without `encryption` (and a
per-call `{ encrypted: true }` at the call), `schema` or `validator` without
`schema`, an OpenTelemetry api or tracer without `telemetry`, a directory
that holds tags without `versions`. Without them the node id is what
`getId` mints, ops go unsigned and unchecked, no block is written,
`validate()` is `NO_CHAIN` and `storage.sync` is `PLUGIN_MISSING`.
`storage.plugins` lists them all.

## All (subpath)

```js
const { open, Storage, applyOp, mergeEntry, text, tree, signing, chain, encryption, sync, schema, telemetry, query, versions, PLUGINS } = require('@alexify/syncom/all');
```

Everything the root and the `/signing`, `/chain`, `/encryption`, `/memory`,
`/layered`, `/sync`, `/schema`, `/telemetry`, `/query` and `/versions`
subpaths export, plus `open()`/`Storage` with every shipped plugin registered
ahead of the caller's (`text`, `tree`, `signing`, `chain`, `encryption`,
`sync`, `schema`, `telemetry`, `query`, `versions`; a plugin given twice is
given once), `applyOp`/`mergeEntry` folding under the same
registry, the plugins themselves and `PLUGINS`, the list. The API of the
package before it was taken apart into blocks: what the tests and the
examples open.

## Text (subpath)

```js
const { text } = require('@alexify/syncom/text');
const storage = await open({ plugins: [text] });
```

The `list` and `text` kinds: the sequence engine (Fugue runs, run-length
content, marks, cursors) and the methods it adds — `splice`, `push`,
`updateText`, `mark`, `unmark`, `unmarkById`, `spans`, `cursor`, `index`,
`setAt`, `move` (see [Lists, text and trees](../guide/lists)). Patches of
`splice` and `mark`, `migrate()` of the two kinds and `compact()`'s marks are
its too.

## Tree (subpath)

```js
const { tree } = require('@alexify/syncom/tree');
const storage = await open({ plugins: [tree] });
```

The `tree` kind: a movable tree per field and `treeMove`, `treeRemove`; the
`treeMove`/`treeRemove` patches and `migrate()` of trees.

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
event and applied through `applyPatches()` — see [Undo and
redo](../guide/versions#undo-and-redo). Off the main entry; its patch
vocabulary, Myers and Emitter are the core's. `UndoManager` is the class
`createUndo()` builds, exported too.

| Member | Notes |
| --- | --- |
| `createUndo(storage, { mergeInterval = 500, limit = 100, scope, exclude, actor, trackedSources, records, paths, onPush, onPop }?)` | `UndoManager` — commits within `mergeInterval` ms of a step's first make one step (a [transaction](../guide/storage#transactions)'s commits one whatever the interval), `limit` steps are kept, `scope` keeps to one scope's ops (`'*'` the global one), `exclude(op)` leaves ops out, `actor` is who the undo's ops say made them; `trackedSources` keeps to commits whose `source` (a transaction's, a `Record`'s save) is one of them, `records` to these ids (or a predicate on the id), `paths` to these fields and what hangs under them (a step's inverse keeps to them; a whole-record change is then not tracked); `onPush`/`onPop` are the `push`/`pop` listeners; holds the log from its oldest step (`log.pins`); stops itself on `close()`; a wrong option is a `TypeError` |
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
| `on('change' \| 'update', fn)` | `change` `({ added, updated, removed })` the nodes whose state came, changed, went (an expiry included); `update` `(update)` this node's state to send — what `storage.sync.presence(instance)` carries |

## Inspect (subpath)

`@alexify/syncom/inspect` — a record's anatomy and an anonymized copy. See [Devtools](../guide/devtools).

| Member | Notes |
| --- | --- |
| `inspect(storage, id)` | `Promise<Inspection>` — `{ id, present, encrypted, alive, data, reading, base, deleted, purged, v, fields, log }`: the data in the op model's terms and the composed reading (lens and hooks aside), the reset stamps, every field with its `kind`, whether it is `reachable` in the reading and the kind's counts and stamps (a register's `stamp`, a counter's `sums`, a set's `elements`/`live`, a block's `runs`/`cuts`/`ext`/`pos`/`vals`/`marks` or `nodes`/`moves`), and the record's retained log entries (`seq`, `eventId`, `type`, `origin`, `stream`, `ts`, `scope`, `field`, `actor`, `message`, `signed`, `skipped`, `scrubbed`); nothing written; `INVALID_ID` for an id that is none |
| `anonymize(value, { salt = '', keys = false }?)` | A copy of any JSON value with every string replaced by a stable hash of it under `salt` (`~` and eight hex digits; the same string reads the same throughout), keys too when `keys` — numbers, booleans and nulls as they are; a value JSON cannot carry is a `TypeError` |

## Editor (subpath)

`@alexify/syncom/editor` — the editor-agnostic binding every editor adapter
builds on. See [Editors](../guide/editors).

| Member | Notes |
| --- | --- |
| `createTextBinding(storage, id, path, adapter, { source, onReset, onError }?)` | Binds an editor, through an adapter (`setContents(ops)`, `updateContents(delta)`, `onChange(listener)`), to text field `path` of record `id`: the editor's edits reach the field as one transaction each — refused as `STALE` and rebased when a peer's edit landed first — and the field's changes reach the editor as deltas, rebased over what it holds beyond the field. `{ id, field, source, ready, shadow, pending, flush(), stop() }`; a reset or the record gone reloads the editor and drops what was not sent (`onReset`) |
| `compose(a, b)`, `transform(a, b, priority?)`, `transformIndex(index, delta, priority?)`, `applyToText(text, delta)` | Deltas (Quill's form): the two as one; `b` rewritten to apply after `a` (with `priority`, `a`'s insert first at a tie); where an index is once a delta has applied; a text once a delta has applied (an embed slot as U+FFFC) |
| `spansToDelta(spans)`, `deltaToSpans(ops)`, `spansToBlocks(spans)`, `blocksToSpans(blocks)` | A reading as a document delta and back; typed spans cut at the block markers (what `blocks()` reads) and back |
| `diffSpans(before, after)`, `diffBlocks(before, after)` | The delta that takes one reading to another — cuts and inserts, a marker changed as `{ retain: 1, attributes: { embed } }`, marks changed over what stays — for `applyDelta()` |
| `selectionToTokens(storage, id, path, { anchor, head? })`, `tokensToSelection(storage, tokens)` | A selection as cursor tokens `{ id, field, anchor, head }` that survive the edits around it, and back to indices (`null` once a place is gone) |
| `presenceCursors(presence, storage, id, path, { key }?)` | The cursors a presence room holds on the field — each state's `key` (`cursor`) as tokens — resolved: `[{ node, state, anchor, head }]` |

## Branch (subpath)

```js
import { branch, merge, branchInfo, drop } from '@alexify/syncom/branch';
```

A storage forked from another and merged back — see
[Branches](../guide/versions#branches). Off the main entry; opens the branch
through the parent's own constructor, so it bundles no engine.

| Function | Returns | Notes |
| --- | --- | --- |
| `branch(parent, { path, from?: { tag } \| { at }, ...options })` | `Promise<Storage>` | A storage at `path` — a new identity — standing at the parent's state, or at the tag; opened with `options` (`fsi` the parent's unless given; `sync` gets `retention: { ops: 0 }` and `autoStart: false`); writes `branch.json`; rejects with `BRANCH_EXISTS` for a path that holds a `branch.json` or any other file (another storage is never taken over), `TAG_NOT_FOUND` for a tag the parent has not, `HISTORY_GONE` for a `from.at` version its log no longer gives exactly (`branchInfo().forkedAt.at` keeps the version as given); a fork that fails leaves nothing behind |
| `merge(source, { into })` | `Promise<{ ops, pages, joined }>` | Hands `into` the ops it lacks through `applyRemote`, in pages — of every stream the source holds; `joined: true` when the source's log no longer held what `into` needs of any of them (a third node's included) and its state was joined instead, never a gap. Either way round; a storage into itself is a `TypeError` |
| `branchInfo(storage)` | `Promise<BranchInfo \| null>` | `{ parent, forkedAt: { eventId, vector, ts, tag }, createdAt }` from the directory's `branch.json`, or `null`; rejects with `CORRUPT` when the file cannot be read |
| `drop(storage)` | `Promise<void>` | Closes the branch and removes its files (the directories stay); a storage with no `branch.json` is refused with a `TypeError`, an unreadable one with `CORRUPT` — this is the one call that deletes data, and it takes only what `branch()` made |

## Search (subpath)

```js
const { createSearch, normalize, trigrams } = require('@alexify/syncom/search');
```

| Export | Notes |
| --- | --- |
| `createSearch({ minOverlap }?)` | For `open({ search })`: a function that makes a fresh trigram index per searchable entity. `minOverlap` (0 to 1, default 0.3) is the share of a query's distinct trigrams a record must hold to match; anything else is a `TypeError` |
| `normalize(text)` | What the index sees: decomposed, combining marks stripped, lower case, letters and digits only, one space between words |
| `trigrams(text)` | The per-word, space-padded trigrams of the normalized text |

An index is a `TextIndex` — `put(id, text)`, `remove(id)`, `query(text)` →
`[{ id, score }]`, every match, best first, ties by id — plus `size`, the
records it holds. Any object with the three methods can stand in for it. The
ranking and the costs are in [Full-text search](../guide/query#full-text-search).

## wrpc adapter

```js
const { createWrpcLink, isSyncLink, SYNC_INTROSPECTION } = require('@alexify/syncom/wrpc');
```

`createWrpcLink(client, { unit = 'syncom' }?)` wraps a `WrpcClient` into a
[link](../guide/sync#the-link-contract); see [wrpc transport](../guide/wrpc).
`SYNC_INTROSPECTION` is what the adapter feeds `client.use()` (under `unit`), so
the four procedures exist on `client.api` without a `load()`.
