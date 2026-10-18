# API reference

Everything below is exported from the package root, except two subpaths: the
wrpc adapter, [`@alexify/syncom/wrpc`](#wrpc-adapter), and the smart contracts,
[`@alexify/syncom/contracts`](#contracts-subpath). The browser build exports
the same names — see [Browser](../guide/browser) for the three signatures that
differ.

```js
const syncom = require('@alexify/syncom');
```

## Storage

### `open(options?)`

Returns `Promise<Storage>`. Options: `path` (default `'syncom'`), `name`
(alias for `path`), `fsi` and `durable` (see [Backends](#backends)), `lock`
(`'fail'` | `'wait'` | `false` — see
[One instance per directory](../guide/storage#one-instance-per-directory)),
`cache`, `integrity` and `catalog` (see
[The catalog and the cache](../guide/storage#the-catalog-and-the-cache)),
`schema` and `validator` (see
[Collections](../guide/storage#collections)), `getId`, `logger`, `encrypted`,
`sync` (see [Sync options](../guide/sync#options)), `telemetry` (see
[OpenTelemetry](../guide/telemetry)), `hooks` (see
[Hooks and events](../guide/hooks)).

### `Storage`

`await new Storage(options)` — `open()` is the shorthand. Extends `Emitter`.

| Method | Returns | Notes |
| --- | --- | --- |
| `insert(data, options?)` | `Promise<string>` | Generates an id via `getId` (a UUID by default) and writes |
| `get(id)` | `Promise<unknown>` | `null` when absent or deleted; verifies against the chain |
| `has(id)` | `Promise<boolean>` | `false` for a tombstone |
| `list()` | `Promise<string[]>` | Every live id, sorted — from the catalog, no I/O |
| `check(entity, data)` | `Promise<unknown>` | Runs the entity's validator as a write would and returns its value; rejects with `ValidationError`; writes nothing |
| `migrate({ entities, batch }?)` | `Promise<{ migrated, counters }>` | Rewrites records of an older schema version through the lens; idempotent (see [Reading across versions](../guide/storage#reading-across-versions)) |
| `set(id, data, options?)` | `Promise<void>` | Replaces the record (a `write` op); keeps `$type` unless the data names the same |
| `update(id, delta)` | `Promise<void>` | Sets the listed fields (a `set` op); throws if absent, or on a counter field |
| `inc(id, key, value = 1)` | `Promise<void>` | Adds to a counter field (an `inc` op); throws on a register field |
| `swap(id, changes, prev)` | `Promise<boolean>` | CAS — `false`, and no write, on mismatch |
| `delete(id)` | `Promise<void>` | Leaves a tombstone |
| `record(id)` | `Promise<Record>` | Cached per id |
| `saveData(id, data, options?)` | `Promise<void>` | `{ encrypted: true }` seals the record for this node only |
| `loadData(id)` | `Promise<unknown>` | Alias of `get()`; throws if the record no longer matches its block |
| `validate(options?)` | `Promise<boolean>` | `{ last, from }`; no argument walks the whole chain |
| `validate(id, data, blockHash)` | `Promise<boolean>` | One record against its block |
| `getCachedData(id)` | `unknown \| null` | Synchronous cache peek, raw (no lens) |
| `hasRecord(id)` | `boolean` | Whether the id is a live record — from the catalog, no I/O |
| `applyRemote(ops, { via, scopes, peer }?)` | `Promise<{ applied, skipped, duplicates, gaps }>` | Applies a peer's ops, in order per origin; `peer` is `{ url, node }` for the hooks |
| `snapshot({ cursor, limit, scopes }?)` | `Promise<{ records, cursor, eventId, vector }>` | One page of state, tombstones included |
| `mergeSnapshot(records, { via, from }?)` | `Promise<void>` | Joins a page (as `merge` ops of this node) |
| `adoptVector(vector, { via, from }?)` | `Promise<SyncOp \| null>` | Records what a joined snapshot covers (an `advance` op) |
| `close()` | `Promise<void>` | Stops sync and seals the log; further writes are refused |

Properties: `schema`, `schemaInfo` (`{ version, hash, previous, held }`,
`null` without a schema — see [Schema versions](../guide/storage#schema-versions)),
`sync`, `nodeId`, `path`, `log`, `vector`, `logger`, `telemetry` (the writer
built from the option — opaque).
Statics: `Storage.Collection`, `Storage.Record`, `Storage.generateId()` — the
default `getId`, synchronous in both halves.

Events — listeners are contained, a throwing one is logged and never fails
the operation (see [Hooks and events](../guide/hooks#events)):

| Event | Payload | When |
| --- | --- | --- |
| `change` | `(op, via)` | Every op applied here; `via` is `null` for a local write, otherwise the link it came from |
| `apply` | `({ via, peer, ops, applied, skipped, duplicates, gaps })` | A peer's batch is durable |
| `error` | `(error)` with `error.op`, and `error.rejected` or `error.entity` + `error.issues` | A peer's op refused by the register/counter rule, or skipped as invalid under this node's schema |
| `schema` | `({ kind: 'drift', peer, version, hash, local })` / `({ kind: 'ahead', op, held })` | A peer runs this schema version with another snapshot hash (see [Schemas](../guide/sync#schemas)) / a peer's op is from a newer version, applied or held |
| `close` | — | After `close()` sealed the log |

Hooks (`open({ hooks })`): `beforeWrite`, `afterWrite`, `beforeRead`,
`afterRead`, `beforeApply`, `afterApply` — see
[Hooks and events](../guide/hooks).

### `Record`

Extends `Emitter`. Emits `update` with `(data, delta)` — on a staged
assignment, and when the record changes in storage (`null` data once deleted).

`id`, `data()`, `delta()`, `save()`, `inc(key, value?)`, `delete()`, plus a
live property per field of the loaded object.

### `Collection`

Created per schema entity and exposed as `storage.<EntityName>`.

`name`, `insert(data)`, `get(id)`, `set(id, data, options?)` (stamped as the
collection's), `update(id, delta)` (refuses a delta naming `$type`),
`delete(id)`, `record(id)`. Writes through a collection with a `schema` are
validated — see [Validation](../guide/storage#validation).

## Sync

### `SyncManager`

`storage.sync`; `await new SyncManager(storage, options)` builds one by hand.
Extends `Emitter`. See [Sync](../guide/sync).

| Method | Returns | Notes |
| --- | --- | --- |
| `addNode({ url, token?, scopes? })` | `Promise<void>` | Registers a peer to dial; dials it at once when started |
| `removeNode(url)` | `Promise<void>` | Hangs up too |
| `enableNode(url, enabled = true)` | `Promise<void>` | Keep a node without dialing it |
| `listNodes()` | `Node[]` | `{ url, token, scopes, enabled, lastSync, cursor, remote }`; `remote` is `{ id, epoch, schema }` after a hello |
| `start()` | `Promise<void>` | Dials every enabled node; needs `sync.connect` |
| `stop()` | `Promise<void>` | Closes every link |
| `sync(url?)` | `Promise<Array<{ url, pushed }>>` | Pushes what the peers lack now |
| `peers()` | `Array<{ url, node, connected, subscribed, cursor, lastSync, pending }>` | Live view |
| `unit({ access, authorize, tracked, pageSize, pageBytes }?)` | router unit | The procedures a host mounts: `hello`, `push`, `snapshot`, `changes` |

Properties: `storage`, `started`.

Events (contained, like the storage's): `peer` `({ url, connected, node?,
reconnected?, schema? })`, `sync` `({ url, pushed })` after a push and `({ url,
received, applied, skipped, duplicates, gaps })` after a received page,
`bootstrap` `({ url, records })`, `error` (with `.url`), `start`, `stop`,
`node` `({ url, action: 'add' | 'remove' | 'enable' | 'disable' })`, `connect`
`({ url })` once a link is accepted (before hello), and on the hosting side
`hello` `({ node, scopes, schema })` once a peer is authorized.

Hooks (`open({ sync: { hooks } })`): `beforeConnect`, `beforeBootstrap` — see
[Hooks and events](../guide/hooks#sync-hooks).

### `HookError`

What an operation rejects with when one of its hooks threw: `name`
`'HookError'`, `code` `'HOOK_FAILED'`, `hook` (the hook's name), `cause` (the
original error). Exported from the package root.

### `ValidationError`

What a write rejects with when the record would not pass its entity's
validator — nothing was stamped, logged or written: `name`
`'ValidationError'`, `code` `'VALIDATION_FAILED'`, `entity` (the collection),
`issues` (`[{ path, message, code? }]`), and `cause` when the validator threw
something of its own. Exported from the package root.

### `isSyncLink(value)`

Structural check for the [link contract](../guide/sync#the-link-contract).

## Operation log and model

### `OpLog`

`await new OpLog(basePath, { rollAfter, retention, logger, telemetry })` —
`storage.log` is the one you want.

| Member | Notes |
| --- | --- |
| `epoch`, `floor`, `next`, `vector`, `length`, `lastEventId` | See [The log](../guide/sync#the-log) |
| `append(ops, { skipped, held }?)` | `Promise<LogEntry[]>` — entries with their seqs, once on disk; `skipped` ops are flagged, `held` ones with the version they wait for |
| `held()` | `LogEntry[]` — the entries held for a newer schema version |
| `droppedHeld`, `resetDroppedHeld()` | Held entries compaction dropped since the last reset |
| `since(eventId, { scopes, limit }?)` | `LogEntry[]` after the id, or `null` when it cannot be resumed |
| `advance(vector)` | Adopts a vector (after a snapshot) |
| `tail()` | The unsealed entries a reopen replays |
| `flush()` | Seals the open files now |
| `close()` | Writes the index |

### `applyOp(entry, op)` / `mergeEntry(a, b)` / `isAlive(entry)`

The record-level model: apply one op to an entry (`{ entry, changed, delta,
rejected }`), join two entries, and whether an entry is a live record or a
tombstone. Pure functions; `entry` may be `null`.

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

`KeyPair` is `{ publicKey, privateKey }`, PEM-encoded RSA-2048. `encrypt`
returns a JSON envelope — AES-256-GCM under a fresh key, that key wrapped with
RSA-OAEP (SHA-256) — identical on both platforms. `loadKeys` reads
`public.pem` / `private.pem` from `basePath`, generating and writing them if
either is absent.

## Backends

A backend — an **fsi** — is five functions over "a directory and a file name":
`read(dir, file)` → `Promise<string>`, `write(dir, file, content)`,
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
| `isFsi(value)` | Whether `value` has the five functions |
| `createMemoryFsi()` | A backend in memory: `size`, `dump()`; two storages opened over one share it |
| `loadKeys(base, { fsi })`, `new Blockchain(base, { fsi })`, `new OpLog(base, { fsi })` | The pieces take the backend too |

`@alexify/syncom/idb` is the IndexedDB backend (see [Browser](../guide/browser)).

## wrpc adapter

```js
const { createWrpcLink, isSyncLink, SYNC_INTROSPECTION } = require('@alexify/syncom/wrpc');
```

`createWrpcLink(client, { unit = 'syncom' }?)` wraps a `WrpcClient` into a
[link](../guide/sync#the-link-contract); see [wrpc transport](../guide/wrpc).
