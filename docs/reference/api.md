# API reference

Everything below is exported from the package root. The browser build exports
the same names — see [Browser](../guide/browser) for the three signatures that
differ. The wrpc adapter is a separate subpath, [`@alexify/syncom/wrpc`](#wrpc-adapter).

```js
const syncom = require('@alexify/syncom');
```

## Storage

### `open(options?)`

Returns `Promise<Storage>`. Options: `path` (default `'syncom'`), `name`
(alias for `path`), `schema`, `getId`, `logger`, `encrypted`, `sync` (see
[Sync options](../guide/sync#options)).

### `Storage`

`await new Storage(options)` — `open()` is the shorthand. Extends `Emitter`.

| Method | Returns | Notes |
| --- | --- | --- |
| `insert(data, options?)` | `Promise<string>` | Generates an id via `getId` (a UUID by default) and writes |
| `get(id)` | `Promise<unknown>` | `null` when absent or deleted; verifies against the chain |
| `has(id)` | `Promise<boolean>` | `false` for a tombstone |
| `list()` | `Promise<string[]>` | Every live id |
| `set(id, data, options?)` | `Promise<void>` | Replaces the record (a `write` op) |
| `update(id, delta)` | `Promise<void>` | Sets the listed fields (a `set` op); throws if absent, or on a counter field |
| `inc(id, key, value = 1)` | `Promise<void>` | Adds to a counter field (an `inc` op); throws on a register field |
| `swap(id, changes, prev)` | `Promise<boolean>` | CAS — `false`, and no write, on mismatch |
| `delete(id)` | `Promise<void>` | Leaves a tombstone |
| `record(id)` | `Promise<Record>` | Cached per id |
| `saveData(id, data, options?)` | `Promise<void>` | `{ encrypted: true }` seals the record for this node only |
| `loadData(id)` | `Promise<unknown>` | Alias of `get()`; throws if the record no longer matches its block |
| `validate(options?)` | `Promise<boolean>` | `{ last, from }`; no argument walks the whole chain |
| `validate(id, data, blockHash)` | `Promise<boolean>` | One record against its block |
| `getCachedData(id)` | `unknown \| null` | Synchronous cache peek |
| `hasRecord(id)` | `boolean` | Whether the id is known to the cache |
| `applyRemote(ops, { via, scopes }?)` | `Promise<{ applied, duplicates, gaps }>` | Applies a peer's ops, in order per origin |
| `snapshot({ cursor, limit, scopes }?)` | `Promise<{ records, cursor, eventId, vector }>` | One page of state, tombstones included |
| `mergeSnapshot(records, { via, from }?)` | `Promise<void>` | Joins a page (as `merge` ops of this node) |
| `adoptVector(vector, { via, from }?)` | `Promise<SyncOp \| null>` | Records what a joined snapshot covers (an `advance` op) |
| `close()` | `Promise<void>` | Stops sync and seals the log; further writes are refused |

Properties: `schema`, `sync`, `nodeId`, `path`, `log`, `vector`, `logger`.
Statics: `Storage.Collection`, `Storage.Record`, `Storage.generateId()` — the
default `getId`, synchronous in both halves.

Events: `change` `(op, via)` for every op applied here (`via` is `null` for a
local write, otherwise the link it came from); `error` for a peer's op refused
by the register/counter rule.

### `Record`

Extends `Emitter`. Emits `update` with `(data, delta)` — on a staged
assignment, and when the record changes in storage (`null` data once deleted).

`id`, `data()`, `delta()`, `save()`, `inc(key, value?)`, `delete()`, plus a
live property per field of the loaded object.

### `Collection`

Created per schema entity and exposed as `storage.<EntityName>`.

`name`, `insert(data)`, `get(id)`, `update(id, delta)`, `delete(id)`,
`record(id)`.

## Sync

### `SyncManager`

`storage.sync`; `await new SyncManager(storage, options)` builds one by hand.
Extends `Emitter`. See [Sync](../guide/sync).

| Method | Returns | Notes |
| --- | --- | --- |
| `addNode({ url, token?, scopes? })` | `Promise<void>` | Registers a peer to dial; dials it at once when started |
| `removeNode(url)` | `Promise<void>` | Hangs up too |
| `enableNode(url, enabled = true)` | `Promise<void>` | Keep a node without dialing it |
| `listNodes()` | `Node[]` | `{ url, token, scopes, enabled, lastSync, cursor, remote }` |
| `start()` | `Promise<void>` | Dials every enabled node; needs `sync.connect` |
| `stop()` | `Promise<void>` | Closes every link |
| `sync(url?)` | `Promise<Array<{ url, pushed }>>` | Pushes what the peers lack now |
| `peers()` | `Array<{ url, node, connected, subscribed, cursor, lastSync, pending }>` | Live view |
| `unit({ access, authorize, tracked, pageSize, pageBytes }?)` | router unit | The procedures a host mounts: `hello`, `push`, `snapshot`, `changes` |

Properties: `storage`, `started`. Events: `peer`, `sync`, `bootstrap`, `error`.

### `isSyncLink(value)`

Structural check for the [link contract](../guide/sync#the-link-contract).

## Operation log and model

### `OpLog`

`await new OpLog(basePath, { rollAfter, retention, logger })` — `storage.log`
is the one you want.

| Member | Notes |
| --- | --- |
| `epoch`, `floor`, `next`, `vector`, `length`, `lastEventId` | See [The log](../guide/sync#the-log) |
| `append(ops)` | `Promise<LogEntry[]>` — entries with their seqs, once on disk |
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

## Contracts

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

## Filesystem interface

Backed by `node:fs/promises` on the server and OPFS in the browser.

`read(dir, file)` → `Promise<string>`, `write(dir, file, content)`,
`exists(dir, file)` → `Promise<boolean>`, `remove(dir, file)`,
`list(dir)` → `Promise<string[]>` (file names, sorted; an absent directory is
empty).

`write` creates the directory; `remove` is a no-op when the file is absent.

## wrpc adapter

```js
const { createWrpcLink, isSyncLink, SYNC_INTROSPECTION } = require('@alexify/syncom/wrpc');
```

`createWrpcLink(client, { unit = 'syncom' }?)` wraps a `WrpcClient` into a
[link](../guide/sync#the-link-contract); see [wrpc transport](../guide/wrpc).
