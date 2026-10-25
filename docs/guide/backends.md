# Backends

Everything a storage persists — records, the operation log, the chain, the
keys, the peer registry, the catalog, the tags — goes through one small contract: an
**fsi**, five functions over "a directory and a file name". The platform's
own is the default; any other goes in through `open({ fsi })`.

| Function | Meaning |
| --- | --- |
| `read(dir, name)` | `Promise<string>`; a missing file rejects (`code: 'ENOENT'` or `name: 'NotFoundError'`) |
| `write(dir, name, content, options?)` | Creates the directory; whole-file, no rename. `options.mode` is a permissions hint (the private keys ask for `0o600`); an adapter without permissions ignores it |
| `exists(dir, name)` | `Promise<boolean>` |
| `remove(dir, name)` | A no-op when absent |
| `list(dir)` | File names, sorted; an absent directory is `[]` |
| `sync(dir, name)` *(optional)* | fsync — what `durable: true` calls after every write |
| `create(dir, name, content)` *(optional)* | Exclusive create: rejects with `code: 'EEXIST'` when the file is there; what the directory lock uses when present (`node:fs` and the memory backend have it) |

`isFsi(value)` tells whether an object has the five. The check runs at
`open()`, naming the method that is missing, and the storage never closes a
backend it was handed — two storages may share one.

## What ships

| Backend | Where | How |
| --- | --- | --- |
| `node:fs/promises` | Node.js | The default under Node; `sync` is `fsync` |
| OPFS | The browser | The default in a browser bundle (`fsi.browser.js`); durable when a writable closes, no `sync` |
| `@alexify/syncom/idb` | The browser | `createIdbFsi({ name, store, indexedDB })` — see [Browser](./browser#opfs-or-indexeddb) |
| `@alexify/syncom/memory` | Anywhere | `memory()` — a Map; nothing survives the process |
| `@alexify/syncom/layered` | Anywhere | `layered([top, …, bottom], options)` — one backend over several, a multi-level cache; see [Layers](#layers) |
| `@alexify/syncom/encryption` | Anywhere | `atRest(fsi, options)` — every file through it encrypted; see [Encrypted at rest](#encrypted-at-rest) |

```js
const { open } = require('@alexify/syncom');
const { memory } = require('@alexify/syncom/memory');

const fsi = memory();
const storage = await open({ path: 'app', fsi });     // nothing touches the disk
await storage.insert({ a: 1 });
fsi.size;                                              // 6 files: lock, node.json, log, data, catalog
Object.keys(fsi.dump());                               // ['app/lock.json', 'app/log/index.json', 'app/node.json', …]
```

The memory backend is what a test, a server-side render, or a benchmark
wants; two storages opened over one of it with different `path`s are a
mesh in one process, which is how the sync-engine suite runs.

```js
import { open } from '@alexify/syncom';
import { createIdbFsi } from '@alexify/syncom/idb';

const idb = createIdbFsi({ name: 'app' });
const storage = await open({ path: 'data', fsi: idb });
// …
await storage.close();
await idb.close();                                     // the backend's own
```

## Layers

`layered()` from `@alexify/syncom/layered` makes one backend of several — a
memory layer over the disk, the disk over a remote store — that reads as a
multi-level cache and writes to every layer in list order:

```js
const { open } = require('@alexify/syncom');
const { memory } = require('@alexify/syncom/memory');
const { layered } = require('@alexify/syncom/layered');
const disk = require('@alexify/syncom'); // read, write, exists, remove, list: the platform's own

const fsi = layered([memory(), disk], { write: 'back' });
const storage = await open({ path: 'data', fsi });
// … every read is answered from memory once seen; every write lands in
// memory first and on the disk from the queue
await storage.close();
await fsi.flush(); // what the queue still holds
```

- A **read** is the first layer that has the file, top down; with `fill`
  (the default) the content is copied into every layer above it, so the next
  read is a hit at the top. `exists` is the first hit too; `list` is the
  union of the layers' names.
- A **write** or a removal lands on every layer, top to bottom. Under
  `write: 'through'` (the default) the call resolves when the last layer has
  it — durability is the bottom's. Under `write: 'back'` it resolves when the
  first layer has it, and the lower layers are written from a queue, one call
  at a time, at most `queue` calls waiting (1024 by default; the next write
  waits for room). `flush()` awaits the queue and rejects with the first
  queued call that failed; `close()` flushes and closes every layer that has
  a `close()` (the IndexedDB one). What the queue holds is lost with the
  process — the window is the queue — so `'back'` is for a node that
  answers from memory and can afford to replay, not for a server of record.
- Under `'back'` nothing stale is ever read from below: an operation that
  would consult a lower layer — a read that misses the top, `exists`,
  `list`, `create`, `sync` — first drains the queue. A read that hits the
  top never waits.
- `create` — the lock's exclusive create — is refused when **any** layer has
  the file: a `lock.json` on the disk is a lock whatever the memory above it
  holds. `sync` reaches every layer that has one, so `durable` reaches the
  disk.

The layers are any adapters — `layered([memory(), createIdbFsi()])` in the
browser, `atRest(layered([memory(), disk]), { key })` for a cache over an
encrypted disk — and a storage opened over the bottom alone reads what the
stack wrote.

## Encrypted at rest

`atRest()` from `@alexify/syncom/encryption` wraps any backend so that every
file written through it — the records, the log, the catalog, the tags,
`node.json`, the lock, the keys — is AES-256-GCM ciphertext under one key,
and reads decrypt on the way back. The storage is none the wiser: the same
directory opens over the wrapper with the key and over the bare backend not
at all.

```js
const { open } = require('@alexify/syncom');
const { atRest } = require('@alexify/syncom/encryption');

// a key the application holds: 32 bytes, or a Web Crypto AES-GCM CryptoKey
const storage = await open({ path: 'data', fsi: atRest(fsi, { key }) });

// or a password: the key is derived by PBKDF2-SHA-256 under a salt the
// application keeps (8 characters or more), 600 000 rounds by default
const vault = await open({ path: 'data', fsi: atRest(fsi, { password, salt }) });
```

The key is never written. A file that is not the key's is refused as
`DECRYPT_FAILED` with a `reason` — `'key'` (another key, or a torn
ciphertext), `'plain'` (a file that was never encrypted), `'torn'` (not
base64) — and the first such file fails `open()`. `exists`, `remove`, `list`,
`sync` and `create` pass through, so a lock and a `durable` open work as they
do on the bare backend; the wrapper composes with any adapter, the IndexedDB
one included. Sealed records (`encrypted: true`) are the other block of the
same subpath: one record for this node's key, outside the log — the two are
independent.

## Your own

An adapter is the five functions over whatever holds bytes — a `Map`, a
key-value store, S3 per node, a Capacitor filesystem on mobile. Two things
the engine relies on: `write` is whole-file and visible to the next `read`
once it resolves, and `list` names files only, sorted. `tests/suites/fsi.js`
is the contract as a test — run it against yours.

## Durability

Files are written with the platform's default durability. `open({ durable:
true })` follows every write with the backend's `sync`; on `node:fs` that is
an fsync per file — the log batch, the chain block, the record — and the
price is the write latency of the disk. A backend without `sync` (OPFS,
IndexedDB, memory) is as durable as it is, and `durable` logs a debug line
and does nothing. What a crash can tear is the newest, unannounced batch:
the log is written before the record, a reopen replays its unsealed tail,
and a torn open file is dropped before anyone was told of it. A record file
torn the same way reads as `INTEGRITY` until `repair(id)` rebuilds it.

`open({ defer: ms })` trades the record files' timing for fewer writes: a local
write's record file and chain block wait up to `ms` (one timer for all of
them), so the writes of one record within the window land as one file, and
everything due lands under one block. The log append is not deferred — a crash before the flush replays
the batch at the next open, as after a failed file write — and `tag()` and
`close()` flush first. It is `0`, off, by default.

The log append is the commit point. A backend that fails after it — a full
disk, a browser's `QuotaExceededError` on the record file or the chain block
— does not undo the write: it resolves, the op replicates, the record is
held in memory so reads see it, and the storage's `error` event carries
`code: 'UNPERSISTED'`. The batch stays unapplied in the log, and the next
open replays it onto the files.

## One instance per directory

`open()` holds the directory — the Web Locks API in a browser, a `lock.json`
with the pid elsewhere — and a second `open()` of it rejects with
`code: 'LOCKED'`; `lock: 'wait'` waits, `lock: false` leaves the
coordination to you. See
[One instance per directory](./storage#one-instance-per-directory) for why,
and for what two browser tabs should do.
