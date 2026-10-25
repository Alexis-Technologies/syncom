# Entry points

syncom is a core and blocks. The core — `@alexify/syncom` — keeps records
with registers, counters and sets, the op log, the three write paths, the
catalog and queries, versions and tags, and the sync of ops. Everything
beyond that is a subpath you import when you need it, and nothing is
registered process-wide: a storage runs with the plugins its `open()` was
given, and another storage in the same process may run with others.

## The blocks

| Import | What it is | Registered how |
| --- | --- | --- |
| `@alexify/syncom` | the core | — |
| `@alexify/syncom/text` | the `list` and `text` kinds: Fugue runs, marks, cursors, `splice` … `move` | `open({ plugins: [text] })` |
| `@alexify/syncom/tree` | the `tree` kind: a movable tree per field, `treeMove`, `treeRemove` | `open({ plugins: [tree] })` |
| `@alexify/syncom/signing` | the identity as an Ed25519 key, every own op signed, a peer's verified (`sync.signatures`); the key functions | `open({ plugins: [signing] })` |
| `@alexify/syncom/chain` | the hash-linked chain: a block per applied batch, the check on a cold read, `validate()`; `Blockchain` | `open({ plugins: [chain] })` |
| `@alexify/syncom/encryption` | records sealed for this node (`encrypted: true`), and `atRest()`, a backend wrapper that encrypts every file | `open({ plugins: [encryption] })`; `open({ fsi: atRest(fsi, …) })` |
| `@alexify/syncom/sync` | the sync manager: nodes, links, pushes, the feed, the bootstrap, the hosting unit; the core keeps `applyRemote()` and `outbound()` | `open({ plugins: [sync] })` |
| `@alexify/syncom/schema` | entity definitions: collections, validation, indexes, migrations and the lens, `migrate()`, `check()` | `open({ plugins: [schema], schema })` |
| `@alexify/syncom/telemetry` | the OpenTelemetry adapter: `{ api }` or `{ tracer, meter }` into the writer the engine records through; `createTelemetry()` | `open({ plugins: [telemetry], telemetry })` |
| `@alexify/syncom/query` | the cursor behind `select()`, `count()` and `watch()` on a collection; the catalog stays in the core | `open({ plugins: [query] })` |
| `@alexify/syncom/versions` | the past: `get(id, { at })`, `history()`, `diff()` between versions, `restore()`, the tags; `applyPatches()` and `compact()` stay in the core | `open({ plugins: [versions] })` |
| `@alexify/syncom/all` | the core with every shipped plugin registered — the API as one import | `require('@alexify/syncom/all').open()` |
| `@alexify/syncom/undo`, `/branch`, `/order` | the undo stack, forks and merges, fractional indexes | functions over a storage |
| `@alexify/syncom/memory`, `/layered` | `memory()`, the backend in memory; `layered([top, …, bottom])`, one backend over several as a multi-level cache | `open({ fsi })` |
| `@alexify/syncom/search`, `/idb`, `/wrpc`, `/contracts` | the text index behind `$text`, the IndexedDB backend, the wrpc link adapter, smart contracts | injected: `open({ search })`, `open({ fsi })`, `sync.connect` |

## Who imports what

A **collaborative text** (the use a document CRDT is picked for):

```js
const { open } = require('@alexify/syncom');
const { memory } = require('@alexify/syncom/memory');
const { text } = require('@alexify/syncom/text');

const storage = await open({ fsi: memory(), plugins: [text] });
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
const { open } = require('@alexify/syncom');
const { signing } = require('@alexify/syncom/signing');
const { chain } = require('@alexify/syncom/chain');
const { encryption } = require('@alexify/syncom/encryption');

const storage = await open({ path: 'data', plugins: [signing, chain, encryption] });
storage.nodeId; // the Ed25519 public key; every op signed, every write chained
```

**Everything** is `/all`:

```js
const { open } = require('@alexify/syncom/all'); // text, tree, signing, chain and encryption registered
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
  plugin provides is refused at `open()` with `PLUGIN_MISSING`:
  `sync.signatures: 'require'` without `signing`, `chain: true` without
  `chain`, `encrypted: true` without `encryption`. A directory keeps the key
  it was given as its id when opened without `signing`; one born without it
  is rekeyed once, with a warning, when the plugin arrives.

## Sizes

`pnpm size` measures every entry on its own, min+gzip, against a budget: the
core about 35 KB, `/text` 14 KB, `/tree` 5 KB, `/signing` 4 KB, `/chain`
2 KB, `/encryption` 4 KB, `/sync` 18 KB, `/schema` 4 KB, `/telemetry` 3 KB,
`/query` 5 KB, `/versions` 22 KB, `/all` 73 KB. In an app bundle the
modules the blocks share with the core are counted once, so core + `/text` is
about 53 KB, the three security blocks add about 2 KB together and `/sync`
about 7 KB — not the sum of the rows.
