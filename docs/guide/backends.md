# Engines and backends

Everything a database persists — records, the operation log, the chain, the
keys, the peer registry, the catalog, the tags — goes through its **engine**:
a factory of databases, each a set of stores. `createDatabase({ engine })` takes
one; without it the database opens through the **files engine** over a
backend — an **fsi**, five functions over "a directory and a file name" — the
platform's own by default, any other through `createDatabase({ fsi })`.

## Engines

```js
const { createDatabase, filesEngine, isEngine } = require('@alexify/syncom');
const { memory } = require('@alexify/syncom/memory');

const engine = filesEngine(memory());                 // what createDatabase({ fsi: memory() }) builds
const db = await createDatabase({ path: 'app', engine });
db.engine === engine;                                  // the engine given
db.fsi;                                                // the files engine's backend; null under a native engine
isEngine(engine);                                      // true
```

An engine has a `name`, `capabilities`, `open(path, { logger, durable })` and
`remove(path)` — every store of the database at `path`, gone. The database it
opens is a set of stores:

| Store | What it holds |
| --- | --- |
| `kv` | Small named texts by namespace (`''` the root) and key: `node.json`, `schema.json`, `tags.json`, `branch.json`, `lock.json`, the keys (`keys/`), the chain's blocks (`blockchain/`), the registry (`remote/`), a catalog (`index/`, a tag's `tags/<name>/index/`) — `get`, `has`, `list`, `put`, `remove`, and `create` (exclusive) where the medium can |
| `records` | The records by id — `get(id)` the stored record as the engine holds it, `raw(id)` its text, `has`, `getMany`, `ids({ after, limit })` in id order, tombstones included |
| `pieces` | The runs of a large text or list beside its record, by the name the record's meta holds |
| `copies` | A tag's copies of records, by tag and id |
| `blobs` | Attachments' bytes by their SHA-256, where `capabilities.blobs`: `get`, `has`, `list`, `put`, `remove` — a copy in, a copy out; outside the write set (a blob is written before the record names it, and the same bytes are the same blob). Every store checks the key at its door (`checkDigest`: 64 lowercase hex characters, a `TypeError` otherwise — a digest is a file name in the files engine, a filter elsewhere) and takes a `Uint8Array` of at most `MAX_BLOB_BYTES` (64 MiB, `BLOB_TOO_LARGE`) |
| `log` | The op log's medium — what the log writes its groups, segments and index through (the files engine's journal) |
| `write(batch)` | One write set: a tag's copies of the records as they were, records (each with the pieces it makes and drops), kv puts and removals — whole or not at all where `capabilities.atomicBatch`, in order otherwise |
| `estimate()` | Optional: `{ usage, quota }` in bytes, what the medium can say of the room — `db.quota()` asks it (memory: what it holds; SQLite: the file's pages and its volume; IndexedDB: the browser's Storage API) |

`capabilities` says what the medium can do — `atomicBatch`, `indexes`,
`changeStream`, `exclusiveCreate`, `lock`, `shared`, `blobs`, `append` — and
the database asks nothing a medium lacks. The files engine declares what its
backend has (`exclusiveCreate` with `create`, `append` with `append`) and
nothing else: a file system has no transactions, so the log append stays the
commit point and a landing that fails is `UNPERSISTED`, as it always was.
A transaction of many records is one write set, a single write one.

### What ships

| Engine | Where | How |
| --- | --- | --- |
| `filesEngine(fsi)` | Anywhere | What `createDatabase({ fsi })` builds, and the default over the platform's backend: a directory, today's layout |
| `idbEngine({ name, indexedDB, IDBKeyRange, durability, channel })` (`@alexify/syncom/idb`) | The browser | The engine over IndexedDB: seven object stores keyed by the database's path (`kv`, `records`, `pieces`, `copies`, `log`, `meta`, `blobs`; version 2 — an older database is upgraded at its open), a record as the object it was handed, one readwrite transaction per write set and per log group, key ranges for listings, a `BroadcastChannel` another tab's writes are heard through (`db.changes`). Where `createIdbFsi` spent a transaction per file and rewrote the catalog whole, this spends two per write. `engine.close()` closes the connection, `engine.destroy()` deletes the IndexedDB database — see [Browser](./browser#opfs-or-indexeddb) |
| `sqliteEngine({ file, database, driver, durable })` (`@alexify/syncom/sqlite`) | Node.js — or anywhere SQLite runs, through a driver | The engine over SQLite: seven tables keyed by the database's path (`kv`, `records`, `pieces`, `copies`, `log`, `meta`, `blobs`) in one file, `:memory:` by default, through `node:sqlite` (Node 22.5+; experimental, so Node warns once at the require — `node --no-warnings=ExperimentalWarning` quiets it); `remove(path)` deletes a path's rows in every table, the blobs among them, and `blobs.has` reads no bytes or any driver with `exec(sql)` and `prepare(sql)` → `{ run, get, all }` (better-sqlite3, expo-sqlite; answers may be promises). One transaction per write set and per log group, every statement through one lane; WAL for a file, `synchronous = FULL` once a database opens `durable`. `engine.close()` closes the connection (the file stays), `engine.destroy()` deletes the file |
| `mongoEngine({ client, db, name, transactions, changes })` (`@alexify/syncom/mongodb`) | Node.js, the driver's client injected | The engine over MongoDB: seven collections keyed by the database's path (`kv`, `records`, `pieces`, `copies`, `log`, `meta`, `blobs`) in one MongoDB database, a document's `_id` its key as JSON with the key's fields flat beside it over an index. A write set is a bulk write per collection — in one session transaction under `transactions: true` (a replica set; `atomicBatch`), in order otherwise, where every put is an upsert so a set that failed midway is landed again whole by the replay; a log group is one bulk write. One instance writes: the database is held by a lease (`locks`, a document per path on the **server's** clock — `$$NOW`, never the client's — renewed every third of `lock.staleAfter`, 30 s by default, every lease the engine holds in one bulk write a tick — a renewal that fails is tried again every `lock.poll` ms while two thirds of `staleAfter` are left, the `lease` event saying `late` then `renewed`, or `lost`; a lapsed one is taken over, its generation `gen` one up, and a release leaves it lapsed so the count goes on; `stats().lock` says when it lapses), another instance over the same path is `LOCKED` — or opens with `readOnly: true` and reads what the writer lands, hearing every write through a change stream (`db.changes`; `changes: false` on a standalone server). Every document a holder writes carries its lease's `gen`, and every put, removal and log group is fenced to documents of its generation or older: a writer whose lease was taken by another instance cannot write over anything the new holder wrote (the statement fails as `LEASE_LOST`; under `transactions: true` the lease is checked inside the transaction first, so nothing of an old generation lands at all), hears `LEASE_LOST` once and writes nothing more — what it had logged but not landed is held (`UNPERSISTED`) for the next holder's replay. Nothing is required: the application connects and closes the driver (6.0 or later); `engine.remove(path)` takes the lease document with the rest, `engine.destroy()` drops the database. A blob goes in parts of 15 MiB (`[p, digest, n]`, the head `n: 0` with `parts` and `length` written last, so a put cut short leaves no blob) — a document holds 16 MiB, a blob may hold 64. The subpath also exports `mongoSharedLog({ client, db, name, collection, changes, poll, gapTimeout, retention })` — a [shared log](./scaling#hubs) over two collections of the same MongoDB, what a writer hub and its followers serve `changes` from and forward pushes through |
| `memoryEngine()` (`@alexify/syncom/memory`) | Anywhere | The engine in memory: a record kept as the object it was handed (no JSON text), the log as rows (nothing written, nothing read back), the catalog's rows as they are; one engine object is shared by every database that opens through it, and a path outlives its instance until `engine.remove(path)` — a reopen reads what the last instance wrote. Nothing survives the process. What a test, a mesh in one process or a benchmark wants over `memory()` |

```js
const { createDatabase } = require('@alexify/syncom');
const { memoryEngine } = require('@alexify/syncom/memory');

const engine = memoryEngine();
const a = await createDatabase({ path: 'a', engine });      // two databases, one engine, a path each
const b = await createDatabase({ path: 'b', engine });
await a.close();
const again = await createDatabase({ path: 'a', engine });  // what `a` wrote, log and tags included
await engine.remove('a');                                   // gone for good
```

```js
const { createDatabase } = require('@alexify/syncom');
const { sqliteEngine } = require('@alexify/syncom/sqlite');

const engine = sqliteEngine({ file: 'app.sqlite' });       // one file, every database opened through it
const db = await createDatabase({ path: 'app', engine });
await db.insert({ title: 'In SQLite' });
await db.close();
await engine.close();                                       // the connection; the file stays
```

```js
const { MongoClient } = require('mongodb');                 // the application's driver
const { createDatabase } = require('@alexify/syncom');
const { mongoEngine } = require('@alexify/syncom/mongodb');

const client = await new MongoClient(process.env.MONGODB_URL).connect();
const engine = mongoEngine({ client, name: 'app', transactions: true }); // one MongoDB database, every path in it
const db = await createDatabase({ path: 'main', engine });
await db.insert({ title: 'In MongoDB' });
await db.close();
await client.close();                                       // the driver is yours
```

Every engine is held to the same contract as a test — `tests/suites/engine.js`,
run over the files engine on every backend that ships. An engine of your own
passes it or it is not one. An engine and a backend together
(`createDatabase({ engine, fsi })`) is a `TypeError`: the files engine is how a
backend becomes an engine.

### An engine in a worker

`serveEngine(engine, port)` from `@alexify/syncom/engines` answers the engine
contract over a message port — a worker thread, a SharedWorker, Electron's
main process — and `connectEngine(port)` is that engine on the other side:
every call one message and its answer, so the I/O runs off the thread the
database lives on. The database stays where it is opened (its seqs are minted
there); only its bytes cross the port.

```js
// worker.js
const { parentPort } = require('node:worker_threads');
const { memoryEngine } = require('@alexify/syncom/memory');
const { serveEngine } = require('@alexify/syncom/engines');
serveEngine(memoryEngine(), parentPort);

// main.js
const { Worker } = require('node:worker_threads');
const { createDatabase } = require('@alexify/syncom');
const { connectEngine } = require('@alexify/syncom/engines');
const worker = new Worker('./worker.js');
const engine = await connectEngine(worker);               // asks the worker what it serves
const db = await createDatabase({ path: 'app', engine });
```

`remoteEngine(port, { name, capabilities, timeout })` is the same without the
question, where the main thread knows what it started. An error crosses with
its code (`EEXIST`, `INTEGRITY`, `LOCKED`…), a change stream and the loss of a
lease are pushed back, and a group the served store cannot write fails the
append here, as it would in-process.

The served side trusts the port as it trusts the process, no further: a call
names a store and a method of the contract and nothing else, every key, id,
tag and path is checked before a store sees it, and `remove(path)` takes only
what that port opened — `serveEngine(engine, port, { allow: ['app'] })` lists
the paths a less trusted side (a renderer) may open and remove at all. A port
that closes or a worker that exits fails every call waiting and every call
after with `code: 'ENGINE_UNREACHABLE'` (`reason: 'closed'`), and the served
side lets go of what the port held — its leases, subscriptions, databases; a
call that waits longer than `timeout` ms fails the same (`reason: 'timeout'`).
`engine.stats()` is `{ inflight, oldestMs, calls, failures, closed }`.

### Moving a database between engines

`copyEngine(from, to, { path, batch })` copies the database at `path` from
one engine to another — every record with its pieces, every tag's copies,
every kv text (`node.json`, the keys, the chain, the catalog, the registry),
the op log with its index — so the node opens on the new engine as itself:
the same identity, epoch, vector and heads, and a peer resumes its cursor
without a bootstrap. Both databases must be closed (the copy holds them as
`createDatabase()` would; a lease lost on the way fails it with `LEASE_LOST`),
and a target that already holds a database at the path is `TARGET_NOT_EMPTY`.
The identity — the keys, then `node.json` — lands last, so a copy cut short is
no node of that name, and a copy that fails removes what it wrote from the
target. Two copies of one node are two writers of one stream: once the copy is
done, open the database through the new engine only, and remove it from the old
one (`from.remove(path)`) or never open it there again.

```js
const { createDatabase, filesEngine } = require('@alexify/syncom');
const fsi = require('@alexify/syncom/fsi');                 // or the backend the database was opened with
const { copyEngine } = require('@alexify/syncom/engines');
const { sqliteEngine } = require('@alexify/syncom/sqlite');

const db = await createDatabase({ path: 'app', fsi });   // the database as it is today
const files = filesEngine(fsi);                           // where the database is
const sqlite = sqliteEngine({ file: 'app.sqlite' });      // where it goes
await db.close();
const copied = await copyEngine(files, sqlite, { path: 'app' }); // { records, pieces, copies, kv, entries }
const moved = await createDatabase({ path: 'app', engine: sqlite });
```

## Backends

Under the files engine a kv namespace is a directory under the path and a key
a file in it, a record `data/<id>.json`, its pieces `data/<id>~<n>.json`, a
tag's copies `tags/<tag>/data/<id>.json`, the log its journals and segments
under `log/`: the layout every database had before the engines, byte for byte.

| Function | Meaning |
| --- | --- |
| `read(dir, name)` | `Promise<string>`; a missing file rejects (`code: 'ENOENT'` or `name: 'NotFoundError'`) |
| `write(dir, name, content, options?)` | Creates the directory; whole-file. `options.mode` is a permissions hint (the private keys ask for `0o600`); an adapter without permissions ignores it. `options.atomic` asks for the file to land whole or not at all — on `node:fs` a temporary file renamed into place (never listed); OPFS, IndexedDB and memory are whole already. The engine asks it for the files the log does not replay (its index, its segments, `node.json`, `tags.json`, the catalog) |
| `exists(dir, name)` | `Promise<boolean>` |
| `remove(dir, name)` | A no-op when absent |
| `list(dir)` | File names, sorted; an absent directory is `[]` |
| `sync(dir, name)` *(optional)* | fsync — what `durable: true` calls after every write |
| `create(dir, name, content)` *(optional)* | Exclusive create: rejects with `code: 'EEXIST'` when the file is there; what the directory lock uses when present (`node:fs` and the memory backend have it) |
| `append(dir, name, content)` *(optional)* | Adds `content` at the end of the file, making the file and the directory when absent; what the op log writes with when present — a line per group of ops into one journal, not a file per group (`node:fs` and the memory backend have it) |

`isFsi(value)` tells whether an object has the five. The check runs at
`createDatabase()`, naming the method that is missing, and the database never closes a
backend it was handed — two databases may share one (`filesEngine(fsi)` is one engine over it).

## What ships

| Backend | Where | How |
| --- | --- | --- |
| `node:fs/promises` | Node.js | The default under Node; `sync` is `fsync`; `append` writes through a descriptor held open (one per directory — a log appends to its newest journal alone — and 64 at most in the process, the least recently used closed first; `remove` closes its own) |
| OPFS | The browser | The default in a browser bundle (`fsi.browser.js`); durable when a writable closes, no `sync`, no `append` |
| `@alexify/syncom/idb` | The browser | `createIdbFsi({ name, store, indexedDB })` — see [Browser](./browser#opfs-or-indexeddb) |
| `@alexify/syncom/memory` | Anywhere | `memory()` — a Map; nothing survives the process |
| `@alexify/syncom/layered` | Anywhere | `layered([top, …, bottom], options)` — one backend over several, a multi-level cache; see [Layers](#layers) |
| `@alexify/syncom/encryption` | Anywhere | `atRest(fsi, options)` — every file through it encrypted; see [Encrypted at rest](#encrypted-at-rest) |

```js
const { createDatabase } = require('@alexify/syncom');
const { memory } = require('@alexify/syncom/memory');

const fsi = memory();
const storage = await createDatabase({ path: 'app', fsi });     // nothing touches the disk
await storage.insert({ a: 1 });
fsi.size;                                              // 6 files: lock, node.json, log, data, catalog
Object.keys(fsi.dump());                               // ['app/lock.json', 'app/log/index.json', 'app/node.json', …]
```

The memory backend is what a test, a server-side render, or a benchmark
wants; two storages opened over one of it with different `path`s are a
mesh in one process, which is how the sync-engine suite runs.

```js
import { createDatabase } from '@alexify/syncom';
import { createIdbFsi } from '@alexify/syncom/idb';

const idb = createIdbFsi({ name: 'app' });
const storage = await createDatabase({ path: 'data', fsi: idb });
// …
await storage.close();
await idb.close();                                     // the backend's own
```

## Layers

`layered()` from `@alexify/syncom/layered` makes one backend of several — a
memory layer over the disk, the disk over a remote store — that reads as a
multi-level cache and writes to every layer in list order:

```js
const { createDatabase } = require('@alexify/syncom');
const { memory } = require('@alexify/syncom/memory');
const { layered } = require('@alexify/syncom/layered');
const disk = require('@alexify/syncom'); // read, write, exists, remove, list: the platform's own

const fsi = layered([memory(), disk], { write: 'back' });
const storage = await createDatabase({ path: 'data', fsi });
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
  waits for room). A queued call that fails is told to `onError(error)`,
  each one, and counted (`failed`); `flush()` awaits the queue and rejects
  with the first failure since the last flush, `sync()` and `close()` too —
  the calls that promise the lower layers have the files — and a read, an
  `exists` or a `list` that waited for the queue never throws one; `close()`
  flushes and closes every layer that has a `close()` (the IndexedDB one). What the queue holds is lost with the
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
- `append` is there when every layer has one, and lands like a write, on
  every layer in order. A file the top lacks and a lower layer holds is
  copied up first (the queue drained), so the top never holds the tail of a
  file without its head.

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
const { createDatabase } = require('@alexify/syncom');
const { atRest } = require('@alexify/syncom/encryption');

// a key the application holds: 32 bytes, or a Web Crypto AES-GCM CryptoKey
const storage = await createDatabase({ path: 'data', fsi: atRest(fsi, { key }) });

// or a password: the key is derived by PBKDF2-SHA-256 under a salt the
// application keeps (8 characters or more), 600 000 rounds by default
const vault = await createDatabase({ path: 'data', fsi: atRest(fsi, { password, salt }) });

// an engine the same way: every record, piece, copy, kv text and log entry a ciphertext in the engine's stores
const { memoryEngine } = require('@alexify/syncom/memory');
const sealed = await createDatabase({ path: 'data', engine: atRest(memoryEngine(), { key }) });
```

Over an engine (memory, IndexedDB, SQLite, MongoDB) the wrapper seals every
value the stores hold — a record as one text, its pieces, a tag's copies, the
kv texts, each entry of the op log and the log's index — and leaves the keys
in the clear: an id, a seq, a tag's name, a kv key, the index's `floor`. An
attachment's blob is sealed as **bytes** at the blob's place — iv ‖ ciphertext,
28 bytes over the blob's own size, no base64 — and its digest stays a name. The
engine keeps no index of its own over ciphertext (`capabilities.indexes` is
false; the core's catalog is saved sealed, as kv). The files engine is wrapped
at its backend — `filesEngine(atRest(fsi, options))` — since its journal reads
the ops it writes.

Each ciphertext is bound to its file name (the additional data of
AES-GCM): a file copied over another one of the store — one record's over
another's — does not decrypt. The directory is not bound, so a store moved
elsewhere opens; under an engine (`atRest(engine)`) the database's path is bound
too, so a ciphertext moved to the same place in another database of the engine
— one key serves every path — does not open. What the wrapper does not hide or prevent: the names of the
files (record ids, tag names, the log's seqs) and their sizes, and an older
copy of a file put back in its place — that is a backup restored, as far as
the key can tell.

The key is never written. A file that is not the key's is refused as
`DECRYPT_FAILED` with a `reason` — `'key'` (another key, or a torn
ciphertext; a blob never sealed or moved to another place too, since bytes
carry nothing to tell plain from sealed), `'plain'` (a text that was never
encrypted), `'torn'` (not base64) — and the first such file fails
`createDatabase()`. The key is rotated by a copy — `rotateAtRest()`, over an
engine or over a backend with `{ fsi, filesEngine }` — and the source is then
fenced with `moved.json` (`MOVED` at `createDatabase()`), see
[Encryption at rest](./database#encryption-at-rest). `exists`, `remove`, `list`,
`sync` and `create` pass through, so a lock and a `durable` open work as they
do on the bare backend. There is no `append` — a file is one ciphertext — so
the log under the wrapper writes a sealed file per group. The wrapper
composes with any adapter, the IndexedDB one included. Sealed records (`encrypted: true`) are the other block of the
same subpath: one record for this node's key, outside the log — the two are
independent.

## Your own

An adapter is the five functions over whatever holds bytes — a `Map`, a
key-value store, S3 per node, a Capacitor filesystem on mobile. Two things
the engine relies on: `write` is whole-file and visible to the next `read`
once it resolves, and `list` names files only, sorted. `tests/suites/fsi.js`
is the contract as a test — run it against yours.

`append` is worth adding where the medium appends cheaply — a file, an
append-only object. The log then writes its groups of ops as lines of one
journal (`log/open/<seq>-<token>.jsonl`), begun again at every roll and
removed once the roll has sealed its groups, instead of a file per group
and its removal; on `node:fs` an append to a held descriptor costs about a
tenth of a new file and its unlink. An adapter without it changes nothing
but the count of files.

## Durability

Files are written with the platform's default durability. `createDatabase({ durable:
true })` follows every write with the backend's `sync`; on `node:fs` that is
an fsync per file — the log batch, the chain block, the record — and the
price is the write latency of the disk; an `append` is followed by `sync`
too. A backend without `sync` (OPFS, IndexedDB, memory) is as durable as it
is, and `durable` logs a debug line and does nothing. What a crash can tear is the newest, unannounced batch:
the log is written before the record, a reopen replays its unsealed tail,
and a torn open file — or a journal's torn last line — is dropped before
anyone was told of it. A record file torn the same way reads as `INTEGRITY`
until `repair(id)` rebuilds it.

`createDatabase({ defer: ms })` trades the record files' timing for fewer writes: a local
write's record file and chain block wait up to `ms` (one timer for all of
them), so the writes of one record within the window land as one file, and
everything due lands under one block; a flush that took longer than `ms` (a
large record's file) makes the next window as long as it took. The log
append is not deferred — a crash before the flush replays
the batch at the next open, as after a failed file write — and `flush()`, `tag()` and
`close()` land the files first. It is 16 ms, a frame, by default; `0` writes
every file at once. The log's own writes are grouped: every op appended
while a group is being written goes into the next one, so a burst of writes
costs the backend a few writes, not one per op — a line appended to a journal
where the backend has `append`, a file of its own where it does not.

The log append is the commit point. A backend that fails after it — a full
disk, a browser's `QuotaExceededError` on the record file or the chain block
— does not undo the write: it resolves, the op replicates, the record is
held in memory so reads see it, and the storage's `error` event carries
`code: 'UNPERSISTED'`. The batch stays unapplied in the log, and the next
open replays it onto the files.

## One instance per directory

`createDatabase()` holds the directory — the Web Locks API in a browser, a `lock.json`
with the pid elsewhere — and a second `createDatabase()` of it rejects with
`code: 'LOCKED'`; `lock: 'wait'` waits, `lock: false` leaves the
coordination to you. See
[One instance per directory](./database#one-instance-per-directory) for why,
and for what two browser tabs should do.
