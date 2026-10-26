<div align="center">
  <img src="./docs/public/logo-mark.svg" width="96" height="96" alt="syncom">
  <h1>syncom</h1>
</div>

Fast, zero-dependency distributed data sync engine 🌐

[![npm](https://img.shields.io/npm/v/%40alexify%2Fsyncom)](https://www.npmjs.com/package/@alexify/syncom)
[![CI](https://github.com/Alexis-Technologies/syncom/actions/workflows/ci.yml/badge.svg)](https://github.com/Alexis-Technologies/syncom/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/%40alexify%2Fsyncom)](#installation)
[![dependencies](https://img.shields.io/badge/runtime_dependencies-0-brightgreen)](#bundle-size)
[![docs](https://img.shields.io/badge/docs-online-blue)](https://syncomjs.vercel.app/)
[![license](https://img.shields.io/npm/l/%40alexify%2Fsyncom)](./LICENSE)

`syncom` is a local-first data engine for JavaScript. It stores records on
disk — or in the browser's origin-private filesystem — commits every write to
a hash-linked log so tampering is detectable, and replicates every write to
peers as an operation that converges without coordination: last-writer-wins
registers, per-origin counters, observed-remove sets, lists and text that merge by
position, trees whose moves never form a cycle, tombstones. The transport is injected —
[wrpc](https://wrpc.vercel.app) out of the box — and the package has no
runtime dependencies.

```js
'use strict';

const { open } = require('@alexify/syncom');

const main = async () => {
  const storage = await open({ path: 'data' });

  const id = await storage.insert({ name: 'Ada' });
  const record = await storage.record(id);

  record.on('update', (data, delta) => console.log('changed', delta));

  record.name = 'Ada Lovelace'; // changed { name: 'Ada Lovelace' }
  await record.save();
  await storage.inc(id, 'hits', 1); // a counter: increments add up across nodes

  console.log(await storage.validate({ last: 10 })); // true
};

main();
```

📚 **[Documentation](https://syncomjs.vercel.app/)** ·
[Getting started](https://syncomjs.vercel.app/guide/getting-started) ·
[API reference](https://syncomjs.vercel.app/reference/api)

## Table of Contents

- [Installation](#installation)
- [Bundle size](#bundle-size)
- [Quick Start](#quick-start)
- [Features](#features)
- [Compared with alternatives](#compared-with-alternatives)
- [Benchmarks](#benchmarks)
- [Browser usage](#browser-usage)
- [Status](#status)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Changelog](#changelog)
- [Security](#security)
- [License](#license)

## Installation

Requires **Node.js ≥ 22**, or a modern browser with OPFS and Web Crypto.

```bash
npm install @alexify/syncom
```

### Bundle size

Measured by `pnpm size` on every CI run. Every browser entry carries a budget
that fails the build when exceeded; a subpath is off the main entry, so an app
pays for what it imports. The main entry is the core — records, the log,
queries, versions, the apply path; lists, texts and trees are the `text` and
`tree` plugins (`@alexify/syncom/text`, `/tree`), the identity and
signatures, the chain and the sealing of records the `signing`, `chain` and
`encryption` plugins (`/signing`, `/chain`, `/encryption`), the sync
manager the `sync` plugin (`/sync`), and `@alexify/syncom/all` is the core
with every plugin registered (see
[Entry points](https://syncomjs.vercel.app/guide/entry-points)).

| Entry | raw | min | min+gzip | budget |
| ----- | ---:| ---:| --------:| ------:|
| main entry — browser (@alexify/syncom) | 248.8 KB | 101.3 KB | 34.5 KB | 52.0 KB |
| main entry — node (@alexify/syncom) | 237.8 KB | 101.4 KB | 34.6 KB | — |
| wrpc adapter — browser (@alexify/syncom/wrpc) | 3.2 KB | 1.4 KB | 0.7 KB | 2.0 KB |
| contracts — browser (@alexify/syncom/contracts) | 4.2 KB | 1.9 KB | 1.0 KB | 1.0 KB |
| idb backend — browser (@alexify/syncom/idb) | 3.5 KB | 1.6 KB | 0.8 KB | 2.0 KB |
| search — browser (@alexify/syncom/search) | 4.1 KB | 1.6 KB | 0.9 KB | 2.0 KB |
| order — browser (@alexify/syncom/order) | 4.7 KB | 2.2 KB | 1.0 KB | 1.5 KB |
| undo — browser (@alexify/syncom/undo) | 35.7 KB | 16.8 KB | 6.3 KB | 6.5 KB |
| branch — browser (@alexify/syncom/branch) | 16.2 KB | 8.2 KB | 3.6 KB | 4.0 KB |
| all — browser (@alexify/syncom/all) | 492.6 KB | 210.6 KB | 72.8 KB | 73.0 KB |
| text — browser (@alexify/syncom/text) | 83.8 KB | 39.9 KB | 14.5 KB | 15.0 KB |
| tree — browser (@alexify/syncom/tree) | 28.3 KB | 13.7 KB | 5.3 KB | 5.5 KB |
| signing — browser (@alexify/syncom/signing) | 22.3 KB | 10.4 KB | 4.4 KB | 4.5 KB |
| chain — browser (@alexify/syncom/chain) | 9.5 KB | 4.3 KB | 1.9 KB | 2.5 KB |
| encryption — browser (@alexify/syncom/encryption) | 18.0 KB | 8.6 KB | 3.6 KB | 4.0 KB |
| memory — browser (@alexify/syncom/memory) | 2.1 KB | 0.8 KB | 0.5 KB | 0.8 KB |
| layered — browser (@alexify/syncom/layered) | 6.8 KB | 2.9 KB | 1.3 KB | 1.5 KB |
| sync — browser (@alexify/syncom/sync) | 104.7 KB | 44.7 KB | 16.2 KB | 18.0 KB |
| schema — browser (@alexify/syncom/schema) | 20.9 KB | 10.6 KB | 4.0 KB | 4.0 KB |
| telemetry — browser (@alexify/syncom/telemetry) | 15.7 KB | 6.6 KB | 2.6 KB | 4.0 KB |
| query — browser (@alexify/syncom/query) | 36.4 KB | 14.7 KB | 5.6 KB | 6.0 KB |
| versions — browser (@alexify/syncom/versions) | 145.5 KB | 62.8 KB | 22.0 KB | 30.0 KB |
| core + every block, in one bundle (= /all) | — | — | 72.7 KB | 72.8 KB ± 0.3 |

## Quick Start

```js
const { open, diff, merge } = require('@alexify/syncom');

// A schema turns entity names into collections.
const storage = await open({
  path: 'data',
  schema: { entities: { Post: {}, Author: {} } },
});

const author = await storage.Author.insert({ name: 'Ada' });
const post = await storage.Post.insert({ title: 'Draft', author: author.id });

// Records expose live properties and track their own delta.
post.title = 'Published';
console.log(post.delta());  // { title: 'Published' }
await post.save();

// Compare-and-swap, for writers that must not clobber each other.
await storage.swap(post.id, { title: 'Final' }, { title: 'Published' });

// The CRDT helpers work standalone, on plain objects. Numbers ADD, which is
// what lets two peers each increment a counter and converge.
merge({ hits: 10 }, { hits: 1 });              // { hits: 11 }
diff({ tags: ['a'] }, { tags: ['a', 'b'] });   // { tags: ['b'] }
```

### Syncing between nodes

Host one end on a [wrpc](https://wrpc.vercel.app) server, dial it from the
other. wrpc is yours to install — syncom only takes the client you built;
the manager is the `sync` plugin (`@alexify/syncom/sync`), registered by
`@alexify/syncom/all`:

```js
// the hub
const { Server, defineRouter } = require('@alexify/wrpc');
const { sync } = require('@alexify/syncom/sync');
const storage = await open({ path: 'hub', plugins: [sync] });
const router = defineRouter({ syncom: storage.sync.unit({ access: 'public' }) });
await new Server({ router, host: '0.0.0.0', port: 8000, protocol: 'http' }).listen();

// a node — a server, a CLI, a browser tab
const { WrpcClient } = require('@alexify/wrpc');
const { createWrpcLink } = require('@alexify/syncom/wrpc');
const storage = await open({
  path: 'data',
  plugins: [sync],
  sync: { connect: async (node) => createWrpcLink(await WrpcClient.connect(node.url)) },
});
await storage.sync.addNode({ url: 'ws://hub.example.com:8000/api' });
```

Every node can be both, and ops relay hop by hop, so any connected graph of
nodes converges.

## Features

| Area | What you get |
| --- | --- |
| **Storage** | Records with live properties and per-record deltas, schema-driven collections, compare-and-swap writes, transactions (`transact()`: several writes appended as one, all or none, with a signed message), encryption at rest (AES-256-GCM under an RSA-wrapped key), `purge()` for the right to be forgotten, `repair(id)` from the log |
| **Field kinds** | A field is a register, a counter (`inc()`), a set (`add()`/`remove()`), a list or a text (`splice()`, `push()`, `updateText()`; `setAt()`/`move()` on a list), or a tree (`treeMove()`/`treeRemove()`). A text carries marks (`mark()`, `unmark()`, `unmarkById()`, `spans()`) and embeds and block markers (`insertEmbed()`, `splitBlock()`, `joinBlock()`, `updateBlock()`, `block()`, `blocks()`), and `cursor()`/`index()` name a place that survives edits; `@alexify/syncom/order` mints fractional indexes for ordering records. See [Lists, text and trees](https://syncomjs.vercel.app/guide/lists) |
| **Schema** | A metaschema model, any Standard Schema (zod, valibot, arktype), ajv or a compiled JSON Schema validates every write before it is stamped — locally and again on the hub. Versions ride on ops; an older record reads through a lens (migrations, then the validator's aliases and defaults); `migrate()` rewrites it. See [Schema and validation](https://syncomjs.vercel.app/guide/schema) |
| **TypeScript** | Hand-written, `tsd`-tested types; a storage typed by its options — a collection per entity, the methods of its plugins — and records typed from the entity's Standard Schema (`SchemaOutput`/`SchemaInput`) or a `Schema<Shapes>` annotation: `storage.Post.get(id)` is `Post \| null`, a query names the record's fields, a live record has a property per field. See [TypeScript](https://syncomjs.vercel.app/guide/typescript) |
| **Editors** | `@alexify/syncom/codemirror` binds CodeMirror 6 (a ChangeSet as exact splices, undo through the storage, cursors as decorations); `@alexify/syncom/prosemirror` binds ProseMirror (its modules injected): the document as one text with block markers, a peer's edit as one replace step, undo through the storage, a presence room's cursors as decorations. `@alexify/syncom/editor` binds any editor to a text field through three functions of an adapter: edits leave as one transaction each, a peer's land as deltas rebased over what the editor holds, a delta the field moved under is refused (`STALE`) and sent again rebased; `diffBlocks()` for an editor that hands over a whole document; selections as cursor tokens, a presence room's cursors resolved. See [Editors](https://syncomjs.vercel.app/guide/editors) |
| **Frameworks** | `@alexify/syncom/store`: a query, a live record, a record through `get()`, a presence room or any emitter as one store object — Svelte's store contract and React's `useSyncExternalStore` read it as it is, Vue and Solid wrap it in a line; no framework imported. See [Frameworks](https://syncomjs.vercel.app/guide/frameworks) |
| **Queries** | `select({ orgId, status: { $in } }).order('name').limit(20).fetch()` over an in-memory record catalog: indexed queries with no I/O, unique keys, `watch()` for live views. See [Queries](https://syncomjs.vercel.app/guide/query) |
| **Full-text search** | `select({ $text: 'quick fox' })`: fuzzy, typo-tolerant, TF-IDF ranked trigram search over an entity's `search` fields, best first, narrowed by any equality — the index is `@alexify/syncom/search` (under 1 KB), injected at `open({ search })`. See [Full-text search](https://syncomjs.vercel.app/guide/query#full-text-search) |
| **Backends** | node:fs, OPFS, IndexedDB (`@alexify/syncom/idb`) or memory — five functions injected at `open({ fsi })`; `durable: true` for fsync, one instance per directory. See [Backends](https://syncomjs.vercel.app/guide/backends) |
| **Replication** | Every write is an op in a persisted log; peers exchange ops over an injected link, resume from where they stopped, and bootstrap from a streamed snapshot when they cannot; scopes for partial replication; presence (`@alexify/syncom/presence`: who is here and what they edit, relayed by a host's rooms, signed, never logged) |
| **Versions** | `history(id)` and `get(id, { at })` by event id, stamp or vector, folded from the log; tags of the whole storage (`tag()`, `at(name)`); `diff()`, `restore()`, `applyPatches()` and `compact(id)`, every way back new ops that merge; an undo stack (`@alexify/syncom/undo`) and branches that merge back (`@alexify/syncom/branch`). See [Versions and history](https://syncomjs.vercel.app/guide/versions) |
| **Convergence** | Last-writer-wins registers, per-origin counters, observed-remove sets, lists and text that merge by position (Fugue — each writer's run whole), trees whose concurrent moves never form a cycle, tombstones with revival — any order, any number of times, same result. A field two nodes make as different kinds at once ends as the same kind everywhere, by a fixed precedence; what a peer can make a node hold is bounded. See [Sync](https://syncomjs.vercel.app/guide/sync#registers-counters-sets-lists-and-text) |
| **Transport** | `@alexify/syncom/wrpc` adapts a `WrpcClient` — over a WebSocket, or a WebRTC `PeerLink`'s `remote` from `@alexify/wrpc/webrtc`; `storage.sync.unit()` is the router unit a wrpc server, or a browser's `PeerHost`, mounts. Reconnects, resumable subscriptions, binary streams and rooms come from wrpc. See [WebRTC](https://syncomjs.vercel.app/guide/webrtc) |
| **Integrity** | Every write appends a hash-linked block (`chain: false` turns it off for a hub); reads re-verify the record against the block that committed it and throw on a mismatch; `repair(id)` rebuilds a record from the log |
| **Signed ops** | Every op is signed with the node's Ed25519 key, and the node id *is* that key: a peer verifies an op against its origin through any relay, a purge leaves a header that still verifies, `sync.signatures: 'require'` refuses unsigned ops. See [Signatures](https://syncomjs.vercel.app/guide/sync#signatures) |
| **CRDT** | `diff` / `merge` / `apply` over plain objects — nested maps merge recursively, arrays are grow-only sets, numbers add so counters converge |
| **Contracts** | `@alexify/syncom/contracts`: store a procedure in the chain by hash, load it anywhere, run it against a read-only view of storage; failures are recorded as blocks. A subpath, so the package root never runs a block's code |
| **Portability** | One API over `node:fs` + `node:crypto` on the server and OPFS + Web Crypto in the browser, chosen by the `browser` export condition |
| **Hooks and events** | `open({ hooks })` runs your code inside a write, a read or a peer's batch — validate, stamp, redact, skip — and rejects with a typed `HookError` when it throws; `on()` events (`change`, `commit`, `apply`, `peer`, `sync`, …) observe everything and can never break it. See [Hooks and events](https://syncomjs.vercel.app/guide/hooks) |
| **Observability** | Injected OpenTelemetry (`open({ telemetry })`): spans for local writes, applied batches, pushes, bootstraps, log rolls, tags, history reads and patches, plus outcome and lag metrics — nested under wrpc's spans, which carry the trace across the wire. `stats()` reports the queue, the cache, the log, the tags and the files that lag the log. See [OpenTelemetry](https://syncomjs.vercel.app/guide/telemetry); `@alexify/syncom/inspect` lays a record out raw and anonymizes a dump for a bug report |
| **Scaling** | Hubs that dial each other, scopes as buckets, per-peer push limits, a reserved shared-log contract for the broker-backed hub. See [Scaling](https://syncomjs.vercel.app/guide/scaling) |
| **Dependencies** | None. wrpc, metaschema and fake-indexeddb are devDependencies for the integration tests; everything is injected at runtime |

## Compared with alternatives

syncom sits where the CRDT libraries (Yjs, Automerge, Loro), the local-first databases
(Jazz, RxDB, PouchDB, TinyBase, Dexie Cloud, Fireproof), the peer-to-peer and event-sourced stores
(GUN, OrbitDB, Evolu, LiveStore) and the sync services (ElectricSQL, PowerSync, Zero, Triplit,
InstantDB) meet. The [comparison](https://syncomjs.vercel.app/guide/comparison) puts all
nineteen in one table of forty-eight features, each cell decided from the published source. In short:
syncom is a database that merges field by field — and whose list, text and tree fields merge by
position, with marks, cursors and moves, like a text CRDT's — with tags, history, undo and
branches on top, bound to ProseMirror, CodeMirror and the UI frameworks through subpaths. It syncs
with no service to run, its hosts validate and scope what peers send, and its log is verifiable and
purgeable. It is a pre-release, not on npm yet.
RxDB, the closest of them, is compared [feature by feature](https://syncomjs.vercel.app/guide/vs-rxdb)
in 300 rows, from its code and every page of its docs, and Yjs, Automerge and Loro
[as CRDT libraries](https://syncomjs.vercel.app/guide/vs-crdt) in 141 rows, from their code.

## Benchmarks

Measured against Yjs, Automerge, Loro, TinyBase, PouchDB, RxDB, Fireproof, GUN and OrbitDB on
the same scenarios: insert, update, read, a converging counter, a batch, replicating a store,
in memory and on disk, and typing into a text, in memory. Each library runs in a fresh process,
is used the way its documentation shows, and is checked to give the right answer before it is
timed. The method and the interactive charts are on the
[Benchmarks](https://syncomjs.vercel.app/guide/benchmarks) page.

<!-- bench:compare:start -->
<!-- generated by `pnpm bench:report` from bench/results — edit the results, not this block -->

<img src="https://syncomjs.vercel.app/benchmarks/compare-sync-memory.svg" alt="Replicate a store, in memory: An empty replica pulls a store of 1,000 records, in process, through the library's own sync protocol, until every record reads back. Nothing touches the disk. records/s, log scale, higher is better. Not shown: Fireproof (syncs through a cloud or self-hosted gateway only); GUN (needs its storage adapter to answer in Node.js)." width="760" />

<img src="https://syncomjs.vercel.app/benchmarks/compare-insert-disk.svg" alt="Insert a record, on disk: Add one record to a store of 1,000. Each library's own persistence on node:fs, every write awaited. ops/s, log scale, higher is better. Not shown: RxDB (Node.js disk storages are Premium)." width="760" />

<details>
<summary>17 more scenarios</summary>

<img src="https://syncomjs.vercel.app/benchmarks/compare-insert-memory.svg" alt="Insert a record, in memory: Add one record to a store of 1,000. Nothing touches the disk. ops/s, log scale, higher is better. Not shown: GUN (needs its storage adapter to answer in Node.js)." width="760" />

<img src="https://syncomjs.vercel.app/benchmarks/compare-update-memory.svg" alt="Update a field, in memory: Change one field of an existing record. Nothing touches the disk. ops/s, log scale, higher is better. Not shown: GUN (needs its storage adapter to answer in Node.js)." width="760" />

<img src="https://syncomjs.vercel.app/benchmarks/compare-update-disk.svg" alt="Update a field, on disk: Change one field of an existing record. Each library's own persistence on node:fs, every write awaited. ops/s, log scale, higher is better. Not shown: RxDB (Node.js disk storages are Premium)." width="760" />

<img src="https://syncomjs.vercel.app/benchmarks/compare-get-memory.svg" alt="Read a record, in memory: Read one record by id, as a plain object. Nothing touches the disk. ops/s, log scale, higher is better. Not shown: GUN (needs its storage adapter to answer in Node.js)." width="760" />

<img src="https://syncomjs.vercel.app/benchmarks/compare-get-disk.svg" alt="Read a record, on disk: Read one record by id, as a plain object. Each library's own persistence on node:fs, every write awaited. ops/s, log scale, higher is better. Not shown: RxDB (Node.js disk storages are Premium)." width="760" />

<img src="https://syncomjs.vercel.app/benchmarks/compare-inc-memory.svg" alt="Increment a counter, in memory: Add 1 to a counter that converges when replicas increment it concurrently. Nothing touches the disk. ops/s, log scale, higher is better. Not shown: Yjs (no counter that converges); TinyBase (no counter that converges); PouchDB (no counter that converges); RxDB (no counter that converges); Fireproof (no counter that converges); GUN (needs its storage adapter to answer in Node.js); OrbitDB (no counter that converges)." width="760" />

<img src="https://syncomjs.vercel.app/benchmarks/compare-inc-disk.svg" alt="Increment a counter, on disk: Add 1 to a counter that converges when replicas increment it concurrently. Each library's own persistence on node:fs, every write awaited. ops/s, log scale, higher is better. Not shown: Yjs (no counter that converges); TinyBase (no counter that converges); PouchDB (no counter that converges); RxDB (Node.js disk storages are Premium); Fireproof (no counter that converges); GUN (no counter that converges); OrbitDB (no counter that converges)." width="760" />

<img src="https://syncomjs.vercel.app/benchmarks/compare-bulk-memory.svg" alt="Insert 1,000 at once, in memory: Add 1,000 records in one call or transaction. Nothing touches the disk. records/s, log scale, higher is better. Not shown: GUN (needs its storage adapter to answer in Node.js)." width="760" />

<img src="https://syncomjs.vercel.app/benchmarks/compare-bulk-disk.svg" alt="Insert 1,000 at once, on disk: Add 1,000 records in one call or transaction. Each library's own persistence on node:fs, every write awaited. records/s, log scale, higher is better. Not shown: RxDB (Node.js disk storages are Premium); GUN (failed: no acknowledgement in 30000 ms)." width="760" />

<img src="https://syncomjs.vercel.app/benchmarks/compare-sync-disk.svg" alt="Replicate a store, on disk: An empty replica pulls a store of 1,000 records, in process, through the library's own sync protocol, until every record reads back. Each library's own persistence on node:fs, every write awaited. records/s, log scale, higher is better. Not shown: RxDB (Node.js disk storages are Premium); Fireproof (syncs through a cloud or self-hosted gateway only); GUN (syncs over its WebSocket/WebRTC mesh only)." width="760" />

<img src="https://syncomjs.vercel.app/benchmarks/compare-append-memory.svg" alt="Type at the end of a text, in memory: Insert one character at the end of a text that merges by position — the common keystroke. Nothing touches the disk. ops/s, log scale, higher is better. Not shown: TinyBase (no text that merges by position); PouchDB (no text that merges by position); RxDB (no text that merges by position); Fireproof (no text that merges by position); GUN (needs its storage adapter to answer in Node.js); OrbitDB (no text that merges by position)." width="760" />

<img src="https://syncomjs.vercel.app/benchmarks/compare-append-disk.svg" alt="Type at the end of a text, on disk: Insert one character at the end of a text that merges by position — the common keystroke. Each library's own persistence on node:fs, every write awaited. ops/s, log scale, higher is better. Not shown: TinyBase (no text that merges by position); PouchDB (no text that merges by position); RxDB (Node.js disk storages are Premium); Fireproof (no text that merges by position); GUN (no text that merges by position); OrbitDB (no text that merges by position)." width="760" />

<img src="https://syncomjs.vercel.app/benchmarks/compare-prepend-memory.svg" alt="Type at the start of a text, in memory: Insert one character at the start of the text — every insert anchors into the same spot. Nothing touches the disk. ops/s, log scale, higher is better. Not shown: TinyBase (no text that merges by position); PouchDB (no text that merges by position); RxDB (no text that merges by position); Fireproof (no text that merges by position); GUN (needs its storage adapter to answer in Node.js); OrbitDB (no text that merges by position)." width="760" />

<img src="https://syncomjs.vercel.app/benchmarks/compare-prepend-disk.svg" alt="Type at the start of a text, on disk: Insert one character at the start of the text — every insert anchors into the same spot. Each library's own persistence on node:fs, every write awaited. ops/s, log scale, higher is better. Not shown: TinyBase (no text that merges by position); PouchDB (no text that merges by position); RxDB (Node.js disk storages are Premium); Fireproof (no text that merges by position); GUN (no text that merges by position); OrbitDB (no text that merges by position)." width="760" />

<img src="https://syncomjs.vercel.app/benchmarks/compare-random-memory.svg" alt="Type anywhere in a text, in memory: Insert one character at a random position of the text (seeded). Nothing touches the disk. ops/s, log scale, higher is better. Not shown: TinyBase (no text that merges by position); PouchDB (no text that merges by position); RxDB (no text that merges by position); Fireproof (no text that merges by position); GUN (needs its storage adapter to answer in Node.js); OrbitDB (no text that merges by position)." width="760" />

<img src="https://syncomjs.vercel.app/benchmarks/compare-random-disk.svg" alt="Type anywhere in a text, on disk: Insert one character at a random position of the text (seeded). Each library's own persistence on node:fs, every write awaited. ops/s, log scale, higher is better. Not shown: TinyBase (no text that merges by position); PouchDB (no text that merges by position); RxDB (Node.js disk storages are Premium); Fireproof (no text that merges by position); GUN (no text that merges by position); OrbitDB (no text that merges by position)." width="760" />

<img src="https://syncomjs.vercel.app/benchmarks/compare-trace-memory.svg" alt="Replay an editing trace, in memory: The automerge-perf trace: 259,778 keystrokes of a real paper (182,315 inserts, 77,463 deletes) replayed into one text as an editor would send them, the text read back whole at the end. Nothing touches the disk. ops/s, log scale, higher is better. Not shown: TinyBase (no text that merges by position); PouchDB (no text that merges by position); RxDB (no text that merges by position); Fireproof (no text that merges by position); GUN (needs its storage adapter to answer in Node.js); OrbitDB (no text that merges by position)." width="760" />

</details>

**In memory**

| Library | Insert a record<br><sub>ops/s</sub> | Update a field<br><sub>ops/s</sub> | Read a record<br><sub>ops/s</sub> | Increment a counter<br><sub>ops/s</sub> | Insert 1,000 at once<br><sub>records/s</sub> | Replicate a store<br><sub>records/s</sub> | Type at the end of a text<br><sub>ops/s</sub> | Type at the start of a text<br><sub>ops/s</sub> | Type anywhere in a text<br><sub>ops/s</sub> | Replay an editing trace<br><sub>ops/s</sub> |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **syncom**<br><sub>core + text + sync, memory() · v0.0.1</sub> | 44,100 | 42,600 | 897,000 | 43,400 | 42,700 | 88,100 | 35,800 | 20,900 | 19,100 | 12,700 |
| **syncom**<br><sub>/all: signed, chained, memory() · v0.0.1</sub> | 12,100 | 15,100 | 891,000 | 14,800 | 15,100 | 16,700 | 14,000 | 11,800 | 11,600 | 10,700 |
| Yjs<br><sub>Y.Doc, a Y.Map per record · v13.6.33</sub> | 221,000 | 398,000 | 3,690,000 | — | 219,000 | 89,400 | 363,000 | 537,000 | 31,100 | 53,000 |
| Automerge<br><sub>Automerge.change, Counter · v3.5.0</sub> | 510 | 1,960 | 10,500,000 | 1,880 | 8,970 | 22,000 | 24,300 | 22,700 | 22,100 | 18,400 |
| Loro<br><sub>LoroDoc, a LoroMap per record · v1.16.4</sub> | 32,200 | 404,000 | 260,000 | 333,000 | 83,800 | 102,000 | 624,000 | 453,000 | 320,000 | 482,000 |
| TinyBase<br><sub>MergeableStore · v10.0.1</sub> | 23,800 | 104,000 | 1,430,000 | — | 23,400 | 11,700 | — | — | — | — |
| PouchDB<br><sub>pouchdb-adapter-memory · v9.0.0</sub> | 20,200 | 8,240 | 30,500 | — | 73,300 | 17,800 | — | — | — | — |
| RxDB<br><sub>memory storage · v17.6.0</sub> | 38,200 | 49,500 | 299,000 | — | 2,210,000 | 61,900 | — | — | — | — |
| Fireproof<br><sub>memory:// store · v0.24.19</sub> | 353 | 372 | 710 | — | 22,200 | — | — | — | — | — |
| OrbitDB<br><sub>documents, memory blockstore · v4.0.0</sub> | 1,070 | 29.8 | 80.3 | — | 1,070 | 219 | — | — | — | — |

**On disk**

| Library | Insert a record<br><sub>ops/s</sub> | Update a field<br><sub>ops/s</sub> | Read a record<br><sub>ops/s</sub> | Increment a counter<br><sub>ops/s</sub> | Insert 1,000 at once<br><sub>records/s</sub> | Replicate a store<br><sub>records/s</sub> | Type at the end of a text<br><sub>ops/s</sub> | Type at the start of a text<br><sub>ops/s</sub> | Type anywhere in a text<br><sub>ops/s</sub> |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **syncom**<br><sub>core + text + sync, node:fs · v0.0.1</sub> | 2,930 | 3,450 | 866,000 | 3,380 | 7,050 | 7,420 | 4,870 | 1,120 | 1,900 |
| **syncom**<br><sub>/all: signed, chained, node:fs · v0.0.1</sub> | 2,470 | 2,860 | 903,000 | 2,810 | 5,990 | 5,520 | 3,980 | 1,050 | 1,770 |
| Yjs<br><sub>y-leveldb · v13.6.33</sub> | 18,900 | 20,900 | 3,780,000 | — | 141,000 | 53,400 | 22,500 | 23,800 | 14,600 |
| Automerge<br><sub>automerge-repo, NodeFS storage · v3.5.0</sub> | 485 | 1,220 | 10,500,000 | 1,170 | 7,690 | 3,130 | 3,350 | 3,330 | 3,270 |
| Loro<br><sub>updates appended to a file · v1.16.4</sub> | 19,000 | 42,300 | 277,000 | 42,200 | 63,400 | 103,000 | 46,600 | 45,600 | 41,200 |
| TinyBase<br><sub>MergeableStore, file persister · v10.0.1</sub> | 165 | 297 | 1,400,000 | — | 15,400 | 10,900 | — | — | — |
| PouchDB<br><sub>LevelDB (Node default) · v9.0.0</sub> | 25,700 | 8,070 | 41,500 | — | 69,300 | 17,100 | — | — | — |
| Fireproof<br><sub>file:// store · v0.24.19</sub> | 296 | 307 | 703 | — | 19,600 | — | — | — | — |
| GUN<br><sub>RAD on node:fs · v0.2020.1241</sub> | 3.67 | 3.74 | 755 | — | failed | — | — | — | — |
| OrbitDB<br><sub>documents, LevelDB · v4.0.0</sub> | 906 | 17 | 80.6 | — | 945 | 196 | — | — | — |

_Apple M3 Max · 16 cores · Node v24.14.1 · median of 5 × 1 s samples (5 rounds for a batch or a replication), each library in a fresh process · 2026-10-26. Medians, rounded to three significant figures; — where the library has no such operation, no such storage, or no in-process sync, failed where it did not finish twice (the chart above says why)._

<!-- bench:compare:end -->

### Cold start

<!-- bench:coldstart:start -->
<!-- generated by `pnpm bench:report` from bench/results — edit the results, not this block -->

<img src="https://syncomjs.vercel.app/benchmarks/coldstart.svg" alt="Cold start: Load the library, open a store of 1,000 records on disk, read one: a fresh process, median of 10 runs. Lower is better." width="760" />

<!-- bench:coldstart:end -->

### Bundle size

<!-- bench:size:start -->
<!-- generated by `pnpm bench:report` from bench/results — edit the results, not this block -->

<img src="https://syncomjs.vercel.app/benchmarks/size.svg" alt="Bundle size: What a browser app ships to keep records on the device and sync them (esbuild, minified, tree-shaken, the network client left out), min+gzip, WebAssembly included. Lower is better." width="760" />

| Library | What is bundled | min | min+gzip |  |
| --- | --- | ---: | ---: | --- |
| GUN<br><sub>gun@0.2020.1241</sub> | gun (localStorage; its WebSocket mesh is built in) | 42.2 KB | 17.1 KB |  |
| TinyBase<br><sub>tinybase@10.0.1</sub> | MergeableStore + IndexedDB persister + custom synchronizer | 56.4 KB | 23.8 KB |  |
| Yjs<br><sub>yjs@13.6.33, y-indexeddb@9.0.12, y-protocols@1.0.7</sub> | yjs + y-indexeddb + y-protocols/sync | 80.2 KB | 24.5 KB |  |
| PouchDB<br><sub>pouchdb-browser@9.0.0</sub> | pouchdb-browser | 117.8 KB | 40.4 KB | pouchdb-browser carries its HTTP adapter (the CouchDB client) with it |
| **syncom**<br><sub>@alexify/syncom@0.0.1</sub> | the core over OPFS + the sync plugin + the wrpc link adapter | 156.8 KB | 53.6 KB | records, counters and sets, the op log and the sync protocol; texts and schemas are plugins of their own |
| RxDB<br><sub>rxdb@17.6.0, dexie@4.4.6, rxjs@7.8.2</sub> | rxdb + Dexie storage + replication | 282.3 KB | 90.1 KB |  |
| Fireproof<br><sub>@fireproof/core@0.24.19</sub> | @fireproof/core | 784.2 KB | 204.0 KB |  |
| OrbitDB<br><sub>@orbitdb/core@4.0.0, helia@6.1.4, libp2p@3.5.1, @libp2p/gossipsub@15.0.23, blockstore-idb@4.0.1</sub> | @orbitdb/core + helia + libp2p, IndexedDB blockstore | 1185.6 KB | 353.7 KB | createHelia brings Helia's default libp2p configuration with it |
| Loro<br><sub>loro-crdt@1.16.4</sub> | loro-crdt (no persistence of its own) | 3405.0 KB<br><sub>WebAssembly 3319.1 KB</sub> | 1114.8 KB |  |
| Automerge<br><sub>@automerge/automerge@3.5.0, @automerge/automerge-repo@2.6.0-alpha.3, @automerge/automerge-repo-storage-indexeddb@2.6.0-alpha.3</sub> | automerge-repo + IndexedDB storage | 3744.5 KB<br><sub>WebAssembly 3558.8 KB</sub> | 1171.9 KB |  |

<!-- bench:size:end -->

### syncom's own hot paths

<!-- bench:engine:start -->
<!-- generated by `pnpm bench:report` from bench/results — edit the results, not this block -->

<img src="https://syncomjs.vercel.app/benchmarks/engine-storage.svg" alt="Storage: syncom's own benchmarks: The public API end to end on node:fs: a write is an op appended to the log, a record file and a block. ops/s, log scale, higher is better." width="760" />

<!-- bench:engine:end -->

## Browser usage

The `browser` export condition selects `browser.js` automatically — no bundler
configuration needed.

```js
import { open, diff, merge } from '@alexify/syncom';
```

Crypto is asynchronous there (`calculateHash`, `encrypt`, `decrypt`, `sign` and
`verify` return promises), and storage lives in the origin-private filesystem — or in
IndexedDB through `open({ fsi: createIdbFsi() })` from `@alexify/syncom/idb`. `browser.d.ts`
declares those signatures separately. A browser node dials the mesh through
`@alexify/syncom/wrpc` like any other, and hosts for its peers over WebRTC.
See [Browser](https://syncomjs.vercel.app/guide/browser).

## Status

0.0.1 — a pre-release, not published to npm, and there is no release until the package does what it is meant
to; the API may still change. Everything on this page works today and is covered by the test suite, including
replication over real wrpc WebSockets. Known limits — a counter straddling a concurrent reset, encrypted records
staying local, no proof of key possession at `hello` — are on the
[Sync](https://syncomjs.vercel.app/guide/sync#guarantees-and-limits) page.

## Documentation

- [Why syncom?](https://syncomjs.vercel.app/guide/why) ·
  [Compared with alternatives](https://syncomjs.vercel.app/guide/comparison) ·
  [Compared with RxDB](https://syncomjs.vercel.app/guide/vs-rxdb) ·
  [Compared with CRDT libraries](https://syncomjs.vercel.app/guide/vs-crdt) ·
  [Benchmarks](https://syncomjs.vercel.app/guide/benchmarks) ·
  [Architecture](https://syncomjs.vercel.app/guide/architecture)
- [Getting started](https://syncomjs.vercel.app/guide/getting-started)
- [Storage](https://syncomjs.vercel.app/guide/storage) ·
  [Schema and validation](https://syncomjs.vercel.app/guide/schema) ·
  [Queries](https://syncomjs.vercel.app/guide/query) ·
  [Lists, text and trees](https://syncomjs.vercel.app/guide/lists) ·
  [Versions and history](https://syncomjs.vercel.app/guide/versions) ·
  [Hooks and events](https://syncomjs.vercel.app/guide/hooks) ·
  [CRDT deltas](https://syncomjs.vercel.app/guide/crdt) ·
  [Blockchain log](https://syncomjs.vercel.app/guide/chain) ·
  [Smart contracts](https://syncomjs.vercel.app/guide/contracts)
- [Sync](https://syncomjs.vercel.app/guide/sync) ·
  [wrpc transport](https://syncomjs.vercel.app/guide/wrpc) ·
  [WebRTC](https://syncomjs.vercel.app/guide/webrtc) ·
  [Scaling](https://syncomjs.vercel.app/guide/scaling)
- [Browser](https://syncomjs.vercel.app/guide/browser) ·
  [Backends](https://syncomjs.vercel.app/guide/backends) ·
  [OpenTelemetry](https://syncomjs.vercel.app/guide/telemetry)
- [API reference](https://syncomjs.vercel.app/reference/api) ·
  [Wire format](https://syncomjs.vercel.app/reference/wire)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

```bash
pnpm install
pnpm test              # node --test, recursive over tests/
pnpm test:coverage     # c8 over src/
pnpm test:types        # tsd against the .d.ts files
pnpm lint              # oxlint
pnpm format            # oxfmt (format:check in CI)
pnpm size              # bundle-size report; a browser budget exceeded fails the run
pnpm bench             # every script in bench/ (--save writes bench/results/engine.json)
pnpm bench:compare:install && pnpm bench:compare   # against the alternatives
pnpm bench:report      # the charts and the tables of the docs and this README
pnpm docs:comparison   # the comparison matrix from docs/comparison.json
pnpm docs:dev          # the VitePress site
```

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## Security

See [SECURITY.md](./SECURITY.md). Report vulnerabilities privately — do not
open a public issue.

## License

[MIT](./LICENSE) © Alexis Technologies
