---
title: Engines and backends
description: The storage contract as a specification, from engines, stores and write sets to capabilities, the five-function fsi, durability and locking.
---

# Engines and backends

This page is the specification of the storage contract: what an engine is, the stores of the database it
opens, the write set, the capabilities, the op log's medium, the fsi a files engine runs over, durability, the
lock, and every engine and backend the package ships. The guide's [Storage overview](../guide/storage) says
which one to choose; this page says what each one does.

Everything a database persists (records, the op log, the chain, the keys, the peer registry, the catalog, the
tags, local documents, checkpoints, attachments' bytes) goes through its **engine**. `createDatabase({ engine })`
takes one. Without it the database opens through the **files engine** over a backend, an **fsi**: the
platform's own (`node:fs/promises` in Node, OPFS in a browser bundle), or the one `createDatabase({ fsi })`
names.

## Engine

An engine is a factory of databases: one object shared by every database that opens through it, a database
per `path`.

| Member | Meaning |
| --- | --- |
| `name` | A non-empty string: `'files'`, `'memory'`, `'idb'`, `'sqlite'`, `'mongodb'`, or yours |
| `capabilities` | What the medium can do (see [Capabilities](#capabilities)) |
| `open(path, { logger, durable })` | Resolves to the database at `path` (an [EngineDb](#the-database-an-engine-opens)), made when absent |
| `remove(path)` | Every store of the database at `path`, gone; the database must be closed |
| `fsi` | The files engine's backend; absent on a native engine |
| `close()`, `destroy()` | A native engine's own: its connection closed, its medium deleted (see each engine below) |

`isEngine(value)` is true for an object with `open()`, `remove()`, a non-empty `name` and a `capabilities`
object. `createDatabase({ engine })` checks the same and throws a `TypeError` naming the first member
missing; `createDatabase({ engine, fsi })` is a `TypeError` (the files engine is how a backend becomes an
engine). The database answers `db.engine` (the engine) and `db.fsi` (the files engine's backend, `null`
under a native engine). A database never closes the engine it was handed.

`open()` is called before the lock is taken, with the database's `logger` and its `durable` setting. Only
the SQLite engine reads `durable` there; the files engine reads it when the database builds it from `fsi`
(see [Durability](#durability)).

## Capabilities

`capabilities` is a frozen object with every key below; an engine spreads its own over the defaults, and the
database asks nothing a medium lacks.

| Capability | Default | Meaning |
| --- | --- | --- |
| `atomicBatch` | `false` | Every write set lands whole or not at all |
| `indexes` | `false` | The engine keeps the catalog's rows (`db.catalog`); the core saves the catalog to `kv` otherwise |
| `changeStream` | `false` | Another instance over the same database hears its writes (`db.changes`) |
| `exclusiveCreate` | `false` | `kv.create` makes a key exclusively (`EEXIST` when it is there) |
| `lock` | `'kv'` | How one instance holds a database: `'kv'` through the lock key, `'native'` through the engine's own lease (`db.lock`) |
| `shared` | `false` | Several instances may open one database at once: what a read-only follower needs |
| `blobs` | `false` | A `blobs` store for attachments |
| `append` | `false` | The log's medium appends a line to a journal (a file per group otherwise) |

What the shipped engines declare:

| Engine | `atomicBatch` | `indexes` | `changeStream` | `exclusiveCreate` | `lock` | `shared` | `blobs` | `append` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `filesEngine(fsi)` | false | false | false | where `fsi.create` | `'kv'` | false | true | where `fsi.append` |
| `memoryEngine()` | true | true | true | true | `'kv'` | true | true | false |
| `idbEngine()` | true | true | where a `BroadcastChannel` | true | `'kv'` | true | true | false |
| `sqliteEngine()` | true | true | false | true | `'kv'` | false | true | false |
| `mongoEngine()` | `transactions` | true | `changes` | true | `'native'` | true | true | false |

## The database an engine opens

`engine.open(path)` answers an **EngineDb**, a set of stores over one `path`. `createDatabase()` throws a
`TypeError` naming the first required member missing.

| Member | Required | Meaning |
| --- | --- | --- |
| `path`, `capabilities` | yes | The path it was opened at, the engine's capabilities |
| `kv` | yes | Small named texts by namespace and key |
| `records` | yes | The records by id |
| `pieces` | yes | The runs of a large list or text beside its record |
| `copies` | yes | A tag's copies of records |
| `log` | yes | The op log's medium |
| `write(batch)` | yes | One [write set](#the-write-set) |
| `close()` | yes | Lets the database go (the engine stays open) |
| `blobs` | where `capabilities.blobs` | Attachments' bytes by digest |
| `catalog` | where `capabilities.indexes` | The catalog's rows, kept by the engine |
| `changes` | where `capabilities.changeStream` | What another instance over the database wrote |
| `lock(options)` | where `capabilities.lock` is `'native'` | The engine's lease on the database |
| `estimate()` | no | `{ usage, quota }` in bytes, what the medium can say of the room |
| `fsi` | no | The files engine's backend |

### kv

Small texts by namespace (`''` is the root) and key: `get(ns, key)` → text or `null`, `has`, `list(ns)` →
the keys, sorted (an absent namespace is empty), `put(ns, key, value, { atomic, mode })`, `remove` (a no-op
when absent), and `create(ns, key, value)` where `capabilities.exclusiveCreate` (rejects with
`code: 'EEXIST'` when the key is there). `put`'s options are hints for the files engine's backend: `atomic`
asks for the text to land whole or not at all, `mode` for file permissions (the private keys ask `0o600`).

A key is a text of 1 to 255 characters with no `/`, no `\`, no control character, and neither `.` nor `..`
(`isKvKey`); a namespace is `''` or keys joined by `/` (`tags/<tag>/index`). The files engine and a served
engine refuse anything else with a `TypeError` before a store sees it. The namespaces a database writes
(`KV_NAMESPACES` in `src/engine.js`, what `copyEngine` copies and the files engine sweeps):

| Namespace | Keys |
| --- | --- |
| `''` | `node.json`, `schema.json`, `tags.json` (and `tags.corrupt.json`), `branch.json`, `lock.json`, `revoked.json`, `moved.json`, `copy.json` |
| `keys` | `public.pem`, `private.pem` (RSA, the encryption plugin), `sign-public.pem`, `sign-private.pem` (Ed25519, the signing plugin) |
| `blockchain` | `<hash>.json` per block, `.blockchain.json` the tail |
| `index` | `catalog.json` |
| `remote` | `<url, URI-encoded>.json` per registered node |
| `local` | `<key>` per local document |
| `pipeline` | `<name>` per pipeline checkpoint |
| `tombstones` | `<id>` per folded tombstone |
| `shared` | `cursor.json`, a hub's cursor in a shared log |
| `connector` | `<name>` per connector checkpoint |
| `tags/<tag>/index` | `catalog.json`, a tag's catalog |

What the root namespace's keys hold:

| Key | Content |
| --- | --- |
| `node.json` | `{ id, plugins }`: this node's identity — its signing key, or what `getId` minted without the `signing` plugin — and the kind plugins the directory ran with (a reopen without one of them is `PLUGIN_MISSING`) |
| `schema.json` | `{ version, migrated, hash }`: the schema version and snapshot hash this directory last ran, and when that version first ran here (see [Versions and the lens](./api#versions-and-the-lens)) |
| `tags.json` | `{ format: 1, tags: [{ name, eventId, seq, ts, vector, createdAt }] }`, oldest first; `tags.corrupt.json` once it could not be read (see [Tags](./versions#tags)) |
| `branch.json` | `{ format: 1, parent, forkedAt, createdAt }`, in a branch only (see [Branches](./versions#branches)) |
| `lock.json` | `{ pid, id, since }` while an instance holds the database through the lock key outside a browser (see [One instance per database](#one-instance-per-database)) |
| `revoked.json` | `{ v: 1, nodes: { [node]: scopes } }`: the scopes a host took back, per peer |
| `moved.json` | `{ to: { path, engine }, at }`: where `rotateAtRest()` copied the database; the directory opens nowhere until `dropDatabase()` (`MOVED`) |
| `copy.json` | `{ from, started }` while `copyEngine()` writes a target; a target that holds it without an identity is a copy cut short |

Every record names the chain block that committed it (`block`), which is what makes `validate()` possible, and
its `meta` is the replication bookkeeping — per-field clocks, the reset watermarks, the tombstone, the counters,
the sets, a list's or a text's block, a tree's moves — what lets two nodes' copies merge. A deleted record keeps
its file as a tombstone until a cleanup folds an old one into the `tombstones` namespace.

### records

`get(id)` → the stored record (`{ data, meta, encrypted, timestamp, block, gen?, type? }`, `type` the
collection of a tombstone whose data is empty) or `null`; a record the medium holds that is no record rejects
with `INTEGRITY` (`reason: 'unreadable'`, the parse error as `cause`). `raw(id)` → its text as the medium holds
it (a native engine stringifies on demand). `has(id)`. `getMany(ids)` → a `Map` of the ids found, in the
order asked. `ids({ after, limit })` → every id the medium holds, tombstones included, in id order, after
`after`, at most `limit`. Records are written only through `write(batch)`.

### pieces

A list or a text of 1 024 runs or more keeps its runs in pieces of 512 beside its record, by the names the
record's meta holds: `get(id, name)` → text or `null`, `getMany(id, names)` → a `Map`, the absent left out,
`remove(id, name)`. Pieces are made and dropped by the write set that carries their record.

### copies

A tag's copies of records as they were before their first change after the tag: `get(tag, id)`, `has`,
`ids(tag)` (in id order), `put(tag, id, text)`, `remove(tag, id)`, `drop(tag)` (every copy of the tag).

### blobs

Attachments' bytes by their SHA-256: `get(digest)` → a `Uint8Array` or `null`, `has`, `list()` (sorted),
`put(digest, bytes)`, `remove`. A copy goes in and a copy comes out. Every store checks the key at its door
(`checkDigest`: 64 lowercase hex characters, a `TypeError` otherwise) and takes a `Uint8Array` of at most
`MAX_STORED_BYTES`: `MAX_BLOB_BYTES` (64 MiB, the cap on plain bytes at every door that takes them) plus the 28
bytes the at-rest seal adds; past it, `BLOB_TOO_LARGE`. Blobs are outside the write set: a blob is written
before the record names it, and the same bytes are the same blob.

### catalog, changes, lock, estimate

`catalog.load()` → `{ indexes, stamp, rows }` or `null`; `catalog.save(indexes, stamp, { all, changed, whole })`
writes what changed (`changed`: the ids put since the last save, `null` for a row removed; `whole` when the
store holds none of this catalog's rows and `all()` is every row).

`changes.subscribe(listener)` → the unsubscribe. The listener hears `{ p, records: ids }` per write set of
another instance (IndexedDB also `{ p, log: [first, last] }` per log group), never this instance's own, and
`{ error }` once when the stream ends; the subscription is then over. A follower subscribes before it loads,
subscribes again after an end and reads every record again (`FOLLOW_LOST`).

`lock({ mode, staleAfter, poll, timeout, onLost })` → a lease `{ release(), gen?, expiresAt?, subscribe? }`;
see [One instance per database](#one-instance-per-database).

`estimate()` → `{ usage, quota }` in bytes, `null` where the medium cannot say; `db.quota()` asks it, or, under
the files engine, the volume (`statfs` of the path in Node, `usage` null; the Storage API in a browser).

### The log medium

`log` is what `OpLog` writes its groups, segments and index through; the core owns the log itself. The files
engine's is the journal store of `src/files/journal.js`; the memory engine's `logStore` in
`src/memory/engine.js` is the smallest model of the same contract.

| Member | Meaning |
| --- | --- |
| `load()` | The saved index, every retained entry sorted and unique, the open groups with the seqs no segment holds yet, the floor, and what the open could not read |
| `append(entries, headers, { first, last, sealedTo, onFail, entriesBetween })` | One group, durable; answers whether it landed. A group that did not calls `onFail(error)` before anything else is awaited |
| `seal(entries, from, to)` | A segment of the seqs `from`..`to`, whole or not at all |
| `sealed(to)` | The open groups up to `to` let go once their segment holds them |
| `drop(segment)` | The oldest segment removed (compaction) |
| `saveIndex(index)` | The log's index (epoch, floor, next, vector, heads, stamps) |
| `scrub(seqs, { entriesBetween })` | The entries at `seqs` written again as the log holds them now (a purge) |
| `journaled`, `segments`, `sealedTo`, `open`, `corrupt`, `health` | What the medium holds: whether it appends lines, the sealed segments, the last sealed seq, the open groups, the files that failed their checksum, a summary |

## The write set

`write(batch)` lands one write set: a transaction of many records is one, a single write another, and the
chain's block and tail ride in it as kv puts.

```ts
{
  records?: { id, stored?, text?, pieces?: { put?: [name, text][], remove?: name[] } }[],
  remove?: id[],                               // records removed (a tombstone folded, a record forgotten)
  kv?: { put?: [ns, key, value, options?][], remove?: [ns, key][] },
  copies?: { put?: [tag, id, text][], remove?: [tag, id][] },
}
```

A record row carries `stored` (the object) or `text` (its JSON as given), exactly one. Every namespace, key,
tag and piece's name is a kv key, every id a record id, every value a text; anything else is a `TypeError`
naming the member (`checkWriteSet` in `src/write-set.js`).

Where `capabilities.atomicBatch` the set lands whole or not at all. Elsewhere it lands in the order a crash is
safest in: the kv puts (a chain block before the records it names), then the tags' copies (a record as it was,
before its file changes), then each record with the pieces it makes first and the pieces it drops last, then
the removals, the copies removed and the kv removals. The MongoDB engine without transactions keeps the same
order and makes every put an upsert, so a set that failed midway is landed again whole by the replay.

## The files engine

`filesEngine(fsi)` (a root export) is the engine every fsi becomes, and what `createDatabase({ fsi })` builds.
A kv namespace is a directory under the path and a key a file in it:

| Store | Where |
| --- | --- |
| `kv` | `<path>/<ns>/<key>` (`<path>/<key>` for the root) |
| `records` | `<path>/data/<id>.json` |
| `pieces` | `<path>/data/<id>~<n>.json` |
| `copies` | `<path>/tags/<tag>/data/<id>.json` |
| `blobs` | `<path>/blobs/<digest>`, the bytes as base64 text |
| `log` | `<path>/log/`: `index.json`, `seg-<from>.json` per sealed segment, `open/<first>-<session><n>.jsonl` journals where the fsi appends (`open/<first>.json` per group where it does not), `corrupt/` for files that failed their checksum |

The [guide](../guide/storage-filesystem#see-what-is-on-disk) lists what each file holds. A name reaches the
backend only as `isKvKey` admits it. The backend lists in its own order, so `records.ids` and `copies.ids`
collect every name, sort, and page after. A write set is never atomic: the log append stays the commit point
and a landing that fails is `UNPERSISTED`. `remove(path)` empties every directory of the layout (`DIRS` in
`src/layout.js`, the tags' two each) and `branch.json` last, so a removal cut short leaves a directory
`drop()` still takes; the empty directories stay (an fsi has no `rmdir`). The files engine has no `estimate`.

## The fsi

An fsi is five functions over "a directory and a file name", plus three optional ones.

| Function | Meaning |
| --- | --- |
| `read(dir, name)` | `Promise<string>`; a missing file rejects with `code: 'ENOENT'` or `name: 'NotFoundError'` |
| `write(dir, name, content, options?)` | Creates the directory; the whole file. `options.mode` is a permissions hint. `options.atomic` asks for the file to land whole or not at all: on `node:fs` a temporary file renamed into place (never listed); OPFS, IndexedDB and memory write whole already. The engine asks it for the files the log does not replay (its index, its segments, `node.json`, `tags.json`, the catalog, the registry, checkpoints) |
| `exists(dir, name)` | `Promise<boolean>` |
| `remove(dir, name)` | A no-op when the file is absent |
| `list(dir)` | File names only, sorted; an absent directory is `[]` |
| `sync(dir, name)` *(optional)* | fsync: what `durable: true` calls after every write |
| `create(dir, name, content)` *(optional)* | Exclusive create, rejects with `code: 'EEXIST'` when the file is there; what the lock prefers |
| `append(dir, name, content)` *(optional)* | Adds `content` at the end of the file, making the file and its directory when absent; what the log's journal writes with (a line per group into one journal instead of a file per group) |

`isFsi(value)` tells whether an object has the five. `createDatabase()` checks them and throws a `TypeError`
naming the method missing. The engine relies on two things: `write` is whole-file and visible to the next
`read` once it resolves, and `list` names files only, sorted. The database never closes a backend it was
handed: two databases may share one. `tests/suites/fsi.js` is the contract as a test.

### Backends that ship

| Backend | Where | Notes |
| --- | --- | --- |
| `node:fs/promises` | Node.js, the default | All three optional functions. `append` writes through a descriptor held open, one per directory and 64 at most in the process, the least recently used closed first; `remove` closes its own. The root of the package exports its five functions (`read`, `write`, `exists`, `remove`, `list`) and not the three optional ones: an fsi assembled from the root's exports (to wrap in `atRest()` or `layered()`) has no exclusive `create` for the lock, no `sync` for `durable` and no `append` for the journal (a file per log group) |
| OPFS (`src/fsi.browser.js`) | A browser bundle, the default | Paths resolve against `navigator.storage.getDirectory()`; directory handles are cached and resolved again when stale. Writes go through `createWritable()`, durable when the writable closes. No `sync`, `create` or `append` |
| `createIdbFsi({ name, store, indexedDB })` (`/idb`) | A browser | One IndexedDB database (`'syncom'`), one object store (`'files'`) keyed `[dir, name]` with an index on `dir`, version 1. A transaction per call; a write resolves on the transaction's `complete`. Opened on the first call, reopened after another tab deletes or upgrades it; `close()` is its own |
| `memory()` (`/memory`) | Anywhere | A `Map` of `dir/name` to text; `create` and `append`; `size` and `dump()`. Nothing survives the process |
| `layered(layers, options)` (`/layered`) | Anywhere | One backend over several (see [Layers](#layers)) |
| `atRest(fsi, options)` (`/encryption`) | Anywhere | Every file a ciphertext (see [Encrypted at rest](#encrypted-at-rest)) |

## Engines that ship

### Memory engine

`memoryEngine()` from `@alexify/syncom/memory`.

Maps: a record kept as the object the write set handed in (no JSON text made or parsed), the log as rows (a
sealed range is a segment; nothing is written), the catalog's rows as they are. One engine object answers the
same database for the same path until `remove(path)`, so a reopen through the same engine reads what the last
instance wrote; `engine.paths` lists the paths, sorted. `db.changes` hears `{ records }` per write set on a
microtask after it (the log's groups are not announced). Blobs are copied in and out. `estimate()` adds up the
kv texts, the records as JSON, the pieces, the copies and the blobs' bytes; `quota` is `null`. Nothing
survives the process.

### IndexedDB engine

`idbEngine({ name, indexedDB, IDBKeyRange, durability, channel })` from `@alexify/syncom/idb`.

| Option | Default | Meaning |
| --- | --- | --- |
| `name` | `'syncom'` | The IndexedDB database every path of the engine lives in |
| `indexedDB`, `IDBKeyRange` | the globals | The factory and the key-range constructor (a `TypeError` when absent) |
| `durability` | `'default'` | The transactions' durability hint: `'default'`, `'relaxed'` or `'strict'` |
| `channel` | `globalThis.BroadcastChannel` | The constructor another instance's writes are heard through; `null` for none (`changeStream` false) |

Seven object stores made at once in the one upgrade a new database gets, at version 1: `kv` `[p, ns, key]`,
`records` `[p, id]` (the structured clone of the object handed in; a text that is no record kept as
`{ text }`, read as `INTEGRITY`), `pieces` `[p, id, name]`, `copies` `[p, tag, id]`, `log` `[p, seq]` (the entry
and its group's first seq), `meta` `[p, key]` (the log's index and segments, the catalog's rows) and `blobs`
`[p, digest]`. Every key begins with the database's path, so a listing is one key range and `remove(path)` a
range delete per store, in one transaction. A write set is one readwrite transaction over the stores it
touches, every request queued before the first `await` and aborted whole when one throws; a log group is one
transaction over `log`. Another instance hears every write set through a `BroadcastChannel` named
`syncom:<name>`, its own writes left out by a token. `estimate()` is the Storage API's for the origin.
`engine.close()` closes the connection (the next call opens it again), `engine.destroy()` deletes the
IndexedDB database with every path in it. The database is reopened after another tab deletes it.

### SQLite engine

`sqliteEngine({ file, database, driver, durable })` from `@alexify/syncom/sqlite`.

| Option | Default | Meaning |
| --- | --- | --- |
| `file` | `':memory:'` | The SQLite file every database opened through the engine lives in |
| `driver` | `node:sqlite` | `{ open(file) }` answering a database with `exec(sql)` and `prepare(sql)` → `{ run, get, all }`, and an optional `close()`; every answer may be a promise |
| `database` | none | An open connection the caller owns: used as it is, never closed, no pragma set on it but `durable` |
| `durable` | `false` | `PRAGMA synchronous = FULL` from the start |

Node only. `node:sqlite` is required inside the factory, and only when neither `driver` nor `database` is
given; Node prints an `ExperimentalWarning` at that require (`node --no-warnings=ExperimentalWarning` quiets
it). A driver's "no row" is `undefined` or `null`; a parameter is a text, a number or `null`; a blob is bound
and answered as a `Uint8Array`. A library with another API (expo-sqlite's async calls, say) fits through a
driver of a few lines over it ([Expo](../guide/storage-expo)). `node:fs/promises` (and `node:path`) are
required inside `estimate()` and `destroy()`, so a bundler that resolves every `require` ahead of time must
leave them out.

Eight tables, every primary key starting with the database's path `p`: `kv (p, ns, key)`, `records (p, id)`
(the record's JSON), `pieces (p, id, name)`, `copies (p, tag, id)`, `log (p, seq)` (the entry and its group's
first seq), `meta (p, key)` (the log's index and segments, the catalog's indexes and stamp), `catalog (p, id)`
(a row per record) and `blobs (p, digest)` (a BLOB). A write set and a log group are one `BEGIN IMMEDIATE`
transaction each, rolled back whole when a statement or the `COMMIT` fails. Every statement of every database
of the engine goes through one lane on one connection: a database that must not wait on the others gets an
engine of its own. A connection the engine opens gets `journal_mode = WAL` for a file, `synchronous = NORMAL`
(`FULL` once a database opens `durable` or the engine was made `durable`) and `busy_timeout = 5000`.
`remove(path)` deletes the path's rows in every table in one transaction. `estimate()` is `page_count ×
page_size` (the whole file) and the free space of the file's volume (none for `:memory:` or a connection
given). `engine.close()` closes a connection the engine opened (the next call opens the file again; a
`:memory:` database starts over); `engine.destroy()` closes, then deletes the file with its `-wal`, `-shm` and
`-journal`.

### MongoDB engine

`mongoEngine({ client, db, name, transactions, changes })` from `@alexify/syncom/mongodb`.

| Option | Default | Meaning |
| --- | --- | --- |
| `client` | none | The driver's connected `MongoClient` (driver 6.0 or later) |
| `db` | none | A `Db` in place of `client` and `name` (no transactions then) |
| `name` | `'syncom'` | The MongoDB database every path lives in |
| `transactions` | `false` | A write set in one session transaction (a replica set): `atomicBatch` |
| `changes` | `true` | The deployment has change streams (a replica set): `db.changes`; `false` for a standalone server |

Node only; the driver is the application's, which connects and closes it (`engine.close()` does nothing,
`engine.destroy()` drops the MongoDB database). Eight collections, `kv`, `records` (the record's JSON),
`pieces`, `copies`, `log` (a document per entry with its group's first and last seq), `meta`, `catalog` (a
document per record's row) and `blobs`, plus `locks` (a lease document per path). A document's `_id` is its
key as JSON, the key's fields flat beside it over an index per collection. A write set is a bulk write per
collection, in one session transaction under `transactions: true`, in the files engine's order otherwise with
every put an upsert; a log group is one ordered bulk write that first wipes every document at or past its
first seq. A blob is kept in parts of 15 MiB (`[p, digest, n]`), its head (`n: 0`, `parts`, `length`) written
last, so a put cut short leaves no blob. `db.changes` watches `records` alone, matched to the path on the
server, under `fullDocument: 'updateLookup'`; a document carries its writer's token, and what carries this
instance's is dropped. There is no `estimate()`: `db.quota()` answers nulls. `remove(path)` deletes the path's
documents and its lease document. The lease is described under
[One instance per database](#one-instance-per-database).

The subpath also exports `mongoSharedLog({ client, db, name, collection, changes, poll, gapTimeout, retention,
logger })`, a shared log over two collections of the same MongoDB for the hubs of a mesh (see
[Scaling](../guide/server-scaling) and the [API reference](./api#engines-and-backends)).

## Durability

The op log append is the commit point. A local write resolves once its group of ops is durable; the record and
its chain block are landed after it, in log order, up to `defer` ms later (16 by default; `0` lands every
write at once; `flush()`, `tag()` and `close()` land them first). A crash before the landing is replayed at the
next open: the log keeps the batch unapplied until its records land. A torn open group file, or a journal's
torn last line, is dropped before anyone was told of it; a record file torn the same way reads as `INTEGRITY`
until `repair(id)` rebuilds it.

A landing that fails after the append (a full disk, a browser's `QuotaExceededError`) does not undo the write:
it resolves, the op replicates, the record is held in memory so reads see it, and the database's `error` event
carries `code: 'UNPERSISTED'` with the `ids` (and `quota: true` when the medium is full). The next open replays
it; `tag()` rejects with `UNPERSISTED` while such a record is held.

`createDatabase({ durable: true })` asks the medium to wait for the disk:

| Medium | What `durable: true` does |
| --- | --- |
| The files engine over an fsi with `sync` (`node:fs`) | Every `write`, `create` and `append` followed by `sync` (an fsync per file: the log group, the chain block, the record) |
| The files engine over an fsi without `sync` (OPFS, IndexedDB, memory) | Nothing; `durable.noop` logged at debug |
| SQLite | `PRAGMA synchronous = FULL` for the connection |
| memory, IndexedDB, MongoDB | Nothing more than the medium does (IndexedDB has its own `durability` option) |

The files engine is wrapped for `durable` when the database builds it from `fsi` (or the platform's default).
A files engine handed in as `engine` (`createDatabase({ engine: filesEngine(fsi), durable: true })`) is used
as it was built: no fsync is added.

## One instance per database

Two instances writing one database would both read the log's vector and mint the same next sequence number
for two different ops, which every peer drops as a duplicate. So `createDatabase()` holds the database, before
it reads anything, with one of two mechanisms:

- **The lock key** (`capabilities.lock: 'kv'`). In a browser context (`window` or `self` defined) with Web
  Locks, a Web Lock named `syncom:<path>`, released when the tab or worker dies. Elsewhere, `lock.json` in the
  database's root namespace, `{ pid, id, since }`: stale once that process is gone, or after `staleAfter` ms
  when there is no way to tell (no pid, no `process.kill`). Where `kv.create` exists two openers racing for a
  free lock lose deterministically; without it the last write wins and the other reads it back and tries again.
  `close()` releases it; a crash leaves a stale file the next open takes over. The lock is per machine: on a
  shared network filesystem, coordinate yourself and pass `lock: false`.
- **The engine's lease** (`capabilities.lock: 'native'`, MongoDB). A document per path in `locks`,
  `{ owner, gen, expires }`, on the server's clock (`$$NOW`, never the client's): made, or taken once it
  lapsed with its generation `gen` one up. Every lease the engine holds is renewed every third of `staleAfter`
  in one bulk write a tick; a renewal that fails is tried again every `poll` ms until two thirds of
  `staleAfter` have passed since the last one that landed, then the lease is lost. A release leaves the
  document lapsed, so the generation counts on. Every document a holder writes carries its `gen`, and every
  put, removal and log group is fenced to documents of its generation or older: a holder whose lease was taken
  cannot write over what the new holder wrote (the statement fails as `LEASE_LOST`; under `transactions: true`
  the lease is checked inside the transaction first). The database then hears `LEASE_LOST` once on its `error`
  event, becomes read-only (`READ_ONLY` for every write after) and holds what it logged but did not land
  (`UNPERSISTED`) for the next holder's replay. The `lease` event says `{ state: 'renewed' | 'late' | 'lost',
  path }`.

| `createDatabase({ lock })` | Meaning |
| --- | --- |
| `'fail'` (default) | A second open rejects with `LOCKED` |
| `'wait'` | Polls until the database is free (or stale, or lapsed) |
| `false` | No lock: coordinating instances is yours |
| `{ mode, staleAfter, poll, timeout }` | `mode` `'fail'` or `'wait'`; `staleAfter` (the lock key: 30 minutes; the lease: 30 000 ms, its length); `poll` (100 ms); `timeout` turns a `'wait'` that never ends into `LOCKED` |

`db.stats().lock` is `{ kind: 'kv' | 'native', mode, expiresAt, lost }` (`expiresAt` the lease's, on this
clock; `null` for the lock key) or `null` under `lock: false`. `dropDatabase(path, { engine | fsi })` holds the
same lock while it removes a closed database; an open instance's is `LOCKED`.

A second instance that only reads is a **follower**, `createDatabase({ readOnly: true })`, over an engine whose
`capabilities.shared` is true (memory, IndexedDB, MongoDB); the files engine and SQLite refuse it with a
`TypeError`, since the files engine's journal and SQLite's connection are one instance's. A follower holds no
lock, writes nothing (`READ_ONLY`), never dials, and hears what the writer lands through `db.changes` where the
engine has one; it hosts only over a shared log.

## Layers

`layered([top, …, bottom], { write, fill, queue, onError })` from `@alexify/syncom/layered` is one fsi over
several (a memory layer over the disk, the disk over a remote store) that reads as a multi-level cache and
writes to every layer in list order.

| Option | Default | Meaning |
| --- | --- | --- |
| `write` | `'through'` | `'through'`: a write resolves when the last layer has it (durability is the bottom's). `'back'`: it resolves when the top has it, and the lower layers are written from a queue, one call at a time |
| `fill` | `true` | A read that hits a lower layer copies the content into every layer above it |
| `queue` | `1024` | Calls the `'back'` queue holds; the next write waits for room |
| `onError` | none | Told every queued call that failed |

A read is the first layer that has the file, top down; `exists` the first hit; `list` the union of the
layers' names, sorted. A write or a removal lands on every layer, top to bottom. Under `'back'`, an operation
that would consult a lower layer (a read that misses the top, `exists`, `list`, `create`, `sync`) first drains
the queue, so nothing stale is read from below; a read that hits the top never waits. `flush()` awaits the
queue and rejects with the first failure since the last flush, as do `sync()` and `close()`; a read that
waited for the queue never throws one. `failed` counts the failures, `pending` what the queue holds. What the
queue holds is lost with the process. `create` is refused when any layer has the file (a `lock.json` on the
disk is a lock whatever the memory holds); `sync` reaches every layer that has one; `append` exists when every
layer has one, and a file only a lower layer holds is copied up first. `close()` flushes and closes every
layer that has a `close()`. A database opened over the bottom layer alone reads what the stack wrote.

## Encrypted at rest

`atRest(fsi | engine, { key } | { password, salt, iterations })` from `@alexify/syncom/encryption` makes every
value the medium holds AES-256-GCM ciphertext under one key: 32 bytes or a Web Crypto AES-GCM `CryptoKey`, or a
key derived by PBKDF2-SHA-256 from a password and a salt the application keeps (8 characters or more), 600 000
rounds by default. The key is never written.

Over an fsi every file is sealed (records, log, catalog, tags, `node.json`, the lock, the keys), bound to its
file name: a file copied over another does not decrypt. `exists`, `remove`, `list`, `sync` and `create` pass
through; there is no `append` (a file is one ciphertext), so the log writes a file per group. Over an engine
(memory, IndexedDB, SQLite, MongoDB) every value is sealed (a record as one text, its pieces, a tag's copies,
the kv texts, each log entry and the log's index) and the keys stay in the clear (ids, seqs, tag names, kv
keys, the index's `floor`); each value is bound to its place and to the database's path, so a ciphertext
moved to another path of the engine does not open. A blob is sealed as bytes, 28 over its own size, its digest
a name. The wrapped engine keeps no index of its own (`indexes` false). The files engine is wrapped at its
backend, `filesEngine(atRest(fsi, options))`, never as an engine.

What it does not hide or prevent: the names of files and keys and their sizes, and an older ciphertext put
back in its place. A value that is not the key's is `DECRYPT_FAILED` with a `reason`: `'key'` (another key, a
torn ciphertext, a blob never sealed or moved), `'plain'` (a text never encrypted), `'torn'` (not base64); the
first such file fails `createDatabase()`. The key is rotated by a copy (`rotateAtRest`), which fences the
source with `moved.json` (`MOVED`). See [Encryption](../guide/encryption).

## An engine over a port

`serveEngine(engine, port, { allow })` from `@alexify/syncom/engines` answers the engine contract over a message
port (a worker thread, a Web Worker, a SharedWorker); `connectEngine(port, { timeout })` is that
engine on the other side, asked what it is first, and `remoteEngine(port, { name, capabilities, timeout })` the
same without the question. Every call is one message and its answer, so the I/O runs off the database's thread;
the database stays where it is opened (its seqs are minted there) and only bytes cross.

A port is anything with `postMessage(message)` and one of two ways to listen: a Node.js port's
`on('message', listener)` that hands the listener the data itself (and `close` or `exit` when it goes), or a
web `MessagePort`'s `addEventListener('message', listener)` that hands it an event whose `data` is the message,
started with `start()` where the port has one (and `close` when it goes). Electron's `MessagePortMain` is
neither — its `on('message')` hands an event and it waits for `start()` — so it is served through a few lines
that shape it as a web port; [Electron](../guide/electron) shows them.

An error crosses with its code and fields (`EEXIST`, `INTEGRITY`, `LOCKED`…), never a file system's `path`,
`syscall` or `errno`; a change stream, a lease's life and its loss are pushed back; a group the served store
cannot write fails the append on the calling side. The served side trusts the port as it trusts the process,
no further: a call names a store and a method of the contract and nothing else, every key, id, tag, piece's
name and path is checked before a store sees it, and `remove(path)` takes only what that port opened, or the
paths `allow` lists, which also limits what the port may open. A port that closes or a worker that exits fails
every call waiting and every call after with `ENGINE_UNREACHABLE` (`reason: 'closed'`), and the served side lets
go of what the port held (its leases, subscriptions, databases); a call past `timeout` ms (0, the default,
waits) fails the same with `reason: 'timeout'`. `engine.stats()` is `{ inflight, oldestMs, calls, failures,
closed }`. See [Worker](../guide/storage-worker) and [Remote engine](../guide/storage-remote).

## Copying a database between engines

`copyEngine(from, to, { path, targetPath, batch })` from `@alexify/syncom/engines` copies the database at `path`
(to `targetPath` on the target, `path` by default; the same engine and path is a `TypeError`): every record
with its pieces, every tag's copies, every kv text of `KV_NAMESPACES` and the tags' namespaces (never
`lock.json`, `copy.json` or `moved.json`), the attachments' blobs, and the op log with its index (the sealed
entries as one segment; `batch`, 500 by default, records or log entries per write set). The node opens on the target as itself: the
same identity, epoch, vector and heads, so a peer resumes its cursor without a bootstrap.

Both databases are held as `createDatabase()` holds them (a lease lost on the way fails the copy with
`LEASE_LOST`). A target that holds `node.json` or a record is `TARGET_NOT_EMPTY`; a target without a blobs
store while the source holds blobs is `BLOBS_UNSUPPORTED`. The copy marks its target first (`copy.json`,
removed last), lands the identity (the keys, then `node.json`) last, and removes what it wrote when it fails;
a target marked without an identity is a copy cut short, taken away by the next copy before it begins. It
answers `{ records, pieces, copies, kv, entries, blobs }`. Two copies of one node are two writers of one
stream: once the copy is done, open the database through the new engine only, and remove it from the old one.
See [Storage migration](../guide/migration-storage).

## Testing an engine

`tests/suites/engine.js` is the engine contract as a test, run over the files engine on every backend that
ships and over every native engine; `tests/suites/fsi.js` is the fsi contract. Both live in the repository,
not in the published package: copy them, or run them from a clone, against an engine or a backend of your
own. An engine that does not pass the suite is not one.
