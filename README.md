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
registers, per-origin counters, tombstones. The transport is injected —
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

  record.title = 'Ada Lovelace';
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

Measured by `pnpm size` on every CI run. The browser entry carries a budget
that fails the build when exceeded.

| Entry | raw | min | min+gzip | budget |
| ----- | ---:| ---:| --------:| ------:|
| main entry — browser (@alexify/syncom) | 254.8 KB | 105.5 KB | 36.6 KB | 37.0 KB |
| main entry — node (@alexify/syncom) | 240.6 KB | 104.4 KB | 36.1 KB | — |
| wrpc adapter — browser (@alexify/syncom/wrpc) | 3.4 KB | 1.4 KB | 0.7 KB | 2.0 KB |
| contracts — browser (@alexify/syncom/contracts) | 3.7 KB | 1.6 KB | 0.8 KB | 1.0 KB |
| idb backend — browser (@alexify/syncom/idb) | 3.7 KB | 1.7 KB | 0.8 KB | 2.0 KB |

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
other. wrpc is yours to install — syncom only takes the client you built:

```js
// the hub
const { Server, defineRouter } = require('@alexify/wrpc');
const router = defineRouter({ syncom: storage.sync.unit({ access: 'public' }) });
await new Server({ router, host: '0.0.0.0', port: 8000, protocol: 'http' }).listen();

// a node — a server, a CLI, a browser tab
const { WrpcClient } = require('@alexify/wrpc');
const { createWrpcLink } = require('@alexify/syncom/wrpc');
const storage = await open({
  path: 'data',
  sync: { connect: async (node) => createWrpcLink(await WrpcClient.connect(node.url)) },
});
await storage.sync.addNode({ url: 'ws://hub.example.com:8000/api' });
```

Every node can be both, and ops relay hop by hop, so any connected graph of
nodes converges.

## Features

| Area | What you get |
| --- | --- |
| **Storage** | Records with live properties and per-record deltas, schema-driven collections, compare-and-swap writes, counters, encryption at rest (AES-256-GCM under an RSA-wrapped key), `purge()` for the right to be forgotten |
| **Schema** | A metaschema model, any Standard Schema (zod, valibot, arktype), ajv or a compiled JSON Schema validates every write before it is stamped — locally and again on the hub. Versions ride on ops; an older record reads through a lens (migrations, then the validator's aliases and defaults); `migrate()` rewrites it. See [Schema and validation](https://syncomjs.vercel.app/guide/schema) |
| **Queries** | `select({ orgId, status: { $in } }).order('name').limit(20).fetch()` over an in-memory record catalog: indexed queries with no I/O, unique keys, `watch()` for live views. See [Queries](https://syncomjs.vercel.app/guide/query) |
| **Backends** | node:fs, OPFS, IndexedDB (`@alexify/syncom/idb`) or memory — five functions injected at `open({ fsi })`; `durable: true` for fsync, one instance per directory. See [Backends](https://syncomjs.vercel.app/guide/backends) |
| **Replication** | Every write is an op in a persisted log; peers exchange ops over an injected link, resume from where they stopped, and bootstrap from a streamed snapshot when they cannot; scopes for partial replication |
| **Convergence** | Last-writer-wins registers, per-origin counters, tombstones with revival — any order, any number of times, same result |
| **Transport** | `@alexify/syncom/wrpc` adapts a `WrpcClient` — over a WebSocket, or a WebRTC `PeerLink`'s `remote` from `@alexify/wrpc/webrtc`; `storage.sync.unit()` is the router unit a wrpc server, or a browser's `PeerHost`, mounts. Reconnects, resumable subscriptions, binary streams and rooms come from wrpc. See [WebRTC](https://syncomjs.vercel.app/guide/webrtc) |
| **Integrity** | Every write appends a hash-linked block (`chain: false` turns it off for a hub); reads re-verify the record against the block that committed it and throw on a mismatch; `repair(id)` rebuilds a record from the log |
| **CRDT** | `diff` / `merge` / `apply` over plain objects — nested maps merge recursively, arrays are grow-only sets, numbers add so counters converge |
| **Contracts** | `@alexify/syncom/contracts`: store a procedure in the chain by hash, load it anywhere, run it against a read-only view of storage; failures are recorded as blocks. A subpath, so the package root never runs a block's code |
| **Portability** | One API over `node:fs` + `node:crypto` on the server and OPFS + Web Crypto in the browser, chosen by the `browser` export condition |
| **Hooks and events** | `open({ hooks })` runs your code inside a write, a read or a peer's batch — validate, stamp, redact, skip — and rejects with a typed `HookError` when it throws; `on()` events (`change`, `apply`, `peer`, `sync`, …) observe everything and can never break it. See [Hooks and events](https://syncomjs.vercel.app/guide/hooks) |
| **Observability** | Injected OpenTelemetry (`open({ telemetry })`): spans for local writes, applied batches, pushes, bootstraps and log rolls, plus outcome and lag metrics — nested under wrpc's spans, which carry the trace across the wire. See [OpenTelemetry](https://syncomjs.vercel.app/guide/telemetry) |
| **Scaling** | Hubs that dial each other, scopes as buckets, per-peer push limits, a reserved shared-log contract for the broker-backed hub. See [Scaling](https://syncomjs.vercel.app/guide/scaling) |
| **Dependencies** | None. wrpc, metaschema and fake-indexeddb are devDependencies for the integration tests; everything is injected at runtime |

## Compared with alternatives

syncom sits where the CRDT libraries (Yjs, Automerge, Loro, Jazz), the local-first databases
(RxDB, PouchDB, TinyBase, Dexie Cloud, Fireproof), the peer-to-peer and event-sourced stores
(GUN, OrbitDB, Evolu, LiveStore) and the sync services (ElectricSQL, PowerSync, Zero, Triplit,
InstantDB) meet. The [comparison](https://syncomjs.vercel.app/guide/comparison) puts all
nineteen in one table of forty features, each cell decided from the published source. In short:
syncom is a database that merges field by field, not a text CRDT. It syncs with no service to
run, its hosts validate and scope what peers send, and its log is verifiable and purgeable. It
has no text or list CRDT, no signed ops and no UI bindings, and 1.0.0 is not on npm yet.

## Benchmarks

Measured against Yjs, Automerge, Loro, TinyBase, PouchDB, RxDB, Fireproof, GUN and OrbitDB on
the same scenarios: insert, update, read, a converging counter, a batch, replicating a store,
in memory and on disk. Each library runs in a fresh process, is used the way its documentation
shows, and is checked to give the right answer before it is timed. The method and the
interactive charts are on the [Benchmarks](https://syncomjs.vercel.app/guide/benchmarks) page.

<!-- bench:compare:start -->
<!-- generated by `pnpm bench:report` from bench/results — edit the results, not this block -->

<img src="https://syncomjs.vercel.app/benchmarks/compare-sync-memory.svg" alt="Replicate a store, in memory: An empty replica pulls a store of 1,000 records, in process, through the library's own sync protocol, until every record reads back. Nothing touches the disk. records/s, log scale, higher is better. Not shown: Fireproof (syncs through a cloud or self-hosted gateway only); GUN (needs its storage adapter to answer in Node.js)." width="760" />

<img src="https://syncomjs.vercel.app/benchmarks/compare-insert-disk.svg" alt="Insert a record, on disk: Add one record to a store of 1,000. Each library's own persistence on node:fs, every write awaited. ops/s, log scale, higher is better. Not shown: RxDB (Node.js disk storages are Premium)." width="760" />

<details>
<summary>10 more scenarios</summary>

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

</details>

**In memory**

| Library | Insert a record<br><sub>ops/s</sub> | Update a field<br><sub>ops/s</sub> | Read a record<br><sub>ops/s</sub> | Increment a counter<br><sub>ops/s</sub> | Insert 1,000 at once<br><sub>records/s</sub> | Replicate a store<br><sub>records/s</sub> |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **syncom**<br><sub>default, createMemoryFsi() · v1.0.0</sub> | 37,500 | 52,900 | 966,000 | 53,100 | 41,200 | 108,000 |
| **syncom**<br><sub>chain: false, createMemoryFsi() · v1.0.0</sub> | 44,300 | 78,400 | 983,000 | 79,400 | 61,100 | 127,000 |
| Yjs<br><sub>Y.Doc, a Y.Map per record · v13.6.33</sub> | 235,000 | 382,000 | 3,680,000 | — | 275,000 | 99,700 |
| Automerge<br><sub>Automerge.change, Counter · v3.5.0</sub> | 512 | 1,990 | 10,600,000 | 1,950 | 8,960 | 20,900 |
| Loro<br><sub>LoroDoc, a LoroMap per record · v1.16.4</sub> | 31,300 | 412,000 | 313,000 | 349,000 | 83,100 | 105,000 |
| TinyBase<br><sub>MergeableStore · v10.0.1</sub> | 22,900 | 108,000 | 1,460,000 | — | 23,700 | 11,500 |
| PouchDB<br><sub>pouchdb-adapter-memory · v9.0.0</sub> | 20,300 | 8,310 | 30,100 | — | 74,000 | 17,800 |
| RxDB<br><sub>memory storage · v17.6.0</sub> | 16,700 | 50,400 | 281,000 | — | 2,220,000 | 64,100 |
| Fireproof<br><sub>memory:// store · v0.24.19</sub> | 310 | 377 | 726 | — | 22,300 | — |
| OrbitDB<br><sub>documents, memory blockstore · v4.0.0</sub> | 1,080 | 31.1 | 81.4 | — | 1,090 | 220 |

**On disk**

| Library | Insert a record<br><sub>ops/s</sub> | Update a field<br><sub>ops/s</sub> | Read a record<br><sub>ops/s</sub> | Increment a counter<br><sub>ops/s</sub> | Insert 1,000 at once<br><sub>records/s</sub> | Replicate a store<br><sub>records/s</sub> |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **syncom**<br><sub>default, node:fs · v1.0.0</sub> | 1,490 | 1,590 | 896,000 | 1,810 | 1,850 | 6,950 |
| **syncom**<br><sub>chain: false, node:fs · v1.0.0</sub> | 2,450 | 3,500 | 955,000 | 3,560 | 3,100 | 7,400 |
| Yjs<br><sub>y-leveldb · v13.6.33</sub> | 19,200 | 22,400 | 3,690,000 | — | 155,000 | 53,700 |
| Automerge<br><sub>automerge-repo, NodeFS storage · v3.5.0</sub> | 490 | 1,250 | 10,500,000 | 1,200 | 7,820 | 3,100 |
| Loro<br><sub>updates appended to a file · v1.16.4</sub> | 19,500 | 43,300 | 285,000 | 42,600 | 66,900 | 108,000 |
| TinyBase<br><sub>MergeableStore, file persister · v10.0.1</sub> | 172 | 304 | 1,390,000 | — | 15,400 | 11,100 |
| PouchDB<br><sub>LevelDB (Node default) · v9.0.0</sub> | 26,400 | 8,810 | 42,000 | — | 65,500 | 16,500 |
| Fireproof<br><sub>file:// store · v0.24.19</sub> | 300 | 335 | 720 | — | 20,700 | — |
| GUN<br><sub>RAD on node:fs · v0.2020.1241</sub> | 3.63 | 3.77 | 749 | — | failed | — |
| OrbitDB<br><sub>documents, LevelDB · v4.0.0</sub> | 952 | 17.4 | 82.4 | — | 921 | 193 |

_Apple M3 Max · 16 cores · Node v24.14.1 · median of 5 × 1 s samples (5 rounds for a batch or a replication), each library in a fresh process · 2026-10-21. Medians, rounded to three significant figures; — where the library has no such operation, no such storage, or no in-process sync, failed where it did not finish twice (the chart above says why)._

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
| **syncom**<br><sub>@alexify/syncom@1.0.0</sub> | open() over OPFS + the wrpc link adapter | 107.2 KB | 37.3 KB | storage, schema, queries, the op log and the sync protocol are one entry |
| PouchDB<br><sub>pouchdb-browser@9.0.0</sub> | pouchdb-browser | 117.8 KB | 40.4 KB | pouchdb-browser carries its HTTP adapter (the CouchDB client) with it |
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

Crypto is asynchronous there (`calculateHash`, `encrypt` and `decrypt` return
promises), and storage lives in the origin-private filesystem — or in
IndexedDB through `open({ fsi: createIdbFsi() })` from `@alexify/syncom/idb`. `browser.d.ts`
declares those signatures separately. A browser node dials the mesh through
`@alexify/syncom/wrpc` like any other, and hosts for its peers over WebRTC.
See [Browser](https://syncomjs.vercel.app/guide/browser).

## Status

1.0.0, not yet published to npm. Everything on this page works today and is covered by the test suite,
including replication over real wrpc WebSockets. Known limits — a counter
straddling a concurrent reset, no op signatures, encrypted records staying
local — are listed under [Guarantees and limits](https://syncomjs.vercel.app/guide/sync#guarantees-and-limits).

## Documentation

- [Why syncom?](https://syncomjs.vercel.app/guide/why) ·
  [Compared with alternatives](https://syncomjs.vercel.app/guide/comparison) ·
  [Benchmarks](https://syncomjs.vercel.app/guide/benchmarks) ·
  [Architecture](https://syncomjs.vercel.app/guide/architecture)
- [Getting started](https://syncomjs.vercel.app/guide/getting-started)
- [Storage](https://syncomjs.vercel.app/guide/storage) ·
  [CRDT deltas](https://syncomjs.vercel.app/guide/crdt) ·
  [Blockchain log](https://syncomjs.vercel.app/guide/chain) ·
  [Smart contracts](https://syncomjs.vercel.app/guide/contracts)
- [Sync](https://syncomjs.vercel.app/guide/sync) ·
  [wrpc transport](https://syncomjs.vercel.app/guide/wrpc) ·
  [WebRTC](https://syncomjs.vercel.app/guide/webrtc) ·
  [Schema and validation](https://syncomjs.vercel.app/guide/schema) ·
  [Queries](https://syncomjs.vercel.app/guide/query) ·
  [Backends](https://syncomjs.vercel.app/guide/backends) ·
  [Scaling](https://syncomjs.vercel.app/guide/scaling) ·
  [Browser](https://syncomjs.vercel.app/guide/browser)
- [API reference](https://syncomjs.vercel.app/reference/api)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

```bash
pnpm install
pnpm test              # node --test, recursive over tests/
pnpm test:coverage     # c8 over src/
pnpm test:types        # tsd against the .d.ts files
pnpm lint              # oxlint
pnpm format            # oxfmt (format:check in CI)
pnpm size              # bundle-size report; the browser budget fails the run
pnpm bench             # every script in bench/ (--save writes bench/results/engine.json)
pnpm bench:compare:install && pnpm bench:compare   # against the alternatives
pnpm bench:report      # the charts and the tables of the docs and this README
pnpm docs:dev          # the VitePress site
```

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## Security

See [SECURITY.md](./SECURITY.md). Report vulnerabilities privately — do not
open a public issue.

## License

[MIT](./LICENSE) © Alexis Technologies
