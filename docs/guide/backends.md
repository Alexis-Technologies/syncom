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

## The four that ship

| Backend | Where | How |
| --- | --- | --- |
| `node:fs/promises` | Node.js | The default under Node; `sync` is `fsync` |
| OPFS | The browser | The default in a browser bundle (`fsi.browser.js`); durable when a writable closes, no `sync` |
| `@alexify/syncom/idb` | The browser | `createIdbFsi({ name, store, indexedDB })` — see [Browser](./browser#opfs-or-indexeddb) |
| `createMemoryFsi()` | Anywhere | A Map; nothing survives the process |

```js
const { open, createMemoryFsi } = require('@alexify/syncom');

const fsi = createMemoryFsi();
const storage = await open({ path: 'app', fsi });     // nothing touches the disk
await storage.insert({ a: 1 });
fsi.size;                                              // 13 files: keys, chain, log, data, catalog, lock…
Object.keys(fsi.dump());                               // ['app/lock.json', 'app/keys/public.pem', …]
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
