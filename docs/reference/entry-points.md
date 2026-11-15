---
title: Entry points
description: Every subpath of @alexify/syncom, how each is registered or called, what a missing plugin does, and the size of each entry.
---

# Entry points

syncom is a core and blocks. The core, `@alexify/syncom`, keeps records with registers, counters and sets
(fields by path among them), the op log, the three write paths, transactions, the catalog, the present's
patches and the changes every op reports, and the ops a peer sends or lacks (`applyRemote()`,
`outbound()`). Everything beyond that is a subpath imported when it is needed, and nothing is registered
process-wide: a database runs with the plugins its `createDatabase()` was given, and another database in
the same process may run with others. The guide's [Installation](../guide/install#pick-only-the-plugins-you-need)
page shows how to choose.

Every entry is CommonJS and spells its exports in the shape `cjs-module-lexer` reads, so an ES module
importer sees the same names (`tests/package/esm.test.js`). Types sit beside every entry (`<name>.d.ts`);
`@alexify/syncom/signing` and `@alexify/syncom/encryption` carry browser types of their own
(`*.browser.d.ts`) for the functions that return promises there.

## The subpaths

| Import | What it is | Registered or called how |
| --- | --- | --- |
| `@alexify/syncom` | the core | — |
| `@alexify/syncom/all` | the core with every shipped plugin registered: `text`, `tree`, `signing`, `chain`, `encryption`, `sync`, `schema`, `telemetry`, `query`, `versions`, `local`, ahead of the caller's (a plugin given twice is given once) | `createDatabase()` of `/all` |
| `@alexify/syncom/text` | the `list` and `text` kinds: Fugue runs, marks, cursors, `splice` … `move`, embeds and blocks, `openText()` | `createDatabase({ plugins: [text] })` |
| `@alexify/syncom/tree` | the `tree` kind: a movable tree per field, `treeMove`, `treeRemove` | `createDatabase({ plugins: [tree] })` |
| `@alexify/syncom/signing` | the identity as an Ed25519 key, every own op signed, a peer's verified (`sync.signatures`); the key functions | `createDatabase({ plugins: [signing] })` |
| `@alexify/syncom/chain` | the hash-linked chain: a block per applied batch, the check on a cold read, `validate()`; `Blockchain` | `createDatabase({ plugins: [chain] })` |
| `@alexify/syncom/encryption` | records sealed for this node (`encrypted: true`); `atRest()`, a backend or engine wrapper that encrypts every byte; `rotateAtRest()` | `createDatabase({ plugins: [encryption] })`; `createDatabase({ fsi: atRest(fsi, …) })` or `({ engine: atRest(engine, …) })` |
| `@alexify/syncom/sync` | the sync manager: nodes, links, pushes, the feed, the bootstrap, the hosting unit; the core keeps `applyRemote()` and `outbound()` | `createDatabase({ plugins: [sync] })` |
| `@alexify/syncom/schema` | entity definitions: collections, validation, indexes, migrations and the lens, `migrate()`, `check()` | `createDatabase({ plugins: [schema], schema })` |
| `@alexify/syncom/query` | the cursor behind `select()`, `count()` and `watch()` on a collection; the catalog stays in the core | `createDatabase({ plugins: [query] })` |
| `@alexify/syncom/versions` | the past: `get(id, { at })`, `history()`, `diff()`, `restore()`, the tags; `applyPatches()` and `compact()` stay in the core | `createDatabase({ plugins: [versions] })` |
| `@alexify/syncom/local` | local documents: `db.local` and `collection.local`, JSON values beside the records that never become an op | `createDatabase({ plugins: [local] })` |
| `@alexify/syncom/telemetry` | the OpenTelemetry adapter: `{ api }` or `{ tracer, meter }` into the writer the engine records through; `createTelemetry()` | `createDatabase({ plugins: [telemetry], telemetry })` |
| `@alexify/syncom/attachments` | bytes beside a record in the engine's blobs store, named on it as a register that replicates; fetched from a peer on demand, checked by digest | `createDatabase({ plugins: [attachments({ compression })] })` |
| `@alexify/syncom/state` | persistent app state by name and path, over a record (replicated, a path a register) or a local document | `createState(db, name)` |
| `@alexify/syncom/dump` | a database as JSON and back: `exportJSON`/`exportPages`, `importJSON` (merge or insert), `migrateStorage` between engines | functions over a database |
| `@alexify/syncom/pipeline` | a handler over every change of a collection, once, in order, checkpointed: a derived collection | `createPipeline(db, { name, source, handler })` |
| `@alexify/syncom/cleanup` | tombstone cleanup: an old, acknowledged tombstone folded whole into the `tombstones` kv namespace | `cleanup(db, options)` |
| `@alexify/syncom/connector` | a collection kept in step with a backend of its own through `pull` and `push` handlers | `replicate(db, { name, collection, pull, push })` |
| `@alexify/syncom/connector/couchdb`, `/graphql`, `/firestore`, `/supabase`, `/mongodb`, `/appwrite`, `/gdrive`, `/onedrive` | the handlers of a connector for that backend | passed to `replicate()` |
| `@alexify/syncom/shared` | several instances over one database: one leads, the others follow (read-only over the same engine) and write through it over a channel; the leader gone, a follower takes its place | `openShared({ createDatabase, path, engine, channel, election })` |
| `@alexify/syncom/mcp` | the tools an agent calls over a database, in the Model Context Protocol's shape: query, count, get, changes, wait_changes, insert, upsert, delete per collection, every argument checked against the tool's `inputSchema`; registering them is the caller's | `createTools(db, { collections, readOnly, limit, sealed })` |
| `@alexify/syncom/testing` | what a test over syncom stands on: the memory engine, an in-process link with a transport's hazards (latency, a page dropped or doubled, a disconnect), a mesh of nodes from an adjacency list, `settle()`, `waitUntil()`, `withDatabase()` | `createMesh(names, edges, { createStorage })` |
| `@alexify/syncom/undo` | the undo stack over the commit event: `createUndo`, `UndoManager` | functions over a database |
| `@alexify/syncom/branch` | forks and merges: `branch`, `merge`, `branchInfo`, `drop` | functions over a database |
| `@alexify/syncom/order` | fractional indexes for ordering records: `between`, `spread`, `compare`, `isKey` | functions |
| `@alexify/syncom/presence` | who is here and what they point at: a state per node, signed, relayed by a host's rooms, never logged | `createPresence(db)`; carried by `db.sync.presence()` |
| `@alexify/syncom/editor`, `/prosemirror`, `/codemirror` | an editor bound to a text field: the generic binding and its deltas, and adapters for ProseMirror and CodeMirror 6 (their modules injected) | functions over a database |
| `@alexify/syncom/store` | a query, a record or a presence as one store: Svelte's contract and React's `useSyncExternalStore` | `toStore(source)`, `fromEvents`, `toObservable` |
| `@alexify/syncom/inspect` | a record's anatomy, raw (`inspect`), an anonymized copy for a bug report (`anonymize`), and `indexAdvisor` | functions over a database |
| `@alexify/syncom/memory` | `memory()`, the backend in memory, and `memoryEngine()`, the engine in memory | `createDatabase({ fsi })`, `createDatabase({ engine })` |
| `@alexify/syncom/layered` | `layered([top, …, bottom])`, one backend over several as a multi-level cache | `createDatabase({ fsi })` |
| `@alexify/syncom/idb` | IndexedDB as a backend (`createIdbFsi`) and as an engine (`idbEngine`); browser only | `createDatabase({ fsi })` or `({ engine })` |
| `@alexify/syncom/sqlite` | `sqliteEngine()`, the engine over SQLite: `node:sqlite` or a driver; Node only | `createDatabase({ engine })` |
| `@alexify/syncom/mongodb` | `mongoEngine()`, the engine over MongoDB, the driver's client injected; `mongoSharedLog`; Node only | `createDatabase({ engine })` |
| `@alexify/syncom/engines` | `serveEngine`/`remoteEngine`/`connectEngine`, an engine over a message port (a worker); `copyEngine`, a database moved between engines | functions over engines |
| `@alexify/syncom/search` | the text index behind `$text` (`createSearch`) and the vector distances `nearest()` takes | `createDatabase({ search: createSearch() })` |
| `@alexify/syncom/wrpc` | the wrpc link adapter (`createWrpcLink`) and the tabs' channel (`createSharedChannel`) | `sync.connect` |
| `@alexify/syncom/contracts` | smart contracts: `SmartContract`, `DataReader`; never in the root, so a process that does not import it never runs a block's code | functions |

## What a plugin changes, and what it does not

- A method of a plugin the database was not opened with (`splice()` without `text`, `treeMove()` without
  `tree`) rejects with a `TypeError` whose `code` is `PLUGIN_MISSING` and whose message names the subpath.
  So does a patch of its action in `applyPatches()`, and a reopen of a directory that ran with the plugin
  before (`node.json` names the kinds it ran with; more kinds than before is fine).
- The op types and their codes on the wire are the protocol's, not a plugin's: a node without the plugin
  admits, logs and relays a peer's op of that kind and refuses to apply it (`OP_REFUSED`,
  `reason: 'kind'`). A hub that runs the core alone carries a text between two nodes that have the plugin.
  A snapshot it serves lacks the field, which is why a node never bootstraps from a host whose `hello`
  named fewer kinds than its own (`KINDS_MISMATCH`, reported once; the feed resumes as it can). The rule
  for a mesh: every node that holds a record needs the kinds its peers write to it, and a hosting unit that
  serves snapshots should have every kind its peers use.
- The kinds' precedence (what wins when two nodes make one field as two kinds) is the registry's declared
  ranks: the register, the counter, the set, then every plugin's kinds, unique. It reads kinds alone, so it
  commutes whatever the set of plugins.
- Security is opt-in, not opt-out of a level: without `signing` a node's ops are taken by a `'verify'` peer
  as unsigned ops always were, and a `'require'` host refuses its hello (its id is no key). The
  configuration that resists a stripped signature is `'require'` with `signing` on every node. What the
  options ask for and no plugin provides is refused at `createDatabase()` with `PLUGIN_MISSING`:
  `sync.signatures: 'require'` without `signing`, `chain: true` without `chain`, `encrypted: true` without
  `encryption`, `schema` or `validator` without `schema`, an OpenTelemetry api or tracer without
  `telemetry`, a directory that holds tags without `versions`. A directory keeps the key it was given as
  its id when opened without `signing`; one born without it is rekeyed once, with a warning, when the
  plugin arrives.
- Without `signing` the node id is what `getId` mints (a UUID by default), ops go unsigned and unchecked;
  without `chain` no block is written and `validate()` is `NO_CHAIN`; without `sync`, `db.sync` is
  `PLUGIN_MISSING`. `db.plugins` lists the plugins a database runs with, `db.kinds` the kind plugins among
  them (what `hello` carries).

## The browser build

The `browser` export condition selects `browser.js`, and `package.json#browser` swaps these modules for
their twins; everything else is the same code on both platforms:

| Node.js | Browser | Backed by |
| --- | --- | --- |
| `src/fsi.js` | `src/fsi.browser.js` | OPFS (`navigator.storage.getDirectory()`) |
| `src/utils.js` | `src/utils.browser.js` | `crypto.randomUUID()`, the default `getId` |
| `src/crc32.js` | `src/crc32.browser.js` | a CRC-32 table in JavaScript |
| `src/crypto/digest.js` | `src/crypto/digest.browser.js` | Web Crypto SHA-256 |
| `src/signing/ed25519.js` | `src/signing/ed25519.browser.js` | Web Crypto Ed25519 (`@alexify/syncom/signing`) |
| `src/encryption/rsa.js` | `src/encryption/rsa.browser.js` | Web Crypto RSA-OAEP and AES-GCM (`@alexify/syncom/encryption`) |

In the browser `calculateHash`, `sign` and `verify` of `/signing` and `encrypt` and `decrypt` of
`/encryption` return promises; the subpaths' browser types declare them so. Keys, ciphertext and
signatures move between the platforms.

The browser build needs OPFS (or another storage: IndexedDB, the memory engine, an engine over a port) and Web
Crypto — SHA-256 for the core, Ed25519 for the `signing` plugin, RSA-OAEP and AES-GCM for `encryption` —
which current Chrome, Edge, Firefox and Safari have; both APIs need a secure context (HTTPS or `localhost`).
The repository's suite runs the browser halves under Node.js: `tests/utils/browser-env.js` loads the shared
modules the way a bundler honouring `package.json#browser` would, over a mock OPFS
(`tests/utils/mock-opfs.js`) and `node:crypto`'s `webcrypto`, and the cross-platform suites of `tests/suites/`
run over both halves.

## Sizes

`pnpm size` (`scripts/size.js`) bundles every entry on its own for the browser, minified and gzipped, and
fails when one passes its budget or when a bare import reaches a browser bundle. A block measured alone
carries the core modules it stands on, so the rows do not add up: in an app bundle those are counted once,
and the script checks it (the core and every block bundled together weigh what `/all` weighs, within
0.3 KB). The editor adapters carry the generic binding under them, and neither bundles its editor. The
numbers below were measured on 2026-11-15; `pnpm size` prints the current ones with their budgets.

| Entry | min+gzip | Entry | min+gzip |
| --- | ---: | --- | ---: |
| the core | 77.9 KB | `/all` | 180.6 KB |
| `/text` | 44.2 KB | `/tree` | 8.7 KB |
| `/sync` | 31.5 KB | `/versions` | 41.1 KB |
| `/query` | 17.9 KB | `/schema` | 7.1 KB |
| `/signing` | 6.9 KB | `/chain` | 4.0 KB |
| `/encryption` | 10.0 KB | `/telemetry` | 5.0 KB |
| `/local` | 3.0 KB | `/state` | 3.1 KB |
| `/memory` | 4.1 KB | `/layered` | 1.5 KB |
| `/idb` | 5.6 KB | `/engines` | 11.0 KB |
| `/wrpc` | 0.8 KB | `/contracts` | 1.2 KB |
| `/search` | 1.1 KB | `/order` | 1.0 KB |
| `/undo` | 9.0 KB | `/branch` | 4.9 KB |
| `/presence` | 4.7 KB | `/editor` | 4.6 KB |
| `/codemirror` | 6.4 KB | `/prosemirror` | 7.8 KB |
| `/store` | 1.2 KB | `/inspect` | 5.6 KB |
| `/dump` | 7.2 KB | `/pipeline` | 3.3 KB |
| `/cleanup` | 3.1 KB | `/connector` | 9.5 KB |
| `/connector/couchdb` | 1.6 KB | `/connector/graphql` | 0.8 KB |
| `/connector/mongodb` | 1.1 KB | `/connector/supabase` | 1.4 KB |
| `/connector/firestore` | 1.6 KB | `/connector/appwrite` | 1.4 KB |
| `/connector/gdrive` | 2.4 KB | `/connector/onedrive` | 2.0 KB |
| `/attachments` | 5.7 KB | `/shared` | 8.4 KB |
| `/testing` | 7.0 KB | `/mcp` | 2.8 KB |

`/sqlite` and `/mongodb` are Node only and carry no browser budget (5.8 KB and 9.5 KB bundled for Node).
