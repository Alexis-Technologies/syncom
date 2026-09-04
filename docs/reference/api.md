# API reference

Everything below is exported from the package root. The browser build exports
the same names — see [Browser](../guide/browser) for the three signatures that
differ.

```js
const syncom = require('@alexify/syncom');
```

## Storage

### `open(options?)`

Returns `Promise<Storage>`. Options: `path` (default `'syncom'`), `name`
(alias for `path`), `schema`.

### `Storage`

`await new Storage(options)` — `open()` is the shorthand.

| Method | Returns | Notes |
| --- | --- | --- |
| `insert(data)` | `Promise<string>` | Generates a UUID and saves |
| `get(id)` | `Promise<unknown>` | `null` when absent; verifies against the chain |
| `has(id)` | `Promise<boolean>` | Filesystem check, no read |
| `set(id, data)` | `Promise<void>` | Replaces; emits `update` with the computed delta |
| `update(id, delta)` | `Promise<void>` | Shallow merge; throws if the record is absent |
| `swap(id, changes, prev)` | `Promise<boolean>` | CAS — `false`, and no write, on mismatch |
| `delete(id)` | `Promise<void>` | |
| `record(id)` | `Promise<Record>` | Cached per id |
| `saveData(id, data, options?)` | `Promise<void>` | `{ encrypted: true }` for RSA at rest |
| `loadData(id)` | `Promise<unknown>` | Throws if the record no longer matches its block |
| `validate(options?)` | `Promise<boolean>` | `{ last, from }`; no argument walks the whole chain |
| `validate(id, data, blockHash)` | `Promise<boolean>` | One record against its block |
| `getCachedData(id)` | `unknown \| null` | Synchronous cache peek |
| `hasRecord(id)` | `boolean` | Whether the id is known to the cache |
| `addUpdate(update)` | `void` | Appends to the pending update log |

Properties: `schema`, `sync`. Statics: `Storage.Collection`, `Storage.Record`.

### `Record`

Extends `Emitter`. Emits `update` with `(data, delta)`.

`id`, `data()`, `delta()`, `save()`, `delete()`, plus a live property per
field of the loaded object.

### `Collection`

Created per schema entity and exposed as `storage.<EntityName>`.

`name`, `insert(data)`, `get(id)`, `update(id, delta)`, `delete(id)`,
`record(id)`.

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
| `validate(options?)` | `Promise<boolean>` — `{ last, from }` |

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

`KeyPair` is `{ publicKey, privateKey }`, PEM-encoded RSA-2048.
`loadKeys` reads `public.pem` / `private.pem` from `basePath`, generating and
writing them if absent.

## Filesystem interface

Backed by `node:fs/promises` on the server and OPFS in the browser. All four
take a directory and a filename.

`read(dir, file)` → `Promise<string>`, `write(dir, file, content)`,
`exists(dir, file)` → `Promise<boolean>`, `remove(dir, file)`.

`write` creates the directory; `remove` is a no-op when the file is absent.

## Sync

### `SyncManager`

`await new SyncManager(basePath, storage, chain)` — `storage.sync` is the one
you want.

`addNode(nodeData)`, `removeNode(url)`, `listNodes()`, `start()`.

See [Sync](../guide/sync) — `start()` is a no-op today.
