<script setup>
import BenchCompare from '../.vitepress/theme/components/BenchCompare.vue';
import BenchFigure from '../.vitepress/theme/components/BenchFigure.vue';
</script>

# Compared with RxDB

[RxDB](https://rxdb.info) is the alternative closest to syncom. Both keep JSON records with a
schema on the device, query them with Mango selectors, watch them live, and replicate them without
a server of the project's own. They differ in what crosses the wire and in who decides the outcome
of a conflict. RxDB replicates the latest state of each document through checkpoints, and a
conflict is settled per document: the master's state wins by default, or your handler or its
CRDT plugin decides. syncom replicates every write as a signed operation and merges concurrent
writes field by field on every node, with counters that add up and sets that keep every
concurrent add.

The two also stand in different places. RxDB has been on npm since 2016. It is a broad plugin
ecosystem with storages for every JavaScript runtime and replication plugins for a dozen backends,
and part of its storage layer is paid (RxDB Premium). syncom is a zero-dependency pre-release
(0.0.1, not on npm yet), MIT from end to end, and much narrower.

This page compares the two feature by feature, every row decided from source code: 300
rows in eight sections. [Compared with alternatives](/guide/comparison) puts both next to seventeen
other libraries, and [Benchmarks](/guide/benchmarks) measures them on the same scenarios.

## What the table shows

- **RxDB is the broader toolkit.** It has storages for every JavaScript runtime, replication
  plugins for nine backends and handlers that sync with one you already run, a richer
  write API (bulk writes, `modify()`, Mongo update operators, update by query), sorted compound
  indexes, live queries that update without re-running (EventReduce), attachments, local
  documents, storage migration, backups, several tabs on one database, document types inferred
  from the schema, and React, Vue, Angular and signal bindings. In 51 rows RxDB has something
  where syncom has nothing; the rows are not equal in weight, so read the sections that matter to
  you.
- **syncom is the stricter replicator.** Every write is an operation that merges field by field
  on every node, with no plugin to turn on: concurrent edits to different fields both stay,
  counters add up, sets keep every concurrent add. Every op is signed by the key that is the
  node's id, a hash-linked chain re-checks what is read, `repair(id)` rebuilds a record from the
  log, and `purge()` erases a payload on every replica it reaches. Any node hosts, a browser
  included; the host limits, validates and reports. In 20 rows syncom has something where RxDB has
  nothing: signatures, a tamper-evident log, unique keys, multi-entry and combined indexes,
  projection, text search inside a query, OpenTelemetry, stats among them.
- **Several RxDB guarantees depend on a switch.** Without a `validate-*` storage wrapper,
  production RxDB stores documents with wrong types, unknown fields and missing required fields.
  `final` fields, frozen documents and the checks on queries and ids run only in dev-mode, and
  dev-mode in turn loads a hidden iframe from rxdb.info on any host that has no Premium flag. syncom has no such mode:
  validation is on for every entity with a schema, and the checks and full error messages are
  always on.
- **What is free.** In RxDB, disk persistence on Node.js (filesystem, SQLite), OPFS, native
  IndexedDB, WebCrypto encryption, full-text search, the worker storages and the logger are
  Premium, a yearly term license. The free core caps open collections at 13 per process (a 14th
  waits, a 15th throws), and its SQLite trial fails at the 251st serial insert. Everything in syncom is MIT, Node.js disk
  persistence and full-text search included.
- **Conflicts are settled differently.** RxDB's default handler keeps the server's document,
  whatever its time (several RxDB pages call it last-write-wins); a handler of your own, or the
  `crdt` plugin, merges instead. That plugin keeps every operation inside the document forever,
  orders concurrent ones by a random storage token, and `upsert()` writes around it. syncom's
  rules are fixed and cannot be replaced, a nested object is a single register, and a concurrent
  overwrite that loses is not reported.
- **Encryption ends at the device in both.** RxDB's free plugin is AES-CBC through crypto-js
  with an MD5 key derivation and no MAC, stores an unsalted hash of the password, and replicates
  encrypted fields in plain text. syncom seals a record with AES-GCM under an RSA key, but that key
  sits in the same directory, and a sealed record never syncs. Neither has end-to-end encryption
  built in or rotates a key.
- **Where syncom's checks stop.** A host that skips a peer's op (a failed validator or
  `beforeApply`) still relays it — a withheld op would be a gap in its origin's stream — so the
  peers behind it decide for themselves; what stops at the host is an op outside the peer's
  scopes (by the scope it declares or by its record's), a malformed or skewed one and a refused
  signature. A nested object merges as one register. Writes made offline before the first node
  was registered, and compacted since, cannot reach a host (it is reported). Making this page
  turned up a dozen syncom bugs, among them scopes a peer could write around, offline writes past
  retention that never arrived and a restored directory that forked its node in silence; they are
  fixed, with tests, and the cells describe the code as it is now.
- **Neither has** multi-record transactions, aggregation or joins. syncom has list and text
  fields that merge by position; RxDB's CRDT plugin has neither.
- **Maturity.** RxDB has been on npm since 2016, ships a minor about every month and a major
  about once a year (four of the last five asked users of some storages to migrate their stored
  data), and offers paid support. syncom is a pre-release with no users yet.

## How the table was made

- **RxDB 17.6.0, from its code.** The RxDB column is `rxdb@17.6.0`, the npm `latest` (released
  2026-10-05), read at its git tag. Every page of [rxdb.info](https://rxdb.info) was read too, all
  271 in its sitemap: the reference, the replication and storage pages, the release notes from 8.0
  to 17.0, and the articles and landing pages. So were the other repositories of the project:
  `rxdb-server` (RxServer), `event-reduce`, `broadcast-channel`, `jsonschema-key-compression`, the
  quickstart and example apps, and the issue tracker of the Premium plugins.
- **Checked by running it.** Where a claim was cheap to test, it was tested against the published
  package (memory storage, with and without dev-mode). Those runs settled the collection limit,
  the SQLite trial's caps, what production RxDB stores without a validator, and how the CRDT
  plugin keeps its operations. Where the docs and the code disagree, the cell follows the code
  and a footnote says so.
- **Premium is a feature, marked as paid.** RxDB Premium (Pro, Pro Plus) is closed source, so its
  cells follow the docs and the Premium page. They are ⚠️, say `Premium` and name the tier. Where
  the free core has a trial or a stub of a Premium plugin, the cell says what the free one does.
- **Changes after 17.6.0 are left out.** RxDB's main branch was 108 commits ahead of the tag when
  this was written. Unreleased changes stay in the data as details, never in a cell's verdict.
- **The syncom column is this repository**, at the version on the page, checked against its tests
  and by running it. Its gaps are in the table like RxDB's.
- **The data is in the repository.**
  [`docs/comparison-rxdb.json`](https://github.com/Alexis-Technologies/syncom/blob/main/docs/comparison-rxdb.json)
  keeps every cell with the file, line or page it was decided from. `pnpm docs:comparison`
  renders it into this page. If a cell is wrong, open an issue or edit the data.

## Concepts side by side

The closest syncom counterpart of each RxDB building block. Where there is none, the table says so.

| RxDB | syncom |
| --- | --- |
| `createRxDatabase({ name, storage })` | `open({ path, fsi })` |
| `RxStorage` (Dexie, memory, Premium OPFS…) | an `fsi`: five file functions (`node:fs`, OPFS, IndexedDB, memory) |
| `addCollections({ todos: { schema } })` | `open({ schema: { entities: { Todo: { schema } } } })` → `storage.Todo` |
| `primaryKey` field of the document | the record id, outside the data (`getId`, or `set(id, data)`) |
| `validate-ajv` storage wrapper | an entity `schema` (Standard Schema, a function, or `validator.compile()`), on by default |
| `version` + `migrationStrategies`, per collection | `schema.version` + `schema.migrations`, per storage: a lens on read, `migrate()` to rewrite |
| `RxDocument` | a live `Record` (`storage.record(id)`) or a JSON copy (`get(id)`) |
| `insert()` / `upsert()` | `insert()` (id generated) / `set(id, data)` |
| `patch()` / `incrementalPatch()` | `update(id, delta)`, or a `Record`'s fields and `save()` |
| a stale `_rev` throws 409 | `swap(id, changes, prev)`, compared inside the write queue |
| `$inc` (merges only with the `crdt` plugin) | `inc(id, field, n)`, merges always |
| `$addToSet` / `$pullAll` | `add()` / `remove()`: an observed-remove set |
| `remove()` → `_deleted`, then the `cleanup` plugin | `delete()` → a tombstone; `purge(id)` erases the payload from the log |
| `collection.find(query).exec()` | `collection.select(query).fetch()` |
| `findOne(id)` | `get(id)` / `record(id)` |
| `sort`, `skip`, `limit` | `order()` / `desc()`, `offset()`, `limit()` |
| schema `indexes` | entity `index`, and `unique` |
| `query.$` | `cursor.watch(listener)` |
| `doc.$` / `collection.$` | a `Record`'s `update` event / the storage's `change` event |
| Premium full-text search (FlexSearch) | `$text` with `createSearch()` from `@alexify/syncom/search` |
| `preInsert` / `preSave` / `preRemove` hooks | `beforeWrite(ctx)` |
| `postInsert` / `postSave` / `postRemove` hooks | `afterWrite(ctx, op)` |
| `replicateRxCollection({ pull, push })` | `storage.sync.addNode({ url })` over an injected link |
| RxServer, or your own endpoints | `storage.sync.unit()`, mounted on a wrpc server by any node |
| `conflictHandler` | none: fixed per-field rules; `beforeApply` can skip a peer's op |
| `pull.modifier` / `push.modifier` | `beforeApply` (a verdict, no rewrite) / none: scopes decide what leaves |
| RxServer `authHandler`, `queryModifier`, `changeValidator` | `unit({ authorize })`, scopes, the entity validators and `beforeApply` |
| schema `encrypted: ['field']` + `password` | `{ encrypted: true }` per record: sealed for this node, never synced |
| `multiInstance` + `leader-election` | one storage per directory (`lock`); `lock: 'wait'` hands it over |
| `RxError` with a `code` (messages in dev-mode) | `SyncomError` with a `code` (messages always) |

## The matrix

<!-- comparison:start -->
<!-- generated by `pnpm docs:comparison` from docs/comparison-rxdb.json — edit the data, not this block -->

✅ built in, or in an official package of the same project (named) · ⚠️ partial, opt-in, Premium (paid), with a caveat, or through a third-party package (named) · ❌ not built in · 🔜 planned by the maintainers, no code yet · — does not apply. The RxDB column is rxdb 17.6.0 (npm `latest`, October 2026), decided from its source code at that tag, from runs of the published package and from every page of rxdb.info; Premium plugins are closed source, so their cells follow the docs. The syncom column is this repository.

### Package and platform

<div class="sc-matrix sc-matrix-duel">

<table>
<thead>
<tr>
<th>Feature</th>
<th><a href="https://github.com/Alexis-Technologies/syncom">syncom</a><br><sub>sync engine</sub></th>
<th><a href="https://github.com/pubkey/rxdb">RxDB</a><br><sub>local-first database</sub></th>
</tr>
</thead>
<tbody>
<tr class="sc-matrix-group"><td colspan="3"><strong>Package and license</strong></td></tr>
<tr><td>Version compared</td><td>0.0.1 (<code>@alexify/syncom</code>)</td><td>17.6.0 (<code>rxdb</code>), npm <code>latest</code> since 2026-10-05</td></tr>
<tr><td>Release status</td><td>pre-release, not on npm yet</td><td>stable; on npm since 2016, 652 versions</td></tr>
<tr><td>License of the core</td><td>MIT, the whole package</td><td>Apache-2.0</td></tr>
<tr><td>License of the server part</td><td>MIT: hosting (<code>sync.unit()</code>) is in the same package</td><td>⚠️ RxServer (<code>rxdb-server</code>) is SSPL; its Fastify and Koa adapters are Premium (Pro Plus)</td></tr>
<tr><td>Paid tiers and price</td><td>— none</td><td>Premium: Pro from $99/month, Pro Plus from $239/month, billed yearly; Enterprise custom</td></tr>
<tr><td>What only Premium has</td><td>— no split: every feature is in the MIT package</td><td>⚠️ Pro: OPFS, IndexedDB, SQLite, filesystem storages, WebCrypto encryption, fulltext search; Pro Plus: worker, sharding, logger…</td></tr>
<tr><td>Premium license terms</td><td>— MIT: no term, token or usage limit</td><td>⚠️ yearly term license: use must stop when it lapses; not inside a library<sup>1</sup></td></tr>
<tr><td>Open collections limit</td><td>✅ none</td><td>⚠️ free core: 13 open collections per JavaScript process; Premium lifts it<sup>2</sup></td></tr>
<tr><td>Calls to the vendor</td><td>none: no network code beyond the injected transport</td><td>⚠️ dev-mode loads a hidden rxdb.info iframe; WebRTC defaults to <code>signaling.rxdb.info</code>; Premium install reports to the vendor<sup>3</sup></td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Dependencies, build and size</strong></td></tr>
<tr><td>Runtime dependencies</td><td>✅ 0: devDependencies only</td><td>24 direct plus the required peer <code>rxjs</code>: 74 packages installed</td></tr>
<tr><td>Language and module format</td><td>JavaScript, CommonJS, no build step; <code>src/</code> ships as is</td><td>TypeScript, built by Babel into CommonJS and ESM; <code>sideEffects: false</code></td></tr>
<tr><td>Entry points</td><td>root plus 4 subpaths: <code>/wrpc</code>, <code>/idb</code>, <code>/search</code>, <code>/contracts</code></td><td>54 subpath exports, one per plugin (<code>rxdb/plugins/*</code>)</td></tr>
<tr><td>TypeScript types</td><td>⚠️ hand-written <code>.d.ts</code>, tsd-tested; collection names typed, record data <code>unknown</code></td><td>✅ generated from the source; document type inferred from the schema</td></tr>
<tr><td>Browser bundle, minimal store</td><td>41.9 KB min+gzip: the browser entry, the whole engine</td><td>80.4 KB min+gzip: <code>createRxDatabase</code> with Dexie; 44.9 KB with localStorage</td></tr>
<tr><td>Browser bundle with sync</td><td>42.6 KB min+gzip with the wrpc link adapter</td><td>90.1 KB min+gzip with Dexie and <code>replicateRxCollection</code></td></tr>
<tr><td>Size budget in CI</td><td>✅ <code>pnpm size</code> fails CI when the browser entry passes 42 KB</td><td>⚠️ CI prints a webpack build size; no limit in 17.6.0</td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Runtimes</strong></td></tr>
<tr><td>Node.js</td><td>✅ ≥22; persists with <code>node:fs</code>; CI on Node 22 and 24</td><td>⚠️ ≥20; free disk persistence only via MongoDB or FoundationDB servers, or the capped SQLite trial<sup>4</sup></td></tr>
<tr><td>Deno</td><td>❌ not tested; <code>engines</code> names Node.js only</td><td>✅ <code>rxdb/plugins/storage-denokv</code>; CI runs the Dexie and DenoKV suites on Deno 2.6.5</td></tr>
<tr><td>Bun</td><td>❌ not tested</td><td>⚠️ CI runs the memory-storage suite on Bun 1.4.2; no Bun-specific storage</td></tr>
<tr><td>Browser persistence</td><td>✅ OPFS (default), IndexedDB (<code>/idb</code>), memory</td><td>✅ free: Dexie (IndexedDB), localStorage, memory; native IndexedDB and OPFS Premium (Pro)</td></tr>
<tr><td>Browser requirements</td><td>secure context, OPFS, Web Crypto with Ed25519 and RSA-OAEP</td><td><code>crypto.subtle</code> (secure context) or your own <code>hashFunction</code>; some bundlers need a <code>global</code> shim</td></tr>
<tr><td>Web Worker and SharedWorker</td><td>🔜 a storage served from a worker to its tabs is the planned follow-up</td><td>⚠️ Worker and SharedWorker storages are Premium (Pro Plus); the free core runs inside a worker</td></tr>
<tr><td>React Native</td><td>❌ not a target: no React Native backend or Web Crypto shim</td><td>⚠️ Premium SQLite or Expo Filesystem storage; the free SQLite trial is capped<sup>5</sup></td></tr>
<tr><td>Expo</td><td>❌ not a target</td><td>⚠️ Expo Filesystem storage is Premium (Pro); free: expo-sqlite through the SQLite trial</td></tr>
<tr><td>Capacitor and Ionic</td><td>❌ not tested; a Capacitor <code>fsi</code> adapter is yours to write</td><td>⚠️ Premium SQLite via <code>@capacitor-community/sqlite</code>; free: localStorage or Dexie in the WebView</td></tr>
<tr><td>Electron</td><td>❌ not documented or tested; no IPC bridge</td><td>✅ <code>rxdb/plugins/electron</code>: storage in the main process, databases in renderers over IPC</td></tr>
<tr><td>Tauri</td><td>❌ not documented or tested</td><td>⚠️ SQLite storage with <code>getSQLiteBasicsTauri()</code>: Premium, or the capped free trial</td></tr>
<tr><td>Flutter</td><td>❌ none</td><td>⚠️ <code>rxdb/plugins/flutter</code> runs RxDB in QuickJS; its recipe needs the removed LokiJS storage<sup>6</sup></td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Tabs and instances</strong></td></tr>
<tr><td>Several tabs on one database</td><td>⚠️ one tab per storage: <code>open()</code> holds a Web Lock, a second tab gets <code>LOCKED</code><sup>7</sup></td><td>✅ <code>multiInstance: true</code> (default): every tab opens it; changes cross over BroadcastChannel</td></tr>
<tr><td>Leader election</td><td>⚠️ no election API; <code>lock: 'wait'</code> hands the storage to the next tab</td><td>✅ <code>rxdb/plugins/leader-election</code>: <code>waitForLeadership()</code>, <code>isLeader()</code>; Web Locks when available</td></tr>
</tbody>
</table>

</div>

### Storage

<div class="sc-matrix sc-matrix-duel">

<table>
<thead>
<tr>
<th>Feature</th>
<th><a href="https://github.com/Alexis-Technologies/syncom">syncom</a><br><sub>sync engine</sub></th>
<th><a href="https://github.com/pubkey/rxdb">RxDB</a><br><sub>local-first database</sub></th>
</tr>
</thead>
<tbody>
<tr class="sc-matrix-group"><td colspan="3"><strong>Backends</strong></td></tr>
<tr><td>Storage contract</td><td>✅ <code>fsi</code>: five file functions — <code>read</code>, <code>write</code>, <code>exists</code>, <code>remove</code>, <code>list</code></td><td>✅ <code>RxStorage</code> → <code>RxStorageInstance</code>: <code>bulkWrite</code>, Mango <code>query</code>, <code>count</code>, <code>changeStream</code>, <code>cleanup</code>…</td></tr>
<tr><td>Writing your own backend</td><td>✅ five functions; <code>tests/suites/fsi.js</code> is the contract as a test</td><td>✅ implement <code>RxStorageInstance</code>; the storage suite runs from a clone of the repo</td></tr>
<tr><td>In-memory</td><td>✅ <code>createMemoryFsi()</code>: a <code>Map</code> of files; Node and browser</td><td>✅ <code>storage-memory</code> (free): plain objects, binary-search indexes; Node and browser</td></tr>
<tr><td>IndexedDB</td><td>✅ <code>@alexify/syncom/idb</code> <code>createIdbFsi()</code>: each file a row keyed <code>[dir, name]</code></td><td>✅ <code>storage-dexie</code> (free, Dexie.js); native <code>storage-indexeddb</code> is Premium (Pro)<sup>8</sup></td></tr>
<tr><td>OPFS</td><td>✅ the default browser backend; async <code>createWritable()</code>, main thread or worker</td><td>⚠️ Premium (Pro) <code>storage-opfs</code>: in a worker (sync handles) or <code>getRxStorageOPFSMainThread()</code></td></tr>
<tr><td>localStorage</td><td>❌ none shipped; an <code>fsi</code> over it would be five functions</td><td>✅ <code>storage-localstorage</code> (free): a key per document, a JSON array per index; browser</td></tr>
<tr><td>Node.js filesystem</td><td>✅ the default under Node: <code>node:fs/promises</code>, plain JSON files</td><td>⚠️ Premium (Pro) <code>storage-filesystem-node</code>; Node and Electron</td></tr>
<tr><td>SQLite</td><td>❌ none</td><td>⚠️ Premium (Pro) <code>storage-sqlite</code>; the free <code>getRxStorageSQLiteTrial()</code> is capped<sup>9</sup></td></tr>
<tr><td>Expo / React Native files</td><td>❌ none; not a target, an <code>fsi</code> is injectable</td><td>⚠️ Premium (Pro) <code>storage-filesystem-expo</code>, beta since 17.0.0; needs <code>expo-opfs</code></td></tr>
<tr><td>MongoDB as storage</td><td>❌ none</td><td>✅ <code>storage-mongodb</code> (free), Node; no attachments<sup>10</sup></td></tr>
<tr><td>FoundationDB</td><td>❌ none</td><td>✅ <code>storage-foundationdb</code> (free), Node with the native client; one process per cluster</td></tr>
<tr><td>Deno KV</td><td>❌ none</td><td>✅ <code>storage-denokv</code> (free), Deno only<sup>11</sup></td></tr>
<tr><td>LokiJS / PouchDB storages</td><td>— no legacy backends</td><td>❌ removed: PouchDB in 14.0.0; LokiJS and memory-synced in 16.0.0<sup>12</sup></td></tr>
<tr><td>Free-tier limits on storage</td><td>✅ none: every backend is in the MIT package</td><td>⚠️ SQLite trial capped; Dexie prints a Premium notice; no trial of other Premium storages</td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Wrappers and offloading</strong></td></tr>
<tr><td>Stacking storage wrappers</td><td>⚠️ an <code>fsi</code> can wrap an <code>fsi</code> (bytes only); document transforms are hooks</td><td>✅ <code>wrapRxStorageInstance</code>: validation, key compression, encryption, attachment compression stack</td></tr>
<tr><td>Remote storage (IPC, WebSocket)</td><td>❌ none; a peer replicates a copy instead</td><td>✅ <code>storage-remote</code> over any message channel; <code>storage-remote-websocket</code>; Electron IPC</td></tr>
<tr><td>Sharding</td><td>❌ none</td><td>⚠️ Premium (Pro Plus) <code>storage-sharding</code>; schema <code>sharding: { shards, mode }</code></td></tr>
<tr><td>In-memory layer over a disk store</td><td>❌ none; <code>cache.max</code> entries and the catalog stay in memory</td><td>⚠️ Premium (Pro Plus) <code>storage-memory-mapped</code>; memory-synced removed in 16<sup>13</sup></td></tr>
<tr><td>What opening loads</td><td>the catalog (every id, indexed values) and the retained log, into memory</td><td>lazy per collection; Premium (Pro Plus) meta optimizer keeps internal metadata in localStorage</td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Durability and recovery</strong></td></tr>
<tr><td>Write durability</td><td>✅ log batch first, then the record; <code>durable: true</code> fsyncs each file (node:fs)<sup>14</sup></td><td>⚠️ the storage's job; contract: each document atomic, no batch transaction</td></tr>
<tr><td>Crash recovery on reopen</td><td>✅ replays the log's unsealed tail; a torn newest batch is dropped</td><td>⚠️ the storage engine's own (IndexedDB, SQLite transactions); no replay in the core</td></tr>
<tr><td>Exclusive open</td><td>✅ Web Locks or <code>lock.json</code> (pid); <code>'fail'</code> → <code>LOCKED</code>, <code>'wait'</code>, <code>false</code><sup>15</sup></td><td>⚠️ no lock: tabs and processes share a store (<code>multiInstance</code>); single-process storages unguarded</td></tr>
<tr><td>Integrity check and repair</td><td>✅ cold reads re-verified against the chain, torn files too (<code>INTEGRITY</code>); <code>repair(id)</code> replays the log<sup>16</sup></td><td>❌ none; attachment digests serve change detection only</td></tr>
<tr><td>Quota and eviction handling</td><td>❌ none; past the log append a failed record file is held in memory and reported (<code>UNPERSISTED</code>)</td><td>❌ none in the core; the storage's <code>QuotaExceededError</code> reaches the caller</td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Data on disk</strong></td></tr>
<tr><td>On-disk format</td><td>✅ plain JSON files: <code>data/&lt;id&gt;.json</code>, log batches, chain blocks, keys</td><td>⚠️ per storage: JSON documents with <code>_rev</code>, <code>_meta</code> (Dexie, localStorage, SQLite, MongoDB); Premium formats undocumented</td></tr>
<tr><td>Files written per change</td><td>three per local write: log batch, chain block, record (two with <code>chain: false</code>)<sup>17</sup></td><td>one document row per write, plus the storage's index entries</td></tr>
<tr><td>Compression</td><td>❌ none</td><td>✅ <code>key-compression</code> wrapper (schema-derived short keys); <code>attachments-compression</code> (gzip/deflate)</td></tr>
<tr><td>In-memory document cache</td><td>✅ <code>cache: { max: 5000 }</code> entries; a live <code>Record</code> pins its own (WeakRef)</td><td>✅ <code>DocumentCache</code> per collection: RxDocuments by revision, held by WeakRef</td></tr>
<tr><td>Attachments / binary data</td><td>❌ none: JSON records only, no binary type</td><td>✅ <code>attachments</code> plugin: Blobs per document, <code>putAttachment()</code>, <code>getData()</code><sup>18</sup></td></tr>
<tr><td>Local (non-replicated) documents</td><td>⚠️ only encrypted records stay local; no plain local documents</td><td>✅ <code>local-documents</code>: <code>insertLocal()</code>, <code>getLocal$()</code>; not replicated, no schema</td></tr>
<tr><td>Tombstone cleanup</td><td>❌ none: a tombstone keeps its file (data emptied) and catalog row</td><td>✅ <code>cleanup</code> plugin: purges tombstones after 31 days, once replications are in sync</td></tr>
<tr><td>Delete a whole database</td><td>❌ no API; remove the directory yourself</td><td>✅ <code>db.remove()</code>, <code>removeRxDatabase(name, storage)</code>, <code>collection.remove()</code></td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Moving data</strong></td></tr>
<tr><td>Migrate between backends</td><td>❌ no tool; the same JSON files on every backend</td><td>✅ <code>migrateStorage()</code> (free): moves live documents batch by batch into a new database<sup>19</sup></td></tr>
<tr><td>Backup to files</td><td>❌ no API; the Node directory is plain JSON, copy it closed<sup>20</sup></td><td>⚠️ <code>backup</code> plugin: Node only, one-time or live, a <code>document.json</code> per document; no restore</td></tr>
<tr><td>JSON export / import</td><td>⚠️ <code>snapshot()</code> pages out records with meta, tombstones too; <code>mergeSnapshot()</code> joins them</td><td>✅ <code>json-dump</code>: <code>exportJSON()</code> / <code>importJSON()</code>, schema-hash checked, attachments optional<sup>21</sup></td></tr>
</tbody>
</table>

</div>

### Data model and writes

<div class="sc-matrix sc-matrix-duel">

<table>
<thead>
<tr>
<th>Feature</th>
<th><a href="https://github.com/Alexis-Technologies/syncom">syncom</a><br><sub>sync engine</sub></th>
<th><a href="https://github.com/pubkey/rxdb">RxDB</a><br><sub>local-first database</sub></th>
</tr>
</thead>
<tbody>
<tr class="sc-matrix-group"><td colspan="3"><strong>Documents and collections</strong></td></tr>
<tr><td>Data model</td><td>JSON records addressed by id; collections optional (<code>$type</code>)</td><td>JSON documents; every collection has a JSON Schema</td></tr>
<tr><td>Records without a schema</td><td>✅ no schema needed; <code>{}</code> is a bare collection</td><td>⚠️ schema required; an open <code>type: 'object'</code> sub-field, RxState or local docs</td></tr>
<tr><td>Collection names</td><td>✅ any non-empty string the storage does not answer to (<code>get</code>, <code>close</code>… refused at <code>open()</code>)</td><td>✅ never shadows database members; regex checked in dev-mode</td></tr>
<tr><td>Field names</td><td>✅ any JSON key; <code>__proto__</code> ignored, <code>$type</code> reserved</td><td>⚠️ letters, digits, <code>_</code>; no leading <code>_</code>; no RxDocument member names</td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Identity</strong></td></tr>
<tr><td>Primary key</td><td>✅ the record id, outside the data; the validator sees it under <code>idField</code></td><td>✅ a top-level string field named by <code>primaryKey</code> (<code>_id</code> allowed)</td></tr>
<tr><td>Composite primary key</td><td>❌ none; a composite <code>unique</code> key instead</td><td>✅ <code>primaryKey: { key, fields, separator }</code>, filled on insert</td></tr>
<tr><td>Id generation</td><td>✅ <code>getId</code>: UUID by default; sync or async generator of your own</td><td>❌ the caller supplies the key; a composite key is derived</td></tr>
<tr><td>Id format rules</td><td>✅ <code>[A-Za-z0-9_@-][A-Za-z0-9._@-]{0,127}</code>, checked on every write and peer op</td><td>⚠️ string with <code>maxLength</code>; values checked only by a validator and dev-mode<sup>22</sup></td></tr>
<tr><td>Immutable fields</td><td>⚠️ only <code>$type</code> (the collection) and the id</td><td>⚠️ <code>final: true</code>; the primary key is final — enforced in dev-mode only<sup>23</sup></td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Schema and validation</strong></td></tr>
<tr><td>Schema format</td><td>✅ none of its own: a Standard Schema, a function, or <code>validator.compile()</code></td><td>✅ JSON Schema (draft-04 subset) plus <code>primaryKey</code>, <code>indexes</code>, <code>final</code>, <code>ref</code></td></tr>
<tr><td>Validators</td><td>✅ whatever you inject: metaschema, zod, valibot, arktype, ajv, TypeBox; none bundled</td><td>✅ <code>validate-ajv</code>, <code>validate-z-schema</code>; <code>validate-is-my-json-valid</code> unsupported<sup>24</sup></td></tr>
<tr><td>Validation on by default</td><td>✅ on for every entity with a <code>schema</code>; <code>validate: false</code> opts out</td><td>⚠️ off until the storage is wrapped; dev-mode refuses to start without it<sup>25</sup></td></tr>
<tr><td>Validator can transform data</td><td>✅ its value is written: defaults, aliases, stripped keys, decoders</td><td>❌ validators return errors only; the data is written as given</td></tr>
<tr><td>Validate without writing</td><td>✅ <code>storage.check(entity, data)</code> returns the validated value</td><td>⚠️ <code>getValidator(schema)</code> from the validate plugin; no collection method</td></tr>
<tr><td>TypeScript types of the data</td><td>❌ records are <code>unknown</code>; only collection names are typed</td><td>✅ <code>ExtractDocumentTypeFromTypedRxJsonSchema</code> from an <code>as const</code> schema; typed collections</td></tr>
<tr><td>Default values</td><td>✅ from the validator (metaschema <code>default</code>, zod <code>.default()</code>), folded into the op</td><td>⚠️ <code>default</code> on top-level fields, filled by insert and upsert</td></tr>
<tr><td>Required fields</td><td>✅ as the validator declares them</td><td>✅ JSON Schema <code>required</code>; the primary key always</td></tr>
<tr><td>Nested objects</td><td>⚠️ stored and validated; merged as one top-level register<sup>26</sup></td><td>✅ nested schemas; dotted paths in update operators and queries</td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Schema versions and migration</strong></td></tr>
<tr><td>Schema versions</td><td>✅ <code>schema.version</code> on every op (<code>v</code>) and record (<code>meta.v</code>); snapshot hash</td><td>✅ <code>version</code> per collection; a changed schema without a bump throws <code>DB6</code></td></tr>
<tr><td>Migrating stored data</td><td>✅ lens on read (migrations, then the validator); <code>migrate()</code> rewrites, idempotent</td><td>✅ <code>migrationStrategies</code> per version, at open; returning <code>null</code> drops a document</td></tr>
<tr><td>Old data before migrating</td><td>✅ read through the lens; writes allowed</td><td>❌ invisible until migrated; writes throw <code>COL25</code></td></tr>
<tr><td>A peer on another schema version</td><td>✅ the op carries <code>v</code>; lens for older, <code>ahead: 'apply' | 'hold'</code> for newer</td><td>⚠️ no version on documents; run the same migration on server and clients</td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Writes</strong></td></tr>
<tr><td>Bulk writes</td><td>❌ none; one op per call (a batch is <code>Promise.all</code> of <code>insert()</code>)</td><td>✅ <code>bulkInsert</code>, <code>bulkUpsert</code>, <code>bulkRemove</code> with per-document success and error lists</td></tr>
<tr><td>Upsert</td><td>✅ <code>set(id, data)</code> replaces the record wholesale; <code>Collection.set()</code></td><td>✅ <code>upsert()</code>, <code>bulkUpsert()</code>, <code>incrementalUpsert()</code></td></tr>
<tr><td>Insert only if absent</td><td>❌ none; <code>has()</code> then <code>set()</code> is two calls</td><td>✅ <code>insertIfNotExists()</code> returns the existing document; <code>insert()</code> throws 409</td></tr>
<tr><td>Update some fields</td><td>✅ <code>update(id, delta)</code>; <code>record.field = v</code> then <code>save()</code></td><td>✅ <code>patch()</code>, <code>incrementalPatch()</code></td></tr>
<tr><td>Remove one field</td><td>❌ only by a whole-record <code>set()</code>; <code>undefined</code> in a delta is dropped</td><td>✅ <code>patch({ field: undefined })</code>, <code>$unset</code></td></tr>
<tr><td>Update by function</td><td>❌ no <code>modify(fn)</code>; <code>get()</code> then <code>swap()</code> in a retry loop</td><td>✅ <code>modify(fn)</code>; <code>incrementalModify(fn)</code> re-runs on the latest state</td></tr>
<tr><td>Update operators</td><td>⚠️ typed ops only: <code>update</code>, <code>inc</code>, <code>add</code>/<code>remove</code>; no <code>$push</code>, <code>$min</code>, <code>$rename</code></td><td>✅ <code>update</code> plugin (mingo): <code>$set</code>, <code>$inc</code>, <code>$push</code>, <code>$addToSet</code>, <code>$pullAll</code>, <code>$min</code>…</td></tr>
<tr><td>Update or delete by query</td><td>❌ none; <code>select().fetch()</code>, then one write per row</td><td>✅ <code>find().update()</code>, <code>.patch()</code>, <code>.modify()</code>, <code>.remove()</code></td></tr>
<tr><td>Compare-and-swap</td><td>✅ <code>swap(id, changes, prev)</code> compares field values inside the write queue</td><td>✅ every non-incremental write checks <code>_rev</code>; a stale one throws 409 <code>CONFLICT</code></td></tr>
<tr><td>Concurrent writes on one node</td><td>✅ one mutation queue; no local conflict errors</td><td>⚠️ a stale <code>patch</code>/<code>modify</code>/<code>update</code> throws 409; the <code>incremental*</code> methods retry</td></tr>
<tr><td>Multi-record transactions</td><td>❌ none; every write is one op on one record</td><td>❌ none; one document write is the atomic unit</td></tr>
<tr><td>Change and delete in one write</td><td>❌ <code>delete()</code> carries no data; two ops</td><td>✅ set <code>_deleted: true</code> inside <code>modify()</code> or <code>update()</code></td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Counters, sets and lists</strong></td></tr>
<tr><td>Counters that converge</td><td>✅ <code>inc()</code>: one running sum per origin<sup>27</sup></td><td>⚠️ <code>$inc</code> is local; it converges only under the <code>crdt</code> plugin</td></tr>
<tr><td>Sets</td><td>✅ <code>add()</code>/<code>remove()</code>: observed-remove set, read sorted</td><td>⚠️ <code>$addToSet</code>/<code>$pullAll</code>; <code>crdt</code> replays them in creator order, not observed-remove</td></tr>
<tr><td>Ordered lists that merge</td><td>✅ list fields: <code>splice()</code>, <code>setAt()</code>, <code>move()</code> (Fugue; a concurrent move lands once)</td><td>⚠️ <code>crdt</code> plugin replays <code>$push</code>; no positional insert</td></tr>
<tr><td>Collaborative text</td><td>✅ text fields: <code>splice()</code>/<code>updateText()</code> merge by position (Fugue); marks, cursors</td><td>❌ none</td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Merge model</strong></td></tr>
<tr><td>Conflict-free model</td><td>✅ built into every write: register, counter or OR-set per field</td><td>⚠️ opt-in <code>crdt</code> plugin per schema; otherwise a conflict handler</td></tr>
<tr><td>Concurrent edits to different fields</td><td>✅ both kept: last writer wins per top-level field</td><td>⚠️ the default handler keeps the master's whole document; merging needs a handler or <code>crdt</code></td></tr>
<tr><td>Who wins a concurrent overwrite</td><td>the later stamp <code>(ts, origin)</code>; a node's clock never falls behind what it saw</td><td><code>crdt</code>: op position, then storage-token order, not time; otherwise the master</td></tr>
<tr><td>Where the merge history lives</td><td>✅ op log beside the records, with retention; records keep per-field stamps</td><td>⚠️ <code>crdt</code>: every op stored inside the document, never compacted<sup>28</sup></td></tr>
<tr><td>Writes that bypass the merge model</td><td>✅ none: every write is an op; mixing field kinds throws <code>FIELD_KIND</code></td><td>⚠️ <code>modify()</code> is refused, but <code>upsert()</code>/<code>incrementalUpsert()</code> replace the op history<sup>29</sup></td></tr>
<tr><td>Conditional operations</td><td>❌ none that replicate; <code>swap()</code> is a local check</td><td>✅ <code>crdt</code>: <code>selector</code> with <code>ifMatch</code>/<code>ifNotMatch</code>, re-evaluated on every replay</td></tr>
<tr><td>Delta helpers</td><td>✅ <code>diff</code>, <code>merge</code>, <code>apply</code>: pure functions; numbers add, arrays union<sup>30</sup></td><td>❌ none; <code>mergeCRDTFields</code> merges the plugin's own field only</td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Revisions, deletes and document objects</strong></td></tr>
<tr><td>Per-record metadata</td><td><code>meta</code>: per-field <code>[ts, origin]</code>, reset stamp, tombstone, counters, sets, <code>v</code></td><td><code>_rev</code> (height-token, local), <code>_meta.lwt</code>, <code>_deleted</code>, <code>_attachments</code></td></tr>
<tr><td>Delete</td><td>✅ tombstone with empty data; a newer write revives the record</td><td>✅ <code>_deleted: true</code> with the full data until <code>cleanup</code>; re-insert revives</td></tr>
<tr><td>Document objects</td><td>✅ <code>record(id)</code>: one live, editable <code>Record</code> per id, refreshed on any change</td><td>✅ <code>RxDocument</code>: read-only snapshot per revision; <code>getLatest()</code>, <code>$</code></td></tr>
<tr><td>Same object for the same record</td><td>✅ one <code>Record</code> per id while referenced (WeakRef); <code>get()</code> returns new copies</td><td>✅ one <code>RxDocument</code> per revision while referenced (WeakRef cache)</td></tr>
<tr><td>Editing returned data</td><td>✅ JSON copies in and out; editing them changes nothing</td><td>⚠️ deep-frozen in dev-mode only; production <code>toJSON()</code> shares nested objects<sup>31</sup></td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Relations and higher-level APIs</strong></td></tr>
<tr><td>ORM methods</td><td>❌ none</td><td>✅ <code>statics</code>, <code>methods</code>, <code>attachments</code> per collection</td></tr>
<tr><td>References between records</td><td>⚠️ a <code>Record</code> turns any string equal to a known id into a <code>Reference</code><sup>32</sup></td><td>✅ schema <code>ref</code> with <code>populate()</code> or the <code>field_</code> getter; one or many</td></tr>
<tr><td>Persistent app state</td><td>❌ none</td><td>✅ <code>state</code> plugin (RxState): schemaless JSON, modifier writes, replicable</td></tr>
<tr><td>Derived collections</td><td>❌ none; <code>afterWrite</code>, <code>change</code> and <code>watch()</code> are not checkpointed</td><td>✅ <code>pipeline</code> plugin: leader-run handler, checkpointed, blocks the destination</td></tr>
<tr><td>Stored procedures</td><td>⚠️ <code>@alexify/syncom/contracts</code>: arrow functions stored in the chain, run by <code>new Function</code><sup>33</sup></td><td>❌ none</td></tr>
</tbody>
</table>

</div>

### Queries and reactivity

<div class="sc-matrix sc-matrix-duel">

<table>
<thead>
<tr>
<th>Feature</th>
<th><a href="https://github.com/Alexis-Technologies/syncom">syncom</a><br><sub>sync engine</sub></th>
<th><a href="https://github.com/pubkey/rxdb">RxDB</a><br><sub>local-first database</sub></th>
</tr>
</thead>
<tbody>
<tr class="sc-matrix-group"><td colspan="3"><strong>Query language and operators</strong></td></tr>
<tr><td>Query language</td><td>✅ Mango-shaped selector: <code>collection.select(query)</code>, then cursor builders</td><td>✅ Mango query <code>{ selector, sort, skip, limit, index }</code>, matched by mingo</td></tr>
<tr><td>Chained query builder</td><td>⚠️ cursor chains <code>order()</code>, <code>desc()</code>, <code>limit()</code>, <code>offset()</code>, <code>filter()</code>, <code>projection()</code>; the predicate is JSON only</td><td>✅ <code>query-builder</code> plugin: <code>where('f').gt(5).sort('-f').limit(n)</code></td></tr>
<tr><td><code>$eq</code> <code>$ne</code> <code>$gt</code> <code>$gte</code> <code>$lt</code> <code>$lte</code></td><td>✅ all six; <code>$gt</code>…<code>$lte</code> hold only within one kind (number, string, boolean)</td><td>✅ all six (mingo)</td></tr>
<tr><td><code>$in</code> <code>$nin</code> <code>$all</code></td><td>⚠️ <code>$in</code>, <code>$nin</code>; no <code>$all</code> (an <code>$and</code> of equalities instead)</td><td>⚠️ <code>$in</code>, <code>$nin</code>; no <code>$all</code> (an <code>$and</code> of equalities instead)</td></tr>
<tr><td><code>$exists</code> <code>$type</code></td><td>⚠️ <code>$exists</code> only (<code>null</code> counts as present); no <code>$type</code></td><td>✅ <code>$exists</code>; <code>$type</code> (<code>null</code>, <code>boolean</code>, <code>number</code>, <code>string</code>, <code>array</code>, <code>object</code>)</td></tr>
<tr><td><code>$elemMatch</code> <code>$size</code></td><td>⚠️ a scalar matches any element; no <code>$elemMatch</code>, no <code>$size</code> (<code>filter()</code> instead)</td><td>✅ element match, <code>$elemMatch</code> (objects or scalars), <code>$size</code></td></tr>
<tr><td><code>$regex</code> <code>$options</code></td><td>✅ <code>RegExp</code> or source string, <code>$options</code> flags; 1000 characters at most; <code>g</code>/<code>y</code> dropped</td><td>✅ string with <code>$options</code>; a <code>RegExp</code> instance is refused in dev-mode (QU16)<sup>34</sup></td></tr>
<tr><td><code>$and</code> <code>$or</code> <code>$nor</code> <code>$not</code></td><td>✅ <code>$and</code>, <code>$or</code>, and <code>$not</code> over a whole query; no <code>$nor</code>, no field-level <code>$not</code></td><td>✅ <code>$and</code>, <code>$or</code>, <code>$nor</code>; <code>$not</code> on a field only</td></tr>
<tr><td><code>$mod</code></td><td>❌ not supported (<code>filter()</code> instead)</td><td>✅ <code>$mod: [divisor, remainder]</code></td></tr>
<tr><td>Arbitrary JS predicate</td><td>✅ <code>filter(fn)</code> over the loaded row, applied before <code>limit()</code></td><td>❌ no <code>$where</code> or <code>$expr</code>; filter the results in app code</td></tr>
<tr><td>Nested fields (dotted paths)</td><td>✅ in queries, <code>order()</code>, <code>projection()</code>, <code>index</code> and <code>search</code>; <code>items.0.n</code> reaches into arrays</td><td>✅ dot notation in selectors, <code>sort</code> (<code>tags.0</code>) and indexes</td></tr>
<tr><td>Malformed query detection</td><td>✅ unknown operator or bad argument: <code>TypeError</code> at <code>select()</code>; field names are not checked</td><td>⚠️ unknown operators throw; field names, <code>RegExp</code>, <code>undefined</code> and extra keys only in dev-mode</td></tr>
<tr><td>Typed queries and rows</td><td>⚠️ <code>MangoQuery</code> is untyped; rows are <code>QueryRow</code> (<code>Record&lt;string, unknown&gt;</code>)</td><td>✅ <code>MangoQuery&lt;RxDocType&gt;</code> checks paths and values; results are typed <code>RxDocument</code>s</td></tr>
<tr><td>Immutable query objects</td><td>❌ builders change the cursor in place (<code>one()</code> leaves it as it was)</td><td>✅ every builder returns a new <code>RxQuery</code></td></tr>
<tr><td>Test a document against a query</td><td>❌ the compiled predicate is internal (<code>compileQuery</code> is not exported)</td><td>✅ <code>query.doesDocumentDataMatch(doc)</code></td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Reading results</strong></td></tr>
<tr><td>Sort</td><td>✅ <code>order()</code>/<code>desc()</code>: several keys, any field, dotted; stable</td><td>✅ <code>sort: [{ f: 'asc' | 'desc' }]</code>: several keys, nested; primary key appended</td></tr>
<tr><td>Sort served by an index</td><td>❌ no sorted index: every candidate is read, then ordered</td><td>✅ an ascending sort that matches the index walks it and stops at <code>skip + limit</code><sup>35</sup></td></tr>
<tr><td>Top-k for an unindexed order</td><td>✅ <code>TopK</code> keeps the best <code>offset + limit</code> rows as candidates stream by</td><td>⚠️ sorts every match, then slices</td></tr>
<tr><td>Skip and limit</td><td>✅ <code>offset(n)</code>, <code>limit(n)</code>; an unordered cursor stops reading at enough matches</td><td>✅ <code>skip</code>, <code>limit</code>; <code>findOne()</code> refuses a <code>limit</code> (QU6)</td></tr>
<tr><td>Streaming cursor / keyset paging</td><td>❌ <code>for await</code> yields an already fetched array; keyset paging by hand</td><td>❌ <code>exec()</code> returns the whole page; keyset paging by hand (<code>$gt</code> on the sort key)</td></tr>
<tr><td>Count queries</td><td>✅ <code>count(query)</code> for any query; from the catalog alone when every field is indexed</td><td>⚠️ a selector no index satisfies throws <code>QU14</code> on Dexie (every storage in dev-mode) unless <code>allowSlowCount: true</code></td></tr>
<tr><td>Find by id</td><td>✅ <code>get(id)</code> (a copy), <code>record(id)</code> (a live Record); <code>hasRecord(id)</code>; a collection's <code>get</code> only its own</td><td>✅ <code>findOne(id)</code>: document cache first, then <code>findDocumentsById()</code></td></tr>
<tr><td>Find many by id</td><td>❌ no batch get; <code>select({ id: { $in } })</code> reads the whole collection</td><td>✅ <code>findByIds(ids)</code> → <code>Map</code>, observable like any query</td></tr>
<tr><td>First match</td><td>✅ <code>cursor.one()</code> → the row or <code>null</code></td><td>✅ <code>findOne(query)</code>; <code>exec(true)</code> throws when nothing matches</td></tr>
<tr><td>Projection (select fields)</td><td>✅ <code>projection(fields)</code>; answered from the catalog when they are indexed</td><td>❌ always whole documents, by design; a <code>fields</code> key is QU11 in dev-mode</td></tr>
<tr><td>What a query returns</td><td>plain JSON copies <code>{ id, ...data }</code>, the lens applied; new objects per <code>fetch()</code></td><td><code>RxDocument</code> instances, one per revision, shared across queries</td></tr>
<tr><td>Aggregation and group-by</td><td>❌ none; compute over <code>fetch()</code> rows</td><td>❌ none, by design</td></tr>
<tr><td>Joins and cross-collection queries</td><td>❌ a cursor reads one collection; <code>Reference.record()</code> follows one id</td><td>❌ one collection per query; <code>populate()</code> follows one ref</td></tr>
<tr><td>Query on encrypted data</td><td>❌ an <code>{ encrypted: true }</code> record is listed, never a query row</td><td>❌ encrypted fields cannot be queried; an <code>$eq</code> on one silently matches nothing</td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Indexes and planning</strong></td></tr>
<tr><td>Secondary indexes</td><td>✅ entity <code>index: ['field', …]</code>, or read off a metaschema schema</td><td>✅ schema <code>indexes: ['f', ['a', 'b']]</code></td></tr>
<tr><td>Index kind</td><td>⚠️ equality posting lists; ranges, prefixes and sorts do not use them<sup>36</sup></td><td>✅ sorted keys: <code>$eq</code>, <code>$gt</code>…<code>$lte</code> and <code>$in</code> (min to max) bound the scan</td></tr>
<tr><td>Compound indexes</td><td>⚠️ only for <code>unique</code> keys; queries intersect single-field postings</td><td>✅ any index is a field list; <code>_deleted</code> and the primary key are added</td></tr>
<tr><td>Array (multi-entry) indexes</td><td>✅ an indexed array is posted under each element</td><td>❌ refused in dev-mode (<code>SC36</code>); an RxPipeline into a mapping collection instead<sup>37</sup></td></tr>
<tr><td>Indexable values</td><td>✅ any JSON value, keyed canonically (object keys in any order)</td><td>⚠️ strings with <code>maxLength</code>, numbers with <code>minimum</code>/<code>maximum</code>/<code>multipleOf</code>, required booleans</td></tr>
<tr><td>Where indexes live</td><td>in memory (the catalog), saved to <code>index/catalog.json</code>, caught up from the log at open</td><td>in the storage: IndexedDB indexes on Dexie (disk), sorted arrays on memory</td></tr>
<tr><td>Adding or changing an index</td><td>✅ edit <code>index</code>; the catalog rebuilds once at the next open</td><td>⚠️ a schema change: bump <code>version</code> and migrate, or <code>addCollections()</code> throws DB6</td></tr>
<tr><td>Query planner</td><td>✅ indexed equalities narrow the candidates before any record is read</td><td>✅ rates one key range per index, takes the best; <code>index</code> forces one</td></tr>
<tr><td>Several indexes in one query</td><td>✅ postings intersect over <code>$and</code>, union over an <code>$or</code> whose branches are all indexed</td><td>❌ one index per query; an <code>$or</code> scans a whole index</td></tr>
<tr><td>Index-only (covered) queries</td><td>✅ query, order and projection all indexed: answered from the catalog, no record read</td><td>⚠️ <code>count()</code> on an index-satisfied selector only; <code>find()</code> always reads documents</td></tr>
<tr><td>Plan inspection</td><td>❌ no explain API; the plan is private to the cursor</td><td>✅ <code>query.getPreparedQuery().queryPlan</code>: index, key range, <code>sortSatisfiedByIndex</code></td></tr>
<tr><td>Index advisor</td><td>❌ none</td><td>⚠️ Premium (Pro Plus): <code>findBestIndex()</code>, run at build time on test data</td></tr>
<tr><td>Query cache</td><td>❌ none; each <code>fetch()</code> re-runs, records come from the bounded entry cache</td><td>✅ <code>QueryCache</code>: equal queries share one <code>RxQuery</code>; about 100 unobserved ones kept</td></tr>
<tr><td>Unique constraints</td><td>✅ <code>unique</code> fields and composites; a local write is refused, a peer's clash is a <code>conflict</code> event</td><td>❌ primary key only</td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Search</strong></td></tr>
<tr><td>Full-text search</td><td>✅ <code>$text</code> with <code>createSearch()</code> (<code>@alexify/syncom/search</code>): trigram TF-IDF, typo-tolerant</td><td>⚠️ Premium (Pro): FlexSearch plugin, <code>addFulltextSearch()</code> then <code>flexSearch.find(text)</code></td></tr>
<tr><td>Text search inside a query</td><td>✅ <code>$text</code> combines with indexed equalities, <code>order()</code>, <code>limit()</code>, <code>count()</code>, <code>watch()</code></td><td>❌ <code>flexSearch.find()</code> is a separate call; no <code>$text</code> operator</td></tr>
<tr><td>Vector / similarity search</td><td>❌ none</td><td>⚠️ <code>rxdb/plugins/vector</code>: four distance functions; nearest-neighbour search is app code</td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Reactivity</strong></td></tr>
<tr><td>Live queries</td><td>✅ <code>cursor.watch(listener)</code>: runs now, then after every change to the collection</td><td>✅ <code>query.$</code>: the current result on subscribe, then each new result</td></tr>
<tr><td>Live update without re-querying</td><td>❌ every wake re-runs the whole cursor</td><td>✅ EventReduce derives the new result from the change events</td></tr>
<tr><td>Emits only when the result changed</td><td>❌ the listener runs after any change to the collection, same rows or not</td><td>✅ an unchanged result is not emitted</td></tr>
<tr><td>Live count</td><td>❌ no; <code>watch()</code> hands rows (<code>rows.length</code>)</td><td>✅ <code>count().$</code>, adjusted from each change event without a re-count</td></tr>
<tr><td>Collection change stream</td><td>⚠️ storage-wide <code>change</code> event <code>(op, via)</code>; no per-collection stream</td><td>✅ <code>collection.$</code>, <code>insert$</code>, <code>update$</code>, <code>remove$</code>; <code>database.$</code></td></tr>
<tr><td>Document observable</td><td>✅ a live <code>Record</code> emits <code>update (data, delta)</code>, <code>null</code> once deleted</td><td>✅ <code>doc.$</code>, <code>doc.get$(path)</code> / <code>doc.field$</code>, <code>doc.deleted$</code></td></tr>
<tr><td>Reactivity primitive</td><td>⚠️ callbacks and events; no observable or signal adapter</td><td>✅ RxJS observables (<code>$</code>); a <code>reactivity</code> factory turns them into signals or refs (<code>$$</code>)</td></tr>
<tr><td>Peer writes in live results</td><td>✅ a peer's ops and snapshot pages wake <code>watch()</code>; a batch is one run</td><td>✅ replicated writes go through the collection's event stream, so <code>$</code> updates</td></tr>
</tbody>
</table>

</div>

### Replication

<div class="sc-matrix sc-matrix-duel">

<table>
<thead>
<tr>
<th>Feature</th>
<th><a href="https://github.com/Alexis-Technologies/syncom">syncom</a><br><sub>sync engine</sub></th>
<th><a href="https://github.com/pubkey/rxdb">RxDB</a><br><sub>local-first database</sub></th>
</tr>
</thead>
<tbody>
<tr class="sc-matrix-group"><td colspan="3"><strong>Model and protocol</strong></td></tr>
<tr><td>Replication model</td><td>operation log; version vectors per origin and scope; pages of ops</td><td>document state: pull by checkpoint, push with <code>assumedMasterState</code> (fork and master)</td></tr>
<tr><td>What crosses the wire</td><td>ops as positional <code>packOps</code> arrays, signed; a <code>set</code> carries only its delta</td><td>whole documents with <code>_deleted</code>; a push row carries two whole states</td></tr>
<tr><td>Intermediate writes replicated</td><td>✅ every retained op travels, intermediate writes included</td><td>❌ latest state per document; intermediate writes collapse before a push</td></tr>
<tr><td>Protocol version check</td><td>✅ <code>PROTOCOL</code> 1 in <code>hello</code>; another version is refused with 400</td><td>❌ none in the protocol; checkpoint and payload are the backend's</td></tr>
<tr><td>Schema check at connect</td><td>✅ <code>hello</code> swaps <code>{ version, hash }</code>; same version, other hash emits <code>schema</code> drift</td><td>⚠️ RxServer only: schema version in the URL; older clients get 426 (<code>outdatedClient$</code>)<sup>38</sup></td></tr>
<tr><td>Sync with an existing backend</td><td>❌ none: the far end must be a syncom node hosting <code>unit()</code></td><td>✅ any backend: pull, push and stream handlers over your own database</td></tr>
<tr><td>Writing your own transport</td><td>✅ <code>SyncLink</code>: <code>call</code>, <code>subscribe</code> with <code>lastEventId</code>, <code>on</code>/<code>off</code>, <code>close</code>; optional <code>stream</code></td><td>✅ <code>replicateRxCollection</code>: <code>pull.handler</code>, <code>push.handler</code>, <code>pull.stream$</code> with <code>RESYNC</code></td></tr>
<tr><td>Round trips to catch up</td><td><code>hello</code>, then one <code>push</code> per 500 ops, then one <code>changes</code> subscription</td><td>pulls until a short page; one push per 100 documents; a re-push per conflict</td></tr>
<tr><td>Collections in one connection</td><td>✅ one link carries every collection of the storage, filtered by scope</td><td>⚠️ one replication per collection, each with its own requests and stream</td></tr>
<tr><td>Sync state kept on the client</td><td>a cursor per peer, the version vector, the op log within retention</td><td>per replication: two checkpoints and the last master state of every document</td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Topology</strong></td></tr>
<tr><td>Topology</td><td>mesh: any node dials and hosts; hubs dial each other</td><td>a star of fork–master pairs; WebRTC peers pair up in a mesh</td></tr>
<tr><td>Peers without a central server</td><td>✅ any node hosts <code>unit()</code>; peers dial each other directly</td><td>⚠️ WebRTC only; each pair has a hash-chosen master and a fork<sup>39</sup></td></tr>
<tr><td>Multi-hop relay</td><td>✅ ops relayed hop by hop; the version vector drops what a node has</td><td>✅ through the local store: a second replication pushes what the first pulled</td></tr>
<tr><td>A browser serves data</td><td>✅ <code>unit()</code> on a wrpc <code>PeerHost</code> over a data channel</td><td>⚠️ only as the master of a WebRTC pair; other servers are Node</td></tr>
<tr><td>Scaling the server out</td><td>⚠️ hubs dial each other; a client stays on one hub's log</td><td>⚠️ processes share one storage; branch servers replicate to a root<sup>40</sup></td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Peer-to-peer (WebRTC)</strong></td></tr>
<tr><td>Browser to browser (WebRTC)</td><td>✅ wrpc <code>WrpcPeer</code>/<code>PeerLink</code> and <code>PeerHost</code> (<code>@alexify/wrpc/webrtc</code>)</td><td>✅ <code>replication-webrtc</code> (simple-peer), free; tests re-enabled in 17.6.0</td></tr>
<tr><td>Signaling</td><td>✅ wrpc's <code>createSignalingUnit</code> on your hub, or a channel you negotiated</td><td>✅ self-hosted <code>ws</code> server, a public demo server (default), or Nostr relays<sup>41</sup></td></tr>
<tr><td>Peers in a room</td><td>one link per pair you add (<code>peer.join(room)</code> + <code>addNode</code>); ops relay any path</td><td>full mesh: one replication per pair, N(N−1)/2 in all, no cap</td></tr>
<tr><td>STUN / TURN servers</td><td>your <code>iceServers</code>; wrpc sets none</td><td>simple-peer's Google and Twilio STUN by default; no TURN</td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Transports and backends</strong></td></tr>
<tr><td>WebSocket</td><td>✅ a wrpc <code>WrpcClient</code> through <code>createWrpcLink</code> (<code>@alexify/syncom/wrpc</code>)</td><td>⚠️ <code>replication-websocket</code>: RxDB to RxDB, a Node server, no authentication<sup>42</sup></td></tr>
<tr><td>HTTP / Server-Sent Events</td><td>⚠️ no request–response sync; wrpc's SSE transport untested in the repo<sup>43</sup></td><td>✅ your endpoints under <code>replicateRxCollection</code>; RxServer serves pull, push and SSE</td></tr>
<tr><td>GraphQL</td><td>❌ none</td><td>✅ <code>replication-graphql</code>; live through graphql-ws; schema and query generators<sup>44</sup></td></tr>
<tr><td>CouchDB</td><td>❌ none</td><td>✅ <code>replication-couchdb</code>: <code>_changes</code> long-poll, <code>_bulk_docs</code> with <code>_rev</code></td></tr>
<tr><td>Firestore</td><td>❌ none</td><td>✅ <code>replication-firestore</code> (<code>firebase</code> peer); <code>pull.filter</code>; live via <code>onSnapshot</code><sup>45</sup></td></tr>
<tr><td>Supabase</td><td>❌ none</td><td>✅ <code>replication-supabase</code>: PostgREST compare-and-set; Realtime for live rows</td></tr>
<tr><td>Appwrite</td><td>❌ none</td><td>⚠️ <code>replication-appwrite</code>: browser only; updates read then write, not atomic</td></tr>
<tr><td>MongoDB</td><td>❌ none</td><td>✅ <code>replication-mongodb</code> (Node): change streams; push in a transaction; replica set</td></tr>
<tr><td>NATS JetStream</td><td>❌ none</td><td>✅ <code>replication-nats</code>: a subject per document; updates checked by sequence</td></tr>
<tr><td>Google Drive</td><td>❌ none</td><td>⚠️ <code>replication-google-drive</code>, beta: JSON files and a lock file in the user's Drive</td></tr>
<tr><td>Microsoft OneDrive</td><td>❌ none</td><td>⚠️ <code>replication-microsoft-onedrive</code>, beta: the same file-and-lock scheme over Graph</td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Conflicts and clocks</strong></td></tr>
<tr><td>Conflict detection</td><td>— no compare step: every op merges by its field's kind</td><td>✅ the master compares <code>assumedMasterState</code> with its own (<code>isEqual</code>, deep-equal)</td></tr>
<tr><td>Conflict resolution</td><td>built in: per-field LWW by <code>(ts, origin)</code>, per-origin counter sums, OR-sets</td><td><code>conflictHandler.resolve</code> on the client; the default keeps the master's document<sup>46</sup></td></tr>
<tr><td>Custom merge logic</td><td>❌ none: the rules are fixed; <code>beforeApply</code> can only skip an op</td><td>✅ any function per collection; the <code>crdt</code> plugin brings its own</td></tr>
<tr><td>Where conflicts are settled</td><td>on every node, by the same deterministic rules</td><td>on the client (fork); the server only detects</td></tr>
<tr><td>Conflicts reported</td><td>⚠️ unique-key clashes only (<code>conflict</code>); a lost concurrent write is silent</td><td>✅ <code>conflict$</code>: each conflict the server reported, with the handler's output</td></tr>
<tr><td>Atomic compare on the server</td><td>— nothing to compare: ops commute</td><td>⚠️ per plugin: atomic on RxDB storages, CouchDB, Supabase, MongoDB; not Firestore, Appwrite</td></tr>
<tr><td>Causality tracking</td><td>version vectors for delivery; per-field stamps; no causal context per record</td><td>none across replicas: a compare-and-set against the master's last state</td></tr>
<tr><td>Role of peer clocks</td><td>decide concurrent register writes; a clock never falls behind what it saw</td><td>unused by the protocol; backend checkpoints and LWW handlers bring their own</td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Delivery</strong></td></tr>
<tr><td>Realtime stream</td><td>✅ built in: the host's <code>changes</code> subscription pushes ops as they land</td><td>✅ <code>pull.stream$</code>, yours or a plugin's; <code>RESYNC</code> when events may be missed</td></tr>
<tr><td>Resume after a disconnect</td><td>✅ the link resumes the subscription from its last event id; push by vector</td><td>✅ a checkpoint pull (<code>RESYNC</code>) after each reconnect; the stream is not resumed</td></tr>
<tr><td>Resume after an app restart</td><td>✅ cursor, remote identity and vector are on disk; no bootstrap</td><td>✅ checkpoints stored per <code>replicationIdentifier</code>; a new state with the same id continues</td></tr>
<tr><td>Reconnect and backoff</td><td>✅ the link's: wrpc reconnects with backoff and a heartbeat; syncom greets again</td><td>⚠️ each plugin's own; a custom <code>stream$</code> must reconnect and emit <code>RESYNC</code></td></tr>
<tr><td>Failed requests</td><td>✅ a failed push leaves the peer <code>behind</code>, caught up later; backoff 1 s to 60 s</td><td>✅ each pull or push error goes to <code>error$</code>, retried after <code>retryTime</code> (5 s), forever</td></tr>
<tr><td>Duplicate and out-of-order delivery</td><td>✅ duplicates dropped by the vector; an op ahead of its stream dropped as a gap</td><td>✅ states, not ops: pages ordered by checkpoint, repeats harmless</td></tr>
<tr><td>Offline writes</td><td>✅ own ops kept until the registered nodes hold them; pushed when a peer is back<sup>47</sup></td><td>✅ local writes; on reconnect the latest state of each changed document is pushed</td></tr>
<tr><td>Bootstrap a new replica</td><td>✅ replays the host's log, or past its retention a streamed snapshot</td><td>✅ a checkpoint iteration from scratch over the backend's current documents</td></tr>
<tr><td>Back after a long outage</td><td>✅ a snapshot of its scopes once the host's log no longer covers it</td><td>✅ the same checkpoint pull; the backend must keep soft-deleted documents</td></tr>
<tr><td>Batch and page sizes</td><td><code>pageSize</code> 500 ops per push and per page; 500 records per snapshot page</td><td><code>pull.batchSize</code>, <code>push.batchSize</code>, 100 each; plugin defaults differ</td></tr>
<tr><td>Memory bounds</td><td>✅ per-peer outbox capped (<code>maxOutbox</code> 10 000); pages applied one at a time</td><td>⚠️ no explicit caps; four push batches in flight; queued changes coalesce per document</td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Partial replication</strong></td></tr>
<tr><td>Partial replication</td><td>✅ per-record scopes; the host bounds a peer's reads and writes by the record's scope</td><td>⚠️ one replication per scope, filtered by your backend; RxServer <code>queryModifier</code></td></tr>
<tr><td>Scoped realtime stream</td><td>✅ one subscription serves the granted scopes; other scopes' ops are skipped</td><td>⚠️ one stream per replication, scoped by your backend</td></tr>
<tr><td>Access lost after sync</td><td>❌ no revocation: the peer keeps what it received</td><td>❌ no signal: the client keeps its copy; RxServer then refuses its pushes</td></tr>
<tr><td>Pull-only or push-only</td><td>❌ every link pushes and subscribes; scopes bound both directions alike</td><td>✅ omit <code>push</code> or <code>pull</code>; pull-only stores no per-document meta</td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Deletes and attachments</strong></td></tr>
<tr><td>Deletes over replication</td><td>✅ a <code>delete</code> op leaves a tombstone on every node; a <code>purge</code> op erases</td><td>✅ <code>_deleted: true</code> with the whole document; the backend must keep it</td></tr>
<tr><td>Attachments over replication</td><td>❌ none: records are JSON, with no binary type</td><td>⚠️ in the protocol; only Google Drive and OneDrive carry them intact<sup>48</sup></td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Control and observability</strong></td></tr>
<tr><td>Start, pause, stop</td><td>✅ <code>sync.start()</code>/<code>stop()</code> for all peers; <code>enableNode(url, false)</code> per peer</td><td>✅ per replication <code>start()</code>, <code>pause()</code>, <code>cancel()</code>, <code>remove()</code>; <code>live: false</code> runs once</td></tr>
<tr><td>Waiting until in sync</td><td>⚠️ <code>sync(url?)</code> resolves once pushed; nothing awaits the inbound side</td><td>✅ <code>awaitInitialReplication()</code>, <code>awaitInSync()</code>, <code>awaitDocumentPushed(doc)</code></td></tr>
<tr><td>Forcing a re-sync</td><td>✅ <code>sync()</code> pushes what peers lack; <code>enableNode</code> off and on greets again</td><td>✅ <code>reSync()</code> runs a checkpoint pull; <code>emitEvent()</code> feeds the stream by hand</td></tr>
<tr><td>Replication status and events</td><td>✅ <code>peers()</code>: connected, cursor, pending, behind, stuck, lastError; <code>hosted()</code>; events</td><td>✅ <code>received$</code>, <code>sent$</code>, <code>error$</code>, <code>active$</code>, <code>canceled$</code>, <code>conflict$</code> per replication</td></tr>
<tr><td>Replication with several tabs</td><td>⚠️ one tab owns the storage and its sync; others get <code>LOCKED</code> or wait</td><td>✅ only the elected leader tab replicates (<code>waitForLeadership: true</code>); others see its writes<sup>49</sup></td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Server product</strong></td></tr>
<tr><td>Server product</td><td>✅ <code>sync.unit()</code>: four procedures for any wrpc router, in the same MIT package</td><td>⚠️ RxServer: the separate <code>rxdb-server</code> package (SSPL), over an RxDatabase</td></tr>
<tr><td>Where the server runs</td><td>✅ wherever a wrpc router runs: Node servers, a browser <code>PeerHost</code></td><td>⚠️ Node, through the Express adapter; Deno, Bun and Electron claimed, untested</td></tr>
<tr><td>HTTP framework adapters</td><td>✅ any wrpc host (MIT): its own <code>Server</code>, <code>uws</code>, <code>fastify</code>, <code>express</code></td><td>⚠️ Express free (SSPL); Fastify and Koa are Premium (Pro Plus)</td></tr>
<tr><td>What the server serves</td><td><code>hello</code>, <code>push</code>, <code>snapshot</code>, <code>changes</code> (a resumable subscription)</td><td>per collection <code>pull</code>, <code>push</code>, <code>pullStream</code> (SSE); REST <code>query</code>, <code>get</code>, <code>set</code>, <code>delete</code></td></tr>
<tr><td>Queries for thin clients</td><td>❌ none: a client replicates its scopes and queries locally</td><td>✅ RxServer REST endpoint and <code>client-rest</code>; live results over SSE</td></tr>
<tr><td>Server-side storage</td><td>a full syncom node: its own log and records over its <code>fsi</code></td><td>any RxStorage of the server's RxDatabase: memory, MongoDB, FoundationDB…</td></tr>
</tbody>
</table>

</div>

### Security and integrity

<div class="sc-matrix sc-matrix-duel">

<table>
<thead>
<tr>
<th>Feature</th>
<th><a href="https://github.com/Alexis-Technologies/syncom">syncom</a><br><sub>sync engine</sub></th>
<th><a href="https://github.com/pubkey/rxdb">RxDB</a><br><sub>local-first database</sub></th>
</tr>
</thead>
<tbody>
<tr class="sc-matrix-group"><td colspan="3"><strong>Encryption</strong></td></tr>
<tr><td>Encryption at rest</td><td>⚠️ per record (<code>{ encrypted: true }</code>) or the whole storage; such records never sync<sup>50</sup></td><td>⚠️ per field (schema <code>encrypted: [...]</code>): free <code>encryption-crypto-js</code>; WebCrypto is Premium (Pro)</td></tr>
<tr><td>What is encrypted</td><td>the record's whole data; its id, collection and timestamps stay readable</td><td>the listed fields only; primary key, other fields, <code>_meta</code>, <code>_rev</code> stay plain</td></tr>
<tr><td>Cipher and integrity</td><td>✅ AES-256-GCM with a fresh key per record, wrapped by RSA-OAEP-256</td><td>⚠️ free: AES-256-CBC, MD5 key derivation, no MAC; AES-GCM selectable in Premium<sup>51</sup></td></tr>
<tr><td>Key kept off the disk</td><td>❌ the RSA private key is a file in <code>&lt;path&gt;/keys/</code>, beside the data<sup>52</sup></td><td>⚠️ <code>password</code> given at <code>createRxDatabase</code>, kept in memory; an unsalted SHA-256 of it is stored<sup>53</sup></td></tr>
<tr><td>Changing the key or password</td><td>❌ no rotation API; a replaced key pair cannot open sealed records</td><td>❌ not possible; migrate into a new database, or wrap a meta-password</td></tr>
<tr><td>Encrypted attachments</td><td>— no attachments</td><td>✅ schema <code>attachments: { encrypted: true }</code></td></tr>
<tr><td>Encrypted data in backups and dumps</td><td>— no backup or export API; <code>snapshot()</code> leaves encrypted records out</td><td>⚠️ the <code>backup</code> plugin and <code>exportJSON()</code> write encrypted fields decrypted</td></tr>
<tr><td>Encrypted data and replication</td><td>encrypted records stay local: no op, no snapshot, no peer copy</td><td>encrypted fields replicate decrypted; the backend receives plaintext</td></tr>
<tr><td>End-to-end encryption</td><td>⚠️ recipe: seal fields in <code>beforeWrite</code>, open in <code>afterRead</code> (wrpc's HPKE sealer)<sup>54</sup></td><td>❌ none; replication reads the decrypted documents</td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Signatures, identity and integrity</strong></td></tr>
<tr><td>Signed changes</td><td>✅ Ed25519 per op: the header plus a salted payload digest<sup>55</sup></td><td>❌ none; Nostr keys sign WebRTC signaling, not documents</td></tr>
<tr><td>Node identity</td><td>✅ the node id is its Ed25519 public key; a swapped key is <code>IDENTITY_MISMATCH</code></td><td>⚠️ random tokens (<code>storageToken</code>, instance token); a key only through the Nostr handler</td></tr>
<tr><td>Tamper-evident history</td><td>✅ hash-linked chain of what this node applied, unsigned (optional)<sup>56</sup></td><td>❌ none; <code>_rev</code> is a height plus the writer's instance token</td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Access control on the serving side</strong></td></tr>
<tr><td>Authentication where data is served</td><td>✅ <code>unit({ authorize })</code> gates <code>hello</code>; <code>access: 'session'</code> refuses everyone by default<sup>57</sup></td><td>✅ RxServer <code>authHandler(headers)</code>, re-run before each streamed event<sup>58</sup></td></tr>
<tr><td>Peer validation (P2P)</td><td>⚠️ host <code>authorize</code>; dialer <code>beforeConnect</code>, <code>beforeBootstrap</code>; key possession not proven</td><td>✅ <code>isPeerValid(peer)</code>; the Nostr handler verifies each peer's public key<sup>59</sup></td></tr>
<tr><td>Per-client read filtering</td><td>✅ per-record scopes (<code>sync.scope</code>); a peer reads only the scopes <code>hello</code> granted<sup>60</sup></td><td>✅ RxServer <code>queryModifier(authData, query)</code>; <code>serverOnlyFields</code> hidden from clients</td></tr>
<tr><td>Per-client write rules</td><td>⚠️ ops outside granted scopes refused, by the op's scope and its record's; <code>beforeApply({ op, peer })</code> can skip one<sup>61</sup></td><td>✅ RxServer <code>changeValidator(authData, change)</code>: one refused row is 403 for the push</td></tr>
<tr><td>Server re-validates a client's write</td><td>✅ the host runs the entity validators on every peer op (<code>OP_INVALID</code>)</td><td>⚠️ only if the server's storage is wrapped in a <code>validate-*</code> plugin<sup>62</sup></td></tr>
<tr><td>A server can reject a write before it spreads</td><td>⚠️ out-of-scope (by the op or its record), unsigned and malformed ops stop at the host; one its validator or <code>beforeApply</code> skips is relayed<sup>63</sup></td><td>✅ RxServer is the master: a refused push reaches no client<sup>64</sup></td></tr>
<tr><td>Rate and size limits</td><td>✅ <code>unit({ limits })</code>: <code>opsPerPush</code>, <code>bytesPerPush</code> (413), <code>opsPerSecond</code> (429)</td><td>❌ none in RxServer; <code>$regex</code> queries refused against ReDoS</td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Erasure, history and audit</strong></td></tr>
<tr><td>Purge: the payload leaves history</td><td>✅ <code>purge(id)</code>: a <code>purge</code> op that wins at any stamp, then a scrub of the op log<sup>65</sup></td><td>⚠️ <code>cleanup</code> plugin drops tombstones after <code>minimumDeletedTime</code> (31 days)<sup>66</sup></td></tr>
<tr><td>Erasure across replicas</td><td>✅ the purge op replicates; every peer that takes it scrubs its own log<sup>67</sup></td><td>❌ cleanup is local; a delete replicates as a tombstone with the full data</td></tr>
<tr><td>History / time travel</td><td>⚠️ op log within retention (<code>storage.log.entriesOf(id)</code>); no read-at-version</td><td>⚠️ latest revision only; the <code>crdt</code> plugin keeps every op in the document<sup>68</sup></td></tr>
<tr><td>Who made a change</td><td>✅ every op names its origin key and an <code>actor</code>, kept in the log<sup>69</sup></td><td>❌ none; <code>crdt</code> ops carry the writer's storage token and a time</td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Input hardening</strong></td></tr>
<tr><td>Prototype pollution</td><td>✅ own keys only; <code>__proto__</code> is never a field</td><td>✅ mingo and dot-prop refuse <code>__proto__</code> paths</td></tr>
<tr><td>Malformed data from a peer or backend</td><td>✅ <code>wellFormed</code> before anything is read; counted <code>malformed</code>, never logged or relayed</td><td>⚠️ only with a <code>validate-*</code> wrapper: the invalid document is dropped (<code>RC_PULL</code>)<sup>70</sup></td></tr>
<tr><td>Clock-skew guard</td><td>✅ stamps over <code>sync.maxSkew</code> (24 h) ahead refused (<code>SKEW</code>), never observed</td><td>— no peer clocks: conflicts compare document states</td></tr>
</tbody>
</table>

</div>

### Extensibility and operations

<div class="sc-matrix sc-matrix-duel">

<table>
<thead>
<tr>
<th>Feature</th>
<th><a href="https://github.com/Alexis-Technologies/syncom">syncom</a><br><sub>sync engine</sub></th>
<th><a href="https://github.com/pubkey/rxdb">RxDB</a><br><sub>local-first database</sub></th>
</tr>
</thead>
<tbody>
<tr class="sc-matrix-group"><td colspan="3"><strong>Hooks and events</strong></td></tr>
<tr><td>Write hooks / middleware</td><td>✅ <code>beforeWrite</code> replaces data or refuses, <code>afterWrite</code>; one function per name</td><td>✅ pre/post <code>insert</code>/<code>save</code>/<code>remove</code>, plus <code>postCreate</code>; many, series or parallel</td></tr>
<tr><td>Hooks on replicated changes</td><td>✅ <code>beforeApply</code> skips or aborts per op, <code>afterApply</code>, <code>beforeBootstrap</code></td><td>⚠️ <code>pull.modifier</code> per replication; collection hooks skip pulled documents</td></tr>
<tr><td>Filter outgoing changes</td><td>❌ none, by design: a withheld op is a gap; scopes decide what leaves</td><td>✅ <code>push.modifier</code> transforms a document or drops it (<code>null</code>)</td></tr>
<tr><td>Read hooks</td><td>⚠️ <code>beforeRead</code> / <code>afterRead</code> wrap <code>get()</code>; queries and snapshots read raw<sup>71</sup></td><td>❌ none; <code>postCreate</code> runs when a document object is built</td></tr>
<tr><td>Refusal and error events</td><td>✅ <code>error</code> with a code per refused peer op; <code>conflict</code>; host <code>refused</code>, <code>hello</code></td><td>✅ replication <code>error$</code> (<code>RC_PULL</code>, <code>RC_PUSH</code>), <code>conflict$</code>; rejected local writes throw</td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Extensibility and operations</strong></td></tr>
<tr><td>Plugin system</td><td>❌ none; per-instance injection: <code>fsi</code>, <code>validator</code>, <code>search</code>, <code>telemetry</code>, <code>logger</code>, <code>connect</code></td><td>✅ <code>addRxPlugin()</code>: prototypes, overwritables and 24 plugin hooks<sup>72</sup></td></tr>
<tr><td>Typed errors</td><td>✅ <code>SyncomError.code</code>: 30 codes, plus 3 on <code>TypeError</code>s; full messages</td><td>✅ <code>RxError.code</code>: 215 codes; the message text only with <code>dev-mode</code></td></tr>
<tr><td>Logging</td><td>✅ <code>open({ logger })</code>: a Console, a pino-shaped logger or <code>false</code>; named events</td><td>⚠️ Premium <code>logger</code> storage wrapper (Pro Plus); the core logs nothing</td></tr>
<tr><td>OpenTelemetry</td><td>✅ spans and metrics through an injected API; no OpenTelemetry dependency</td><td>❌ none</td></tr>
<tr><td>Health and stats</td><td>✅ <code>stats()</code>, <code>peers()</code>, <code>hosted()</code>, observable gauges</td><td>❌ no stats API; replication states have <code>active$</code> and <code>awaitInSync()</code></td></tr>
<tr><td>Personal data in diagnostics</td><td>✅ no id, origin, scope or key as a metric label; <code>includeIdentity: false</code> for spans</td><td>⚠️ error messages embed their parameters: documents, pushed rows, password hashes<sup>73</sup></td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>UI bindings</strong></td></tr>
<tr><td>React</td><td>❌ none</td><td>✅ <code>rxdb/plugins/react</code>: <code>RxDatabaseProvider</code>, <code>useRxQuery</code>, <code>useLiveRxQuery</code>, <code>useRxDocument</code>…</td></tr>
<tr><td>Vue</td><td>❌ none</td><td>✅ <code>rxdb/plugins/reactivity-vue</code>: shallow refs through the <code>$$</code> accessors</td></tr>
<tr><td>Angular</td><td>❌ none</td><td>✅ <code>rxdb/plugins/reactivity-angular</code> (signals); observables fit the <code>async</code> pipe</td></tr>
<tr><td>Svelte</td><td>❌ none</td><td>⚠️ no plugin; a Svelte 5 example app runs in CI</td></tr>
<tr><td>Signals and custom reactivity</td><td>❌ none</td><td>✅ <code>reactivity</code> option: Preact signals plugin, or your own factory; no Solid adapter</td></tr>
<tr><td>TanStack DB</td><td>❌ none</td><td>⚠️ <code>@tanstack/rxdb-db-collection</code>, published by TanStack (0.1.111)</td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Developer tooling</strong></td></tr>
<tr><td>Development mode</td><td>— no separate mode: argument checks and full error messages always on</td><td>✅ <code>rxdb/plugins/dev-mode</code>: readable errors, deep-freeze, schema and query checks<sup>74</sup></td></tr>
<tr><td>Test helpers</td><td>⚠️ <code>createMemoryFsi()</code> for in-memory stores; contract suites stay in the repo</td><td>✅ memory storage; <code>rxdb/plugins/test-utils</code> (fixtures, replication test suite); <code>using</code> closes databases<sup>75</sup></td></tr>
<tr><td>Own test suite and CI</td><td>722 <code>node:test</code> tests; coverage gate 95/95/90/95; CI on Node 22 and 24, Linux</td><td>74 test files per storage; Linux, Windows, browsers, Bun, Deno, 11 example apps; no coverage gate</td></tr>
<tr><td>Documentation</td><td>21 pages, about 41,500 words, with an API reference</td><td>271 pages, about 463,000 words: 98 articles, 46 landing pages</td></tr>
<tr><td>Example apps</td><td>⚠️ two Node.js scripts (<code>examples/main.js</code>, <code>domain.js</code>), linted but not run</td><td>✅ 13 example apps; 11 run in CI: Angular, React, React Native, Electron, Tauri, Vue, Svelte…</td></tr>
</tbody>
</table>

</div>

### Project and ecosystem

<div class="sc-matrix sc-matrix-duel">

<table>
<thead>
<tr>
<th>Feature</th>
<th><a href="https://github.com/Alexis-Technologies/syncom">syncom</a><br><sub>sync engine</sub></th>
<th><a href="https://github.com/pubkey/rxdb">RxDB</a><br><sub>local-first database</sub></th>
</tr>
</thead>
<tbody>
<tr class="sc-matrix-group"><td colspan="3"><strong>Releases and maintenance</strong></td></tr>
<tr><td>Breaking major releases</td><td>none yet: 0.0.1, never published</td><td>10 majors from 8.0 (2018) to 17.0 (2026); three in 2022<sup>76</sup></td></tr>
<tr><td>Minor release cadence</td><td>no release yet; cut by hand from a checklist</td><td>about monthly: 17.0 to 17.6 between March and October 2026</td></tr>
<tr><td>Free-tier changes over releases</td><td>— no paid tier (MIT)</td><td>⚠️ Premium since 12.0 (2022); Worker storage moved in at 14.0; collection cap since 16.0<sup>77</sup></td></tr>
<tr><td>Named production users</td><td>none yet (unreleased)</td><td>10 testimonials (Readwise, Nutrien, Venice.ai, …); one case study</td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Support and ecosystem</strong></td></tr>
<tr><td>Commercial support</td><td>❌ none offered</td><td>⚠️ paid: €180 one-hour consulting; Enterprise SLA, 24-hour first response<sup>78</sup></td></tr>
<tr><td>Community help</td><td>GitHub repository; no chat or forum</td><td>Discord, GitHub; a bug report needs a PR with a failing test</td></tr>
<tr><td>Third-party plugins</td><td>none (pre-release)</td><td>8 listed, e.g. <code>rxdb-hooks</code>, <code>rxdb-flexsearch</code>, <code>rxdb-supabase</code></td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>Adoption and trust</strong></td></tr>
<tr><td>Adoption signals</td><td>pre-release, not on npm yet</td><td>23,412 GitHub stars; 63,815 npm downloads in the week to 2026-10-18</td></tr>
<tr><td>Import from other databases</td><td>❌ no importer and no JSON import; write records with <code>insert()</code></td><td>⚠️ migration guides only; <code>importJSON()</code> takes an RxDB dump of the same schema<sup>79</sup></td></tr>
<tr><td>Published benchmarks</td><td>✅ nine libraries, six scenarios, memory and disk; machine and date stated</td><td>⚠️ its own storages only; no machine, browser or date given<sup>80</sup></td></tr>
<tr class="sc-matrix-group"><td colspan="3"><strong>AI and coding agents</strong></td></tr>
<tr><td>WebMCP agent tools</td><td>❌ none</td><td>✅ <code>rxdb/plugins/webmcp</code>: query, count, changes, insert, upsert, delete tools per collection; <code>readOnly</code><sup>81</sup></td></tr>
<tr><td>Docs for coding agents</td><td>✅ <code>llms.txt</code> on the docs site; <code>CLAUDE.md</code> in the repository</td><td>✅ <code>llms.txt</code> plus three topic files; <code>ERROR-MESSAGES.md</code>, <code>CLAUDE.md</code>, <code>AGENTS.md</code> in the package<sup>82</sup></td></tr>
</tbody>
</table>

</div>

### Notes

1. The agreement also requires shipping Premium code minified without source maps, gives no technical support, and says installing it (an access-token <code>postinstall</code> downloads and decrypts it) sends the package name, dependency list, git user name and email, and IP address to the vendor.
2. Measured: the 14th collection opens after a wait of about 1.86 s and the 15th throws <code>COL23</code>. The count spans every database in the process; 17.0.0 lowered it from 16 to 13.
3. The docs say the dev-mode iframe is added on localhost only, but the <code>isLocalHost()</code> check is commented out (<code>dev-mode-tracking.ts:67</code>), so it loads on any host unless the Premium flag is set. The production core makes no such call.
4. The Filesystem and SQLite storages are Premium (Pro); the free SQLite trial stops at 500 documents and after 500 SQL calls per storage instance.
5. The page offers SQLite as 'a free solution' but its sample imports <code>rxdb-premium/plugins/storage-sqlite</code>, and the sample's <code>ignoreDuplicate: true</code> throws <code>DB9</code> without dev-mode (checked).
6. The article and examples/flutter import <code>rxdb/plugins/storage-lokijs</code>, removed in 16.0.0; the Flutter CI job is commented out, and the Dart package on pub.dev is 15.0.0-beta.31 from 2023-11-21.
7. There are no cross-tab change events and no read-only open: the other tabs wait for the lock (<code>lock: 'wait'</code>) or route reads and writes to the owner through a <code>BroadcastChannel</code>.
8. The free Dexie storage prints a console warning advertising Premium once per process, when a database is created, unless the Premium package's <code>setPremiumFlag()</code> is called; it also refuses indexes on fields that are not required (<code>DXE1</code>).
9. The trial throws <code>SQL3</code> after 500 SQL calls per storage instance: a write runs one whole-table read plus one insert per new document, so the 251st serial insert fails (measured). <code>SQL2</code> stops it at 500 documents. It has no indexes or attachments.
10. One Node.js process per MongoDB database, per the docs; nothing in the storage enforces it (no change-stream listening, a TODO in the code).
11. Attachments are not implemented (<code>getAttachmentData()</code> throws "Method not implemented."); the DenoKV page does not say so.
12. The premium page still lists LokiJS among the free default storages.
13. By default a write resolves before it reaches the persistent storage (<code>awaitWritePersistence: true</code> waits); no attachments; one JavaScript process per store, a SharedWorker for tabs.
14. Files are rewritten in place, with no temp file and rename: on node:fs a crash mid-write can tear a record file, which then fails to parse until <code>repair(id)</code>.
15. Two browser tabs are two instances: the second sees <code>LOCKED</code>, so one tab or a worker must own the storage.
16. <code>repair(id)</code> rebuilds a record while the log keeps a whole-record op for it; otherwise it is <code>UNRECOVERABLE</code>, and a peer's snapshot is the way back.
17. The chain is never compacted: one block file per local write and per applied batch, kept for good.
18. Not supported by the SQLite trial (<code>SQL1</code>), MongoDB, DenoKV or memory-mapped storages.
19. It deletes each migrated batch from the old storage and does not check write errors on the new one (a TODO in the code); deleted documents are dropped.
20. Restoring an older copy of a node's directory is caught at the next hello (<code>REWOUND</code>): the node moves past the seqs its host holds and bootstraps the lost state back; writes made between the restore and that hello are lost to the host.
21. A dump has no deleted documents and no revisions, holds encrypted fields in plain text, and is built in memory.
22. Without dev-mode and a validator, an empty, over-long or missing key is accepted; on the memory storage an insert without the key was stored under <code>undefined</code> (IndexedDB rejects that one).
23. Without dev-mode, <code>patch()</code> overwrote a <code>final</code> field, and patching the primary key wrote a copy under the new key beside the original (checked by running); dev-mode refuses both (<code>DOC9</code>).
24. The <code>validate-ajv-standalone</code> plugin documented on rxdb.info is not in 17.6.0; it is on master, unreleased.
25. Without the wrapper, production accepts unknown top-level fields, wrong types and missing required fields (checked by running).
26. Concurrent edits to two keys of one nested object keep only one side, and <code>update({ 'a.b': 1 })</code> writes a top-level field named <code>a.b</code> (both documented in the Storage and Sync guides).
27. A counter that one node resets while another increments it does not converge to the intuitive value; see Guarantees and limits in the Sync guide.
28. The document grows with every write: 200 <code>$inc</code> left 201 op rows, about 18 KB (checked by running), and every replica stores and transfers them.
29. Checked by running: <code>upsert()</code> over a CRDT document reset its op list to one entry, <code>incrementalUpsert()</code> dropped the CRDT field, and with the <code>update</code> plugin added after <code>crdt</code>, <code>update()</code> wrote outside the ops. Dev-mode stops the last two, not <code>upsert()</code>.
30. Storage does not replicate through them, and <code>merge({ hits: 10 }, diff({ hits: 10 }, { hits: 3 }))</code> is 13: a delta is not a plain patch.
31. Checked by running without dev-mode: editing <code>toJSON().nested</code> changed the cached document (and the memory storage's copy), though the docs call <code>toJSON()</code> immutable.
32. Nothing declares the relation, so an unrelated string that matches an id becomes a <code>Reference</code> too (checked by running).
33. Load contracts only from a chain you control; the parser takes a single arrow function, and the result is written with <code>saveData()</code>.
34. Without dev-mode, a <code>RegExp</code> instance is normalized to <code>{}</code> and the query matches every document (verified on 17.6.0).
35. Any <code>desc</code> sort key forces a re-sort of every match, since most storages have no descending index (query-planner.ts:44-48).
36. A range or an <code>order()</code> on an indexed field is evaluated over every candidate: the whole collection unless an indexed equality or <code>$in</code> narrows it. Checked on 200 records: <code>$gt</code> read 200, with an indexed equality 20, a covered cursor 0.
37. Without dev-mode the memory storage fails at <code>addCollections()</code> with an uncoded <code>TypeError</code>, and Dexie accepts the index on a required field but queries through it find nothing (checked by running).
38. RxServer compares the integer version only, with no schema hash. Elsewhere every replica must run the same migration, and the backend must accept checkpoints of older versions.
39. The WebRTC page says there is "no master-slave concept"; the code makes one peer of every pair the master, and only the other side runs a replication.
40. On the MongoDB and FoundationDB storages a process sees only its own writes (the change-stream relay is a commented-out TODO), so a live stream misses writes made through another process until its next <code>RESYNC</code>.
41. Without <code>signalingServerUrl</code> the handler uses <code>wss://signaling.rxdb.info/</code>, which the code warns is for demos only; the official quickstart app uses it.
42. The server ignores the client's <code>auth</code> message, and one message naming an unknown collection crashes the Node process (both checked by running).
43. In a one-off check over wrpc 2.0.1, <code>transport: 'sse'</code> synced both ways with a live update; plain <code>http</code> cannot (the subscription is refused, then every call answers 428).
44. With <code>pull.batchSize</code> unset the query asks for 20 documents while the core stops at a page under 100, so a cycle pulls only 20 (checked by running).
45. The push compare runs inside <code>runTransaction</code> without using the transaction, so a write landing between its read and commit is overwritten (code reading).
46. Some RxDB pages call the default last-write-wins; the code keeps the server's state whatever its time (https://rxdb.info/articles/zero-latency-local-first.html).
47. Ops written before any node was registered, and compacted since, cannot reach a host; it is reported once per hello (<code>UNDELIVERABLE</code>).
48. Over the WebSocket and WebRTC plugins attachment data is silently corrupted, since Blobs pass through <code>JSON.stringify</code> (checked by running); RxServer, GraphQL, Appwrite and MongoDB drop it.
49. A visible tab that is not the leader also starts replicating (<code>toggleOnDocumentVisible</code>, on by default), so two tabs can replicate at once (code reading).
50. The RSA key pair that unseals the records sits unprotected in <code>&lt;path&gt;/keys/</code>, beside the data: whoever can read the directory can read the records.
51. crypto-js's passphrase mode derives key and IV with EVP_BytesToKey (MD5, one iteration) and authenticates nothing, and crypto-js is discontinued; the page calls the plugin 'tamper proof'.
52. Mode 0600 where the backend has permissions; in OPFS or IndexedDB a plain entry. No passphrase, KMS or injected key.
53. The stored hash lets anyone with the files test password guesses offline at SHA-256 speed (checked: it equals <code>sha256(JSON.stringify(password))</code>).
54. One paragraph, with no example or test in the repository; a sealed field cannot be indexed, queried, counted or kept unique.
55. The default <code>'verify'</code> takes an unsigned op, so a relay can strip signatures; only <code>sync.signatures: 'require'</code> refuses them.
56. Whoever can write the directory can rebuild it: a read checks a record against the block its file names, not that the block is on the chain, so a planted block passes and <code>validate()</code> still answers true (checked). The ops in the log are what is signed.
57. <code>hello</code> does not prove the peer holds its key, and the dialer's <code>token</code> sits in plain text in <code>&lt;path&gt;/remote/</code>.
58. Defaults are open: with no <code>authHandler</code> every request is admitted, and the Express adapter's default CORS reflects any request origin with credentials. The documented <code>validUntil</code> is never read. The server listens on localhost unless told otherwise. The <code>replication-websocket</code> server has no auth at all.
59. Once valid, a peer reads and writes every document of the collection.
60. The peer names its scopes, and naming none means everything: <code>authorize</code> must check <code>hello.scopes</code>.
61. A finer rule than scopes lives in <code>beforeApply</code>: a skip is local (the op is still logged and relayed), a throw refuses the whole page.
62. Collection hooks do not run on replicated writes, and a 422 throws after the valid rows of the batch were written.
63. Checked with three nodes: an op the middle node's validator or <code>beforeApply</code> skipped still reached the node behind it, because a withheld op would leave a gap in its origin's stream; every node re-checks it. A throwing <code>beforeApply</code> refuses the whole page instead, and the sender offers it again later.
64. Over WebRTC there is no master: each peer's storage decides alone.
65. The chain keeps an unsalted SHA-256 of every version this node wrote or applied, so whoever holds the directory can confirm a guessed record; until the next catalog save, <code>index/catalog.json</code> may still hold its indexed fields.
66. A removed document keeps all its data in the tombstone until then, and forever without the plugin; <code>cleanup(0)</code> forces it once replications are in sync.
67. A peer that never comes back keeps what it had.
68. Op compaction is not implemented, so a <code>crdt</code> document carries every past value, in its tombstone too.
69. <code>actor</code> is the writer's signed claim; a host holds it to what <code>authorize</code> established in <code>beforeApply</code>.
70. Without a wrapper a pulled document with wrong types and extra fields is stored as sent (checked by running).
71. An <code>afterRead</code> redaction does not reach <code>select()</code> rows, so it is not a read access control.
72. Plugins are process-wide and cannot be removed.
73. Checked by running: a wrong password's <code>DB1</code> carries both the given and the stored password hash.
74. Without it an error carries only its code. With it, the storage must be wrapped in a schema validator (<code>DVM1</code>), and in browsers it adds a tracking iframe (see Calls to the vendor).
75. The testing page's multi-tab simulation needs <code>ignoreDuplicate: true</code>, which throws <code>DB9</code> unless dev-mode is on, and the 13-collection limit counts every database a test run leaves open.
76. Majors 13, 14, 16 and 17 each told users of some or all storages to move their stored data with the <code>migration-storage</code> plugin or to re-sync it from the backend.
77. The open-source cap on open collections was 16 in 16.0 and is 13 since 17.0. Two features went the other way: <code>migration-storage</code> (15.0) and the Vue and Preact signals plugins (17.0) became free.
78. The Pro and Pro Plus agreement says 'No Technical Support'; free users get GitHub and Discord, and a bug report is expected as a pull request with a failing test.
79. No converter ships: the Realm, PouchDB, Dexie, LokiJS, NeDB, GUN and other guides read the old store and call <code>bulkInsert</code>/<code>bulkUpsert</code> by hand.
80. Most measured storages are Premium (OPFS, IndexedDB, SQLite, Filesystem); the free localStorage storage that most guides use is not measured.
81. WebMCP is an experimental browser API; where <code>navigator.modelContext</code> is missing the docs point to the <code>@mcp-b/global</code> polyfill.
82. In the 17.6.0 tarball all 215 entries of ERROR-MESSAGES.md are headed <code>## undefined</code>, and COL23 states a limit of 16 collections where the code enforces 13.

<!-- comparison:end -->

## Speed

Both run the same scenarios on the [Benchmarks](/guide/benchmarks) page, in a fresh process each,
on one machine. RxDB runs in memory only there, because its Node.js disk storages are Premium.

<BenchCompare :only="['syncom', 'syncom-nochain', 'rxdb']" kind="insert" line="memory" />

<BenchFigure chart="size" :only="['syncom', 'rxdb']" />

Measured in memory, the two insert a record at about the same rate. RxDB updates a field about
three times as fast and replicates a store into an empty replica about two and a half times as
fast; syncom signs every op and verifies each one it receives (`sync.signatures: false` trades
that away). syncom reads a record by id about three and a half times as fast, from its cache.
RxDB's `bulkInsert()` is two orders of magnitude ahead, because syncom has no bulk write: each
record is its own signed, logged op. On disk there is nothing to compare in Node.js, and a browser
app that keeps records and syncs them ships about 43 KB of syncom against 90 KB of RxDB with
Dexie, min+gzip.

## Which to choose

- **RxDB** when the data already lives in a backend (Supabase, CouchDB, Firestore, MongoDB,
  GraphQL or your own REST) and the device keeps a replica of it; when the app needs React,
  Vue or Angular bindings, React Native, Expo, Capacitor or Electron, several tabs on one
  database, attachments, or a rich write API; and when a mature project with paid support matters
  more than the license of its storage layer.
- **syncom** when the nodes replicate among themselves, with no backend of record: servers,
  browser tabs and peers in a mesh, any of which can host. When concurrent edits must merge field
  by field and counters must add up, when you need to prove which node wrote what, verify what is
  stored and erase it everywhere, and when zero dependencies, a 42 KB bundle and an MIT license
  for everything, Node.js disk persistence included, are requirements.
- **Neither** for collaborative text: Yjs, Automerge or Loro merge text character by character,
  and can live in a field of either.
