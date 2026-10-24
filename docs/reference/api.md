# API reference

Everything below is exported from the package root, except seven subpaths: the
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

Returns `Promise<Storage>`. Takes an options object only — `open('./dir')` is a
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
[Hooks and events](../guide/hooks)).

### `Storage`

`await new Storage(options)` — `open()` is the shorthand. Extends `Emitter`.

| Method | Returns | Notes |
| --- | --- | --- |
| `insert(data, options?)` | `Promise<string>` | Generates an id via `getId` (a UUID by default) and writes; rejects with `code: 'INVALID_ID'` when the generator mints one that is not a [valid id](../guide/storage#custom-identifiers) |
| `get(id, { at }?)` | `Promise<unknown>` | `null` when absent or deleted; verifies against the chain; a copy — editing it changes nothing. With `at` — an event id, a stamp (a number or a `Date`), `{ vector }` or `{ tag }` — the record at that version, folded from the log, or a tag's copy (see [Versions and history](../guide/versions)); rejects with `HISTORY_GONE` when the log cannot give it exactly, `INVALID_VERSION` for a malformed `at` or a seq not reached, `TAG_NOT_FOUND` for a tag this node has not, `ENCRYPTED` for an encrypted record (at a tag one reads as its data) |
| `tag(name)` | `Promise<Tag>` | Names the storage as it is now — `{ name, eventId, seq, ts, vector, createdAt }`, kept on this node as the catalog of the moment plus a copy of each record's file taken before its first change after the tag (see [Tags](../guide/versions#tags)); `name` is of the record-id form (a `TypeError` otherwise); deferred files land first. Rejects with `TAG_EXISTS`, `UNPERSISTED` while a record's file lags the log after a failed write, `CORRUPT` while `tags.json` is unreadable |
| `untag(name)` | `Promise<void>` | Drops a tag; the copies the next older tag needs move there; rejects with `TAG_NOT_FOUND` |
| `tags()` | `Tag[]` | The tags, oldest first — from memory |
| `at(name)` | `TagView` | The storage at a tag: its fields plus `get(id)` (the record as it was, through the lens and the read hooks with `at: { tag }`; `null` when it was not there), `has(id)` and `list()` (every live id then; promises — the tag's catalog is read at the view's first read), `collection(entity)` (`name`, `select()`, `count()`, `get()` as it was — `watch()` throws, no `$text`; an entity the schema has not is a `TypeError`) and `snapshot(options)` (pages like `snapshot()`, at the tag's position); throws `TAG_NOT_FOUND` |
| `diff(id, from?, to?)` | `Promise<Patch[]>` | The patches that turn the record at `from` into the record at `to` (the present when omitted), per field by kind — see [Diff and restore](../guide/versions#diff-and-restore); raw, through the lens, no read hooks; a text's marks are not diffed; rejects as `get(id, { at })` would, `ENCRYPTED` for an encrypted record |
| `applyPatches(id, patches, { actor, source }?)` | `Promise<number>` | Realizes patches as ops of this node's own in one turn of the mutation queue (`put`, `write`, `inc`, `add`, `remove` with `elements` — `own: true` for this node's adds alone — or exact `removals`, `splice`, `treeMove`, `treeRemove`, `delete`, `purge`); `source` rides on the `commit` events; resolves to how many ops. A patch is checked as the method of its name checks its arguments — the wrong shape is a `TypeError` with nothing minted — and every patch is first resolved and applied over a scratch record, so an index out of range, a kind clash, a cycle or a type change refuses the whole batch with nothing written; a hook or a validator that throws on a later op leaves the earlier ones committed |
| `restore(id, at, { actor, source }?)` | `Promise<number>` | Makes the record read as it did at `at` (required) with new ops that lead back — `diff(id, undefined, at)` applied; rejects as `diff()` would; lands whole or not at all (see `applyPatches`) |
| `compact(id, { actor, source }?)` | `Promise<number>` | Rewrites the record as the ops its reading takes today — a `write` of the registers, then one op per field of another kind: an `inc`, an `add`, one `splice` (a text or a list becomes one run), one `tree` move per node — so what lies under it goes by the reset rule here and on every peer, and `get()` and `spans()` read the same: a text's marks are laid again in the order they were made, with their expand rules, and a list or text over 1 048 576 elements is made again in several runs. It names every element anew, so the cursors into its lists and texts read `null` after, and a stacking mark has a new id; a list, text, set or tree that reads empty is left out. A peer's op stamped before the rewrite and arriving after it is dropped, as with any whole-record write. Resolves to how many ops; `0` for a record that is not there; `ENCRYPTED` for an encrypted one |
| `history(id, { limit = 50, before }?)` | `Promise<{ versions, complete, exact }>` | The record's past, newest first: `{ eventId, seq, ts, origin, actor, type, fields, data, scrubbed? }` per op this node applied, `data` the record after it through the lens and `afterRead` — run for the versions handed out alone; `limit` a positive integer or `Infinity`; `before` (an event id of this log — `HISTORY_GONE` `epoch` for another incarnation's) pages back to the versions older than it; `complete` when the page reaches the first op the node applied and nothing was dropped, `exact` when the versions are what the node held; rejects with `ENCRYPTED` for an encrypted record |
| `has(id)` | `Promise<boolean>` | `false` for a tombstone |
| `list()` | `Promise<string[]>` | Every live id, sorted — from the catalog, no I/O |
| `check(entity, data)` | `Promise<unknown>` | Runs the entity's validator as a write would and returns its value; rejects with `ValidationError`; writes nothing |
| `migrate({ entities, batch = 100, actor }?)` | `Promise<{ migrated, counters, sets, lists, texts, trees }>` | Rewrites records of an older schema version through the lens — a `write` of the view, then the counters and the sets added back, a list or a text as one run, a tree as one move per node (an empty one is dropped); idempotent; `actor` rides on the ops it writes; a `TypeError` without `open({ schema })` (see [Reading across versions](../guide/storage#reading-across-versions)) |
| `set(id, data, options?)` | `Promise<void>` | Replaces the record (a `write` op); keeps `$type` — data naming another is a `TypeError` with `code: 'TYPE_IMMUTABLE'`; rejects with `FIELD_KIND` for a field held by another kind than a register. Every writer rejects an invalid id with `TypeError` `code: 'INVALID_ID'` |
| `update(id, delta, { actor }?)` | `Promise<void>` | Sets the listed fields (a `set` op); rejects with `NOT_FOUND` when absent, `FIELD_KIND` on a counter, set, list, text or tree field |
| `inc(id, key, value = 1, { actor }?)` | `Promise<void>` | Adds to a counter field (an `inc` op); `FIELD_KIND` on a field of any other kind |
| `add(id, key, elements, { actor }?)` | `Promise<void>` | Adds JSON values to a set field (an `add` op); creates the field and the record when absent; `FIELD_KIND` on a field of any other kind |
| `remove(id, key, elements, { actor }?)` | `Promise<void>` | Removes from a set field the elements this node has seen added (a `remove` op; none seen: no op); `FIELD_KIND` on a field of any other kind |
| `splice(id, key, index, count = 0, content?, { actor }?)` | `Promise<void>` | Removes `count` elements at `index` of a list or text field and inserts `content` there (a `splice` op) — an array for a list, a string for a text; the first write decides the kind (see [Lists, text and trees](../guide/lists)). Creates the field and the record when absent; rejects with `OUT_OF_RANGE` past the length, `FIELD_KIND` on a register, counter, set or tree field, for a string on a list or an array on a text, or past a bound of the field |
| `push(id, key, content, { actor }?)` | `Promise<void>` | Appends to a list or text field — a `splice` at the end |
| `updateText(id, key, text, { actor }?)` | `Promise<number>` | Makes a text field read as `text`: diffed against the field inside the mutation queue (Myers, UTF-16 units), one `splice` per hunk, last first, in one turn of the queue; resolves to the number of ops. A difference deeper than a thousand edit steps is one op replacing the middle |
| `setAt(id, key, index, value, { actor }?)` | `Promise<void>` | Replaces the element at `index` of a list field (an `assign` op) — a register per element that follows it through a concurrent move; rejects with `OUT_OF_RANGE`, `FIELD_KIND` on a text and on the other kinds |
| `move(id, key, from, to, { actor }?)` | `Promise<void>` | Moves the element at `from` of a list field to `to`, its index once out (a `move` op); concurrent moves of one element leave it once, at the newer one's place; `from === to` is nothing; rejects with `OUT_OF_RANGE`, `FIELD_KIND` on a text and on the other kinds |
| `treeMove(id, key, node, parent = null, { after, before, actor }?)` | `Promise<void>` | Puts `node` of a tree field under `parent` (`null`: a root) — after sibling `after`, before sibling `before`, or last (a `tree` op); creates the node, the field and the record when absent. Two nodes moving concurrently so that each would hang under the other: the older move stands, the newer is kept without effect, on every node. `parent === node` is a `TypeError`; rejects with `CYCLE` for a parent under the node, `NOT_FOUND` for a sibling not under `parent`, `OUT_OF_RANGE` for a move that would reach below the 512 levels a tree reads or a place with no room left among its neighbours; a move to where the node already is makes no op; `FIELD_KIND` on the other kinds |
| `treeRemove(id, key, node, { actor }?)` | `Promise<void>` | Removes `node` of a tree field with everything under it — a `tree` op moving it under `$trash`; a node not known here is created there, so a concurrent creation lands removed; twice is nothing |
| `mark(id, key, start, end, name, value, { expand, many, actor }?)` | `Promise<string \| null>` | Marks visible range `[start, end)` of a text field with `name: value` (a `mark` op); `expand` (`'after'` by default, `'before'`, `'both'`, `'none'`) says whether text typed at the edges takes the style; per name the newest mark wins; `many: true` stacks with every other of its name. Resolves to the mark's id; rejects with `OUT_OF_RANGE`, `FIELD_KIND` on a list and on the other kinds |
| `unmark(id, key, start, end, name, { expand, actor }?)` | `Promise<void>` | Removes a style over a range: a null mark under the reversed expand rule, so the removal grows where the style would not |
| `unmarkById(id, key, markId, { actor }?)` | `Promise<void>` | Switches one mark off by its id (what `mark()` resolved to) — the only way for a `many` mark |
| `spans(id, key)` | `Promise<TextSpan[] \| null>` | The text field as runs of equal style, `[{ text, marks }]`; raw — no lens, no read hooks; `null` unless the field is a text |
| `cursor(id, key, index, { side }?)` | `Promise<string \| null>` | A cursor into a list or text field — a place that survives edits around it, before the element at `index` (`'before'`, the default) or after the one before it; `null` out of range or when the field is not a sequence |
| `index(id, key, cursor)` | `Promise<number \| null>` | Where a cursor is now; `null` once its place is gone (a reset) |
| `swap(id, changes, prev, { actor }?)` | `Promise<boolean>` | CAS, compared inside the mutation queue — `false`, and no write, on mismatch; rejects with `NOT_FOUND` when absent |
| `repair(id)` | `Promise<{ ops, alive }>` | Rebuilds a record whose file fails its integrity check from the log's entries of it (see [Repair](../guide/storage#repair)); rejects with `code: 'UNRECOVERABLE'` when the log holds no whole-record op for it |
| `delete(id, { actor }?)` | `Promise<void>` | Leaves a tombstone |
| `purge(id, { actor }?)` | `Promise<void>` | Forgets the record for good: a `purge` op and a scrub of its log entries, here and on every peer (see [Purge](../guide/storage#purge)) |
| `record(id)` | `Promise<Record>` | Cached per id |
| `saveData(id, data, options?)` | `Promise<void>` | `{ encrypted: true }` seals the record for this node only; `{ actor }` names the writer |
| `loadData(id)` | `Promise<unknown>` | Alias of `get()`; throws if the record no longer matches its block |
| `validate(options?)` | `Promise<boolean>` | `{ last, from }`; no argument walks the whole chain; rejects with `code: 'NO_CHAIN'` under `open({ chain: false })` |
| `validate(id, data, blockHash)` | `Promise<boolean>` | One record against its block |
| `getCachedData(id)` | `unknown \| null` | Synchronous cache peek, raw (no lens) |
| `hasRecord(id)` | `boolean` | Whether the id is a live record — from the catalog, no I/O |
| `stats()` | `{ closed, queue, cache: { size, max, pinned }, catalog: { entries, dirty }, tags: { count, corrupt }, held, deferred, log: { length, floor, next, epoch, segments, latestTs, droppedTs, pins }, chain: { tail } \| null, lock: { mode } \| null }` | The node's health, from memory — no I/O; `tags.corrupt` while `tags.json` could not be read; `held` records whose files lag the log — after a failed write, or waiting under `open({ defer })` — and `deferred` the latter alone; `log.pins` readers holding segments past retention |
| `applyRemote(ops, { via, scopes, peer, adoptFrom, bound }?)` | `Promise<{ applied, skipped, duplicates, gaps, malformed, unsigned, forged, outOfScope }>` | Applies a peer's ops, in order per origin; `peer` is `{ url, node }` for the hooks; `malformed` ops (shape, id, a stamp beyond `sync.maxSkew`) and ops refused for their signature (`forged`; `unsigned` under `sync.signatures: 'require'`) are counted and dropped; an `advance` is adopted only when its origin is `adoptFrom`; under `bound` (a host's push passes the peer's granted scopes) an op whose record is outside them, before or after it, is counted `outOfScope` and dropped |
| `snapshot({ cursor, limit, scopes }?)` | `Promise<{ records, cursor, eventId, vector }>` | One page of state, tombstones included |
| `mergeSnapshot(records, { via, from }?)` | `Promise<void>` | Joins a page (as `merge` ops of this node) |
| `adoptVector(vector, { via, from }?)` | `Promise<SyncOp \| null>` | Records what a joined snapshot covers (an `advance` op) |
| `close()` | `Promise<void>` | Stops sync, lands deferred files and seals the log; further writes are refused (`CLOSED`) |

Properties: `fsi` (the backend given to `open()`, wrapped when `durable`, or
the platform's), `schema`, `schemaInfo` (`{ version, hash, previous, held }`,
`null` without a schema — see [Schema versions](../guide/storage#schema-versions)),
`sync`, `nodeId` (this node's Ed25519 public key, base64url — what its ops are
verified against), `signatures` (`'verify'`, `'require'` or `false`), `path`,
`log`, `vector`, `logger` (the writer built from
`open({ logger })` — `debug`/`info`/`warn`/`error`), `telemetry` (the writer
built from the option — opaque).
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
`cursor(key, index, options?)`, `index(key, cursor)`,
`treeMove(key, node, parent?, { after, before, actor }?)`, `treeRemove(key, node, { actor }?)`,
`delete({ actor }?)`, plus a
live property per field of the loaded object.

### `Collection`

Created per schema entity and exposed as `storage.<EntityName>`; a name the
storage already answers to (`get`, `close`, `log`, `sync`…) is refused at
`open()` with a `TypeError`.

`name`, `insert(data, options?)` (resolves to the new record's `Record`),
`get(id, { at }?)` (null for a record of another collection),
`set(id, data, options?)` (stamped as the collection's),
`update(id, delta, { actor }?)` (refuses a delta naming `$type`),
`delete(id, { actor }?)`, `record(id)` — `update`, `delete` and `record`
reject with `NOT_FOUND` for a record of another collection —
`select(query?)` → a cursor, `count(query?)`.
Writes through a collection with a `schema` are validated — see
[Validation](../guide/storage#validation); `unique` keys are refused with a
`ValidationError` whose issue has `code: 'unique'` and `conflict`.

#### `Cursor`

`collection.select(query)` — see [Queries](../guide/query); `$text` in the
query searches the entity's `search` fields, best first unless ordered.

| Member | Notes |
| --- | --- |
| `order(field)`, `desc(field)` | Sort keys, in order; nothing first, then booleans, numbers, strings; stable |
| `limit(n)`, `offset(n)` | Applied after the sort |
| `filter(fn)` | A predicate over the loaded row |
| `projection(fields)` | The fields each row carries, plus `id` |
| `fetch()` | `Promise<QueryRow[]>` — `{ id, ...data }` as the record reads |
| `count()` | `Promise<number>` |
| `one()` | `Promise<QueryRow \| null>` |
| `watch(listener, { onError }?)` | Runs now and after every change to the collection; returns the stop function |
| `[Symbol.asyncIterator]` | `for await (const row of cursor)` |

## Sync

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
| `unit({ access, authorize, tracked, pageSize, pageBytes, limits, meta }?)` | router unit | The procedures a host mounts: `hello`, `push`, `snapshot`, `changes` — see [Hosting](../guide/sync#hosting) |

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
carries no code, except `INVALID_ID`, `TYPE_IMMUTABLE`, `INVALID_VERSION` and
`NO_CHAIN`, whose value is data or configuration (the rows below say "a
`TypeError`"). `HookError` and `ValidationError` are
`SyncomError`s. Exported from the package root; the union of codes is the
`SyncomErrorCode` type.

| Code | Raised by | Fields |
| --- | --- | --- |
| `CLOSED` | any write, `applyPatches()`, `tag()`/`untag()`, `repair()`, `applyRemote()`, `mergeSnapshot()` or `adoptVector()` after `close()` | — |
| `IN_HOOK` | a write issued from inside a write or apply hook (the `cause` of the `HookError` the operation rejects with) | — |
| `NOT_FOUND` | `update()`, `swap()` on a record that is absent, deleted or purged; a collection's `update()`, `delete()`, `record()` on a record of another collection; `treeMove()` with an `after`/`before` sibling not under the parent | none from `update()`/`swap()`; `id`, `entity` (the collection's) from a collection; `id`, `field`, `node` (the sibling) for a tree |
| `FIELD_KIND` | `update()`/`set()` on a counter, set, list, text or tree field, `inc()` on a register, set, list, text or tree field, `add()`/`remove()` on a register, counter, list, text or tree field, `splice()`/`push()`/`updateText()` on a register, counter, set or tree field (and a string on a list, an array on a text), `setAt()`/`move()` on anything but a list, `mark()`/`unmark()`/`unmarkById()` on anything but a text, `treeMove()`/`treeRemove()` on anything but a tree — the patches of `applyPatches()` alike; a list or text op past a bound of the field — pending work (`sync.pendingMax`, 4 096), a run (1 048 576 slots) or the field as a whole (4 194 304 slots; see [Costs and limits](../guide/lists#costs-and-limits)); an `inc()` that would take this node's sum of the counter past ±`Number.MAX_SAFE_INTEGER` | `field`, `kind` (`'register'`, `'counter'`, `'set'`, `'list'`, `'text'`, `'tree'` — or `'bound'`, with `detail` (`'pending'`, `'run'`, `'field'` or `'counter'`), `count` and `max`) |
| `OUT_OF_RANGE` | `splice()` past the length of a list or text field — the index, or the index plus the count; `setAt()`/`move()` at an index the list has not; `mark()`/`unmark()` over a range the text has not; `treeMove()` to a place that would read below the 512 levels a tree shows, or between neighbours with no room left for another fractional index | `id`, `field`, `index`, `count`, `length`; for a tree `node` and `depth`, `max`, or `reason: 'fi'`, `length`, `max` |
| `CYCLE` | `treeMove()` to a parent that hangs under the node — decided inside the mutation queue, against the tree as it is (the node itself as its parent is a `TypeError`) | `id`, `field`, `node`, `parent` |
| `HISTORY_GONE` | `get(id, { at })`, `diff()`, `restore()` for a version the log cannot give exactly, `history({ before })` with an event id of another incarnation: `reason` `'compacted'` (dropped entries the version depends on, or a cut before anything retained), `'scrubbed'` (a cut before a purge), `'merge'` (a stamp below a joined snapshot), `'epoch'` (an event id of another incarnation) | `id`, `reason` |
| `INVALID_VERSION` | `get(id, { at })`, `diff()`, `restore()` with a version of the wrong shape, or an event id this log has not reached; `history({ before })` with a malformed event id (a `TypeError`) | — |
| `TAG_EXISTS` | `tag()` of a name in use | `tag` |
| `TAG_NOT_FOUND` | `untag()`, `at()`, `get(id, { at: { tag } })`, `diff()`/`restore()` at `{ tag }` of a tag this node has not — or of one whose catalog could not be read when first used, which a tag view's reads (`has()`, `list()`, a collection's `get()`/`select()`/`count()`, `snapshot()`) find too (the tag is dropped then, with a `tags.dropped` warning) | `tag` |
| `BRANCH_EXISTS` | `branch()` (`@alexify/syncom/branch`) at a path that holds a `branch.json`, or any file — another storage, say — already: a branch opens in a new directory | `path` |
| `ENCRYPTED` | any op beyond a whole-record write — `inc()`, `add()`, `remove()`, `splice()`, `push()`, `updateText()`, `setAt()`, `move()`, `mark()`, `unmark()`, `unmarkById()`, `treeMove()`, `treeRemove()` — on an encrypted record; `get(id, { at })` (not at a tag), `history()`, `diff()`, `restore()`, `compact()` of one: it has no past in the log; `{ encrypted: true }` on a replicated record | — |
| `INTEGRITY` | a read (`get()`, `has()`, a cursor) or a write (it loads the record first) of a record whose file fails its chain block check, under `integrity: 'verify'`, or cannot be parsed at all (a file torn by a crash; `repair(id)` rebuilds it) | `id`, `cause` (the parse error) |
| `CORRUPT` | `open()` when `node.json`, `schema.json` or `.blockchain.json` cannot be read; `tag()` while `tags.json` cannot be read — the open went on without tags, kept the file as `tags.corrupt.json` and keeps the copies the tags would need under `tags/.pending/` until the file is repaired; `branchInfo()` and `drop()` (`@alexify/syncom/branch`) when `branch.json` cannot be read or is no branch file | `cause`; `file` from `tag()` |
| `DOWNGRADE` | `open()` with `ahead: 'hold'` and a schema version below the one the directory ran | — |
| `LOCKED` | `open()` while another instance holds the directory — at once under `lock: 'fail'`, after `lock.timeout` ms under `'wait'` | `path` |
| `KEYS_INCOMPLETE` | `open()`, `loadKeys()`, `loadSigningKeys()` when one file of a pair (RSA or signing) is missing | — |
| `IDENTITY_MISMATCH` | `open()` when `node.json` names another signing key than `keys/sign-public.pem` — a key pair replaced or restored under a signed identity | `id` (what `node.json` names), `key` (the pair on disk) |
| `BAD_SIGNATURE` | the storage's `error` event, once per page: a peer's op whose signature does not verify against its origin, or whose payload its digest does not match (`sync.signatures` `'verify'` or `'require'`) | `op` (the first refused), `count` |
| `UNSIGNED` | the storage's `error` event, once per page, under `sync.signatures: 'require'`: a peer's op with no signature, or whose origin is no signing key | `op`, `count` |
| `BAD_ENVELOPE` | `decrypt()` of a ciphertext this version does not read | — |
| `BLOCK_NOT_FOUND` | `Blockchain.readBlock()`, `SmartContract.load()` | `hash` |
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
| `SKEW`, `OP_UNREADABLE`, `OP_REFUSED`, `OP_INVALID` | the storage `error` event — see [`Storage`](#storage) | `op`, plus `rejected` / `entity` + `issues`; `cause` for `OP_UNREADABLE` |
| `INVALID_ID` | every writer, `repair()`, `diff()`, `applyPatches()`, `compact()`, `spans()`, `cursor()`, `index()` given an id that is not a [valid id](../guide/storage#custom-identifiers) — and `insert()` when `getId` mints one (a `TypeError`); `get()`, `has()` and `history()` answer as for an absent record | — |
| `TYPE_IMMUTABLE` | a local `set()`, `update()`, `swap()`, `record.save()` or patch whose data names another `$type` than the record's (a `TypeError`) | — |
| `NO_CHAIN` | `validate()` under `open({ chain: false })` (a `TypeError`) | — |
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

### `isSyncLink(value)`

Structural check for the [link contract](../guide/sync#the-link-contract).

### `isSharedLog(value)`

Structural check for the reserved `SharedLog` contract (`append`, `read`,
`parseId` — the shape of wrpc's `BrokerLog`): what a broker-backed hub mode
will take after this version. `open({ sync: { sharedLog } })` is refused.

## Operation log and model

### `OpLog`

`await new OpLog(basePath, { rollAfter, retention, logger, telemetry, fsi, sealApplied, onRoll })` —
`storage.log` is the one you want. With `sealApplied` (what the storage asks
for) a roll seals only the batches marked `applied`; `onRoll` is told
`{ sealed, dropped, floor, segments }` after every seal (the storage's `log`
event).

| Member | Notes |
| --- | --- |
| `epoch`, `floor`, `next`, `vector`, `length`, `lastEventId` | See [The log](../guide/sync#the-log) |
| `formatId(seq)`, `seqOf(key)` | The event id of a seq of this log; one key of the vector (`origin` or `origin@scope`) without copying it |
| `segments`, `retainedOps`, `latestTs`, `pins` | Sealed segments on disk; how many ops retention keeps at least (`Infinity` when no count bounds it); the newest stamp held since the open (what the clock is seeded from); how many `pin()` readers there are |
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

### `applyOp(entry, op, { pendingMax }?)` / `mergeEntry(a, b)` / `isAlive(entry)`

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

## Chain

### `Blockchain`

`await new Blockchain(basePath)`.

| Method | Returns |
| --- | --- |
| `addBlock(data)` | `Promise<string>` — the new tail hash |
| `readBlock(hash)` | `Promise<Block>` — throws if unknown |
| `writeBlock(block)` | `Promise<string>` |
| `writeChain()` | `Promise<void>` — persists the tail pointer |
| `validate(options?)` | `Promise<boolean>` — `{ last, from }`; an unknown `from` is `false` |

Properties: `path`, `tailHash`. A block is `{ prev, timestamp, data }`.

### `calculateHash(data)`

SHA-256 over `JSON.stringify(data)`, hex-encoded. Synchronous in Node.js,
`Promise<string>` in the browser.

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

## Crypto

| Function | Node.js | Browser |
| --- | --- | --- |
| `generateKeys()` | `Promise<KeyPair>` | `Promise<KeyPair>` |
| `loadKeys(basePath)` | `Promise<KeyPair>` | `Promise<KeyPair>` |
| `encrypt(data, publicKey)` | `string` | `Promise<string>` |
| `decrypt(data, privateKey)` | `unknown` | `Promise<unknown>` |
| `calculateHash(data)` | `string` | `Promise<string>` |
| `generateSigningKeys()` | `Promise<SigningKeyPair>` | `Promise<SigningKeyPair>` |
| `loadSigningKeys(basePath)` | `Promise<SigningKeyPair>` | `Promise<SigningKeyPair>` |
| `sign(message, privateKey)` | `string` | `Promise<string>` |
| `verify(message, signature, publicKey)` | `boolean` | `Promise<boolean>` |

`KeyPair` is `{ publicKey, privateKey }`, PEM-encoded RSA-2048. `encrypt`
returns a JSON envelope — AES-256-GCM under a fresh key, that key wrapped with
RSA-OAEP (SHA-256) — identical on both platforms. `loadKeys` reads
`public.pem` / `private.pem` from `basePath`, generating and writing them
(`private.pem` owner-only where the backend has permissions) when neither
exists, and rejecting with `code: 'KEYS_INCOMPLETE'` when only one does.

`SigningKeyPair` is `{ publicKey, privateKey, id }`: a PEM-encoded Ed25519 pair
and `id`, the raw public key in base64url (43 characters) — the node id of a
storage that loaded it. `loadSigningKeys` reads `sign-public.pem` /
`sign-private.pem` the way `loadKeys` reads the RSA pair. `sign` takes a
string (UTF-8) and gives the 64-byte signature in base64url; `verify` takes
the message, that signature and an `id`, and answers `false` — never a throw —
for an id that is no key or a signature of the wrong shape. The op-level use
of both is [Signatures](../guide/sync#signatures) in the Sync guide.

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
| `createMemoryFsi()` | A backend in memory: `size`, `dump()`; two storages opened over one share it |
| `loadKeys(base, { fsi })`, `new Blockchain(base, { fsi })`, `new OpLog(base, { fsi })` | The pieces take the backend too |

`@alexify/syncom/idb` is the IndexedDB backend: `createIdbFsi({ name, store,
indexedDB }?)` returns an fsi over one object store, with a `close()` of its
own (see [Browser](../guide/browser)).

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
| `createUndo(storage, { mergeInterval = 500, limit = 100, scope, exclude, actor }?)` | `UndoManager` — commits within `mergeInterval` ms of a step's first make one step, `limit` steps are kept, `scope` keeps to one scope's ops (`'*'` the global one), `exclude(op)` leaves ops out, `actor` is who the undo's ops say made them; holds the log from its oldest step (`log.pins`); stops itself on `close()`; a wrong option is a `TypeError` |
| `undo({ force }?)`, `redo({ force }?)` | `Promise<{ applied, skipped }>` — the newest step taken back (done again) as new ops; a field anyone else changed since is left alone and counted in `skipped`, a whole-record step with such a conflict is skipped whole, unless `force` |
| `canUndo`, `canRedo`, `size` | `boolean`, `boolean`, `{ undo, redo }` |
| `mark()` | Closes the current step: the next commit starts a new one |
| `clear()`, `stop()` | Drops the stacks; `stop()` also stops listening and lets the log compact |
| `on('push' \| 'pop' \| 'change', fn)` | An `Emitter`: `push` `({ direction: 'undo', records })` a step began or grew; `pop` `({ direction, applied, skipped })` a step was undone or redone; `change` `()` after anything that moved the stacks — those two, `clear()`, a purge forgetting its record |

## Branch (subpath)

```js
import { branch, merge, branchInfo, drop } from '@alexify/syncom/branch';
```

A storage forked from another and merged back — see
[Branches](../guide/versions#branches). Off the main entry; opens the branch
through the parent's own constructor, so it bundles no engine.

| Function | Returns | Notes |
| --- | --- | --- |
| `branch(parent, { path, from?: { tag }, ...options })` | `Promise<Storage>` | A storage at `path` — a new identity — standing at the parent's state, or at the tag; opened with `options` (`fsi` the parent's unless given; `sync` gets `retention: { ops: 0 }` and `autoStart: false`); writes `branch.json`; rejects with `BRANCH_EXISTS` for a path that holds a `branch.json` or any other file (another storage is never taken over), `TAG_NOT_FOUND` for a tag the parent has not; a fork that fails leaves nothing behind |
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
