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
| `@alexify/syncom/all` | the core with every shipped plugin registered — the API as one import | `require('@alexify/syncom/all').open()` |
| `@alexify/syncom/undo`, `/branch`, `/order` | the undo stack, forks and merges, fractional indexes | functions over a storage |
| `@alexify/syncom/search`, `/idb`, `/wrpc`, `/contracts` | the text index behind `$text`, the IndexedDB backend, the wrpc link adapter, smart contracts | injected: `open({ search })`, `open({ fsi })`, `sync.connect` |

## Who imports what

A **collaborative text** (the use a document CRDT is picked for):

```js
const { open, createMemoryFsi } = require('@alexify/syncom');
const { text } = require('@alexify/syncom/text');

const storage = await open({ fsi: createMemoryFsi(), plugins: [text] });
const id = await storage.insert({ kind: 'doc' });
await storage.splice(id, 'body', 0, 0, 'hello');
```

A **local-first database** with no text or tree fields opens the core alone;
the lists, texts and trees ship nothing to it. **Everything** is `/all`:

```js
const { open } = require('@alexify/syncom/all'); // text and tree registered
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

## Sizes

`pnpm size` measures every entry on its own, min+gzip, against a budget: the
core about 54 KB, `/text` 14 KB, `/tree` 5 KB, `/all` 68 KB. In an app
bundle the modules the blocks share with the core are counted once, so
core + `/text` is about 62 KB, not the sum of the rows.
