# Entry points

syncom is a core and blocks. The core — `@alexify/syncom` — keeps records
with registers, counters and sets (fields by path among them), the op log,
the three write paths, transactions, the catalog, the present's patches and
the changes every op reports, and the ops a peer sends or lacks
(`applyRemote()`, `outbound()`). Everything beyond that is a subpath you
import when you need it, and nothing is registered process-wide: a storage
runs with the plugins its `createDatabase()` was given, and another storage in the
same process may run with others.

## The blocks

| Import | What it is | Registered how |
| --- | --- | --- |
| `@alexify/syncom` | the core | — |
| `@alexify/syncom/text` | the `list` and `text` kinds: Fugue runs, marks, cursors, `splice` … `move` | `createDatabase({ plugins: [text] })` |
| `@alexify/syncom/tree` | the `tree` kind: a movable tree per field, `treeMove`, `treeRemove` | `createDatabase({ plugins: [tree] })` |
| `@alexify/syncom/signing` | the identity as an Ed25519 key, every own op signed, a peer's verified (`sync.signatures`); the key functions | `createDatabase({ plugins: [signing] })` |
| `@alexify/syncom/chain` | the hash-linked chain: a block per applied batch, the check on a cold read, `validate()`; `Blockchain` | `createDatabase({ plugins: [chain] })` |
| `@alexify/syncom/encryption` | records sealed for this node (`encrypted: true`), and `atRest()`, a backend wrapper that encrypts every file | `createDatabase({ plugins: [encryption] })`; `createDatabase({ fsi: atRest(fsi, …) })` |
| `@alexify/syncom/sync` | the sync manager: nodes, links, pushes, the feed, the bootstrap, the hosting unit; the core keeps `applyRemote()` and `outbound()` | `createDatabase({ plugins: [sync] })` |
| `@alexify/syncom/schema` | entity definitions: collections, validation, indexes, migrations and the lens, `migrate()`, `check()` | `createDatabase({ plugins: [schema], schema })` |
| `@alexify/syncom/telemetry` | the OpenTelemetry adapter: `{ api }` or `{ tracer, meter }` into the writer the engine records through; `createTelemetry()` | `createDatabase({ plugins: [telemetry], telemetry })` |
| `@alexify/syncom/query` | the cursor behind `select()`, `count()` and `watch()` on a collection; the catalog stays in the core | `createDatabase({ plugins: [query] })` |
| `@alexify/syncom/versions` | the past: `get(id, { at })`, `history()`, `diff()` between versions, `restore()`, the tags; `applyPatches()` and `compact()` stay in the core | `createDatabase({ plugins: [versions] })` |
| `@alexify/syncom/local` | local documents: `db.local` and `collection.local`, JSON values beside the records that never become an op | `createDatabase({ plugins: [local] })` |
| `@alexify/syncom/state` | persistent app state by name and path, over a record (replicated, a path a register) or a local document | `createState(db, name)` |
| `@alexify/syncom/dump` | a database as JSON and back: `exportJSON`/`exportPages`, `importJSON` (merge or insert), `migrateStorage` between engines | functions over a database |
| `@alexify/syncom/pipeline` | a handler over every change of a collection, once, in order, checkpointed — a derived collection | `createPipeline(db, { name, source, handler })` |
| `@alexify/syncom/cleanup` | tombstone cleanup: an old, acknowledged tombstone folded whole into the `tombstones` kv namespace | `cleanup(db, options)` |
| `@alexify/syncom/connector` | a collection kept in step with a backend of its own through `pull` and `push` handlers — the adapters beside it speak CouchDB, GraphQL, Firestore, Supabase, MongoDB, Appwrite, Google Drive, OneDrive | `replicate(db, { name, collection, pull, push })` |
| `@alexify/syncom/shared` | several instances over one database: one leads, the others follow (read-only over the same engine) and write through it over a channel; the leader gone, a follower takes its place | `openShared({ createDatabase, path, engine, channel, election })` |
| `@alexify/syncom/attachments` | bytes beside a record in the engine's blobs store, named on it as a register that replicates; fetched from a peer on demand, checked by digest | `createDatabase({ plugins: [attachments({ compression })] })` |
| `@alexify/syncom/mcp` | the tools an agent calls over a database, in the Model Context Protocol's shape: query, count, get, changes, wait_changes, insert, upsert, delete per collection, every argument checked against the tool's `inputSchema`; registering them is the caller's | `createTools(db, { collections, readOnly })` |
| `@alexify/syncom/testing` | what a test over syncom stands on: the memory engine, an in-process link with a transport's hazards (latency, a page dropped or doubled, a disconnect), a mesh of nodes from an adjacency list, `settle()`, `withDatabase()` | `createMesh(names, edges, { createStorage })` |
| `@alexify/syncom/all` | the core with every shipped plugin registered — the API as one import | `require('@alexify/syncom/all').open()` |
| `@alexify/syncom/undo`, `/branch`, `/order` | the undo stack, forks and merges, fractional indexes | functions over a storage |
| `@alexify/syncom/presence` | who is here and what they point at: a state per node, signed, relayed by a host's rooms, never logged | `createPresence(storage)`; carried by `storage.sync.presence()` |
| `@alexify/syncom/editor`, `/prosemirror`, `/codemirror` | an editor bound to a text field: the generic binding and its deltas, and adapters for ProseMirror and CodeMirror 6 (their modules injected) | functions over a storage |
| `@alexify/syncom/store` | a query, a record or a presence as one store — Svelte's contract and React's `useSyncExternalStore` | `toStore(source)` |
| `@alexify/syncom/inspect` | a record's anatomy, raw, and an anonymized copy for a bug report | functions over a storage |
| `@alexify/syncom/memory`, `/layered` | `memory()`, the backend in memory, and `memoryEngine()`, the engine in memory; `layered([top, …, bottom])`, one backend over several as a multi-level cache | `createDatabase({ fsi })`, `createDatabase({ engine })` |
| `@alexify/syncom/engines` | `serveEngine`/`remoteEngine`/`connectEngine`, an engine over a message port (a worker); `copyEngine`, a database moved between engines | functions over engines |
| `@alexify/syncom/sqlite`, `/mongodb` | `sqliteEngine()`, the engine over SQLite — `node:sqlite` or a driver; `mongoEngine()`, the engine over MongoDB — the driver's client injected; Node only | `createDatabase({ engine })` |
| `@alexify/syncom/search`, `/idb`, `/wrpc`, `/contracts` | the text index behind `$text`, IndexedDB as a backend (`createIdbFsi`) and as an engine (`idbEngine`), the wrpc link adapter, smart contracts | injected: `createDatabase({ search })`, `createDatabase({ fsi })` or `({ engine })`, `sync.connect` |

## Who imports what

A **collaborative text** (the use a document CRDT is picked for):

```js
const { createDatabase } = require('@alexify/syncom');
const { memory } = require('@alexify/syncom/memory');
const { text } = require('@alexify/syncom/text');

const storage = await createDatabase({ fsi: memory(), plugins: [text] });
const id = await storage.insert({ kind: 'doc' });
await storage.splice(id, 'body', 0, 0, 'hello');
```

A **local-first database** opens the core with `schema` and `query` — the
collections, and the cursor over them — and no text or tree fields: the
lists, texts and trees ship nothing to it. The core alone has no key: the
node id is what `getId` mints (a UUID by default), its ops go out unsigned,
no chain is written. **Signed and audited** — the level of security the
package had as one piece — is three plugins:

```js
const { createDatabase } = require('@alexify/syncom');
const { signing } = require('@alexify/syncom/signing');
const { chain } = require('@alexify/syncom/chain');
const { encryption } = require('@alexify/syncom/encryption');

const storage = await createDatabase({ path: 'data', plugins: [signing, chain, encryption] });
storage.nodeId; // the Ed25519 public key; every op signed, every write chained
```

**Everything** is `/all`:

```js
const { createDatabase } = require('@alexify/syncom/all'); // every plugin: text, tree, signing, chain, encryption, sync, schema, telemetry, query, versions
```

## What a plugin changes, and what it does not

- A method of a plugin the storage was not opened with — `splice()` without
  `text`, `treeMove()` without `tree` — rejects with a `TypeError` whose
  `code` is `PLUGIN_MISSING` and whose message names the subpath. So does a
  patch of its action in `applyPatches()`, and a reopen of a directory that
  ran with the plugin before (`node.json` names the kinds it ran with; more
  kinds than before is fine).
- The op types and their codes on the wire are the protocol's, not a
  plugin's: a node without the plugin admits, logs and relays a peer's op of
  that kind and refuses to apply it (`OP_REFUSED`, `reason: 'kind'`). A hub
  that runs the core alone carries a text between two nodes that have the
  plugin. A snapshot it serves lacks the field, which is why…
- …a node never bootstraps from a host whose `hello` named fewer kinds
  than its own (`KINDS_MISMATCH`, reported once; the feed resumes as it can).
  The rule for a mesh: every node that holds a record needs the kinds its
  peers write to it, and a hosting unit that serves snapshots should have
  every kind its peers use.
- The kinds' precedence — what wins when two nodes make one field as two
  kinds — is the registry's declared ranks: the register, the counter, the
  set, then every plugin's kinds, unique. It reads kinds alone, so it
  commutes whatever the set of plugins.
- Security is opt-in, not opt-out of a level: without `signing` a node's ops
  are taken by a `'verify'` peer as unsigned ops always were, and a
  `'require'` host refuses its hello (its id is no key). The configuration
  that resists a stripped signature is `'require'` with `signing` on every
  node — see [Signatures](./sync#signatures). What the options ask for and no
  plugin provides is refused at `createDatabase()` with `PLUGIN_MISSING`:
  `sync.signatures: 'require'` without `signing`, `chain: true` without
  `chain`, `encrypted: true` without `encryption`. A directory keeps the key
  it was given as its id when opened without `signing`; one born without it
  is rekeyed once, with a warning, when the plugin arrives.

## Sizes

`pnpm size` measures every entry on its own, min+gzip, against a budget:

| Entry | min+gzip | Entry | min+gzip |
| --- | ---: | --- | ---: |
| the core | 75.4 KB | `/all` | 162.4 KB |
| `/text` | 44.0 KB | `/tree` | 8.6 KB |
| `/sync` | 16.9 KB | `/versions` | 40.6 KB |
| `/signing` | 6.6 KB | `/chain` | 3.8 KB |
| `/encryption` | 6.4 KB | `/schema` | 7.0 KB |
| `/query` | 17.3 KB | `/telemetry` | 4.1 KB |
| `/undo` | 8.8 KB | `/branch` | 4.7 KB |
| `/presence` | 4.5 KB | `/inspect` | 5.4 KB |
| `/editor` | 4.6 KB | `/store` | 1.2 KB |
| `/prosemirror` | 7.8 KB | `/codemirror` | 6.4 KB |
| `/memory` | 3.3 KB | `/layered` | 1.5 KB |
| `/local` | 2.8 KB | `/state` | 2.9 KB |
| `/dump` | 6.6 KB | `/pipeline` | 3.1 KB |
| `/connector` | 7.0 KB | `/connector/couchdb` | 1.4 KB |
| `/connector/graphql` | 0.8 KB | `/connector/mongodb` | 0.9 KB |
| `/connector/supabase` | 1.2 KB | `/connector/firestore` | 1.3 KB |
| `/connector/appwrite` | 1.4 KB | `/connector/gdrive` | 2.1 KB |
| `/connector/onedrive` | 1.9 KB | `/shared` | 5.5 KB |
| `/attachments` | 4.1 KB | `/testing` | 6.5 KB |
| `/mcp` | 2.2 KB | | |
| `/cleanup` | 3.0 KB | `/engines` | 9.9 KB |
| `/idb` | 4.9 KB | `/search` | 1.1 KB |
| `/order` | 1.0 KB | `/contracts` | 1.0 KB |
| `/wrpc` | 0.7 KB | | |

A block measured alone carries the core modules it stands on, so the rows do
not add up: in an app bundle those are counted once, and the script checks
it — the core and every block bundled together weigh what `/all` weighs,
within a rounding. The editor adapters carry the generic binding under them
(`/editor`, 4.6 KB), and neither bundles its editor.
