# Why syncom?

`@alexify/syncom` replicates application data between servers, browsers and peers. Every write
lands on the device first, as an operation in a persisted log. From there it goes to every peer
the node talks to, and every replica converges on the same records without a coordinator. The
engine also covers what an application keeps next to replication:

- **Storage.** Records on `node:fs`, OPFS, IndexedDB or memory, schema-driven collections,
  live `Record`s with their own delta, compare-and-swap, encryption at rest, and fields that
  are counters, sets, lists, texts or trees as well as plain values.
- **Schema and queries.** Validation with a metaschema model, any Standard Schema, ajv or a
  compiled JSON Schema, on every node a write reaches. Versions travel with every op, and old
  records read through a lens. Mango queries run over an in-memory catalog with indexes,
  unique keys and live views.
- **Versions.** A record read back at any version the log retains, tags of the whole storage,
  diff and restore, an undo stack and branches that merge back.
- **Integrity and operations.** A hash-linked chain, re-checked on read; `purge()`, which
  removes a payload from the log; `repair(id)`, which rebuilds a record from the log; hooks
  that run inside a write; events; injected OpenTelemetry; and a `SyncomError` with a code
  for every operational failure.

## What sets it apart

- **Replication without a coordinator, in any shape.** Every node can dial and host, so the
  same storage works as a hub on a server, as a browser tab that dials it, and as a peer
  that browsers reach over WebRTC. Hubs can dial each other. A node resumes from the last event
  id it saw, and a newcomer, or a node away longer than the host's retention, bootstraps from
  a streamed snapshot. There is no service to run, and the transport is an injected link:
  [wrpc](/guide/wrpc) over WebSocket or [WebRTC](/guide/webrtc) out of the box.
- **Records that merge field by field.** A write is a last-writer-wins register per field,
  stamped by a clock that never runs behind what the node has seen. Counters add up across
  nodes, sets keep every concurrent add, and tombstones revive. Two replicas that edit different
  fields of one record both keep their change, two that increment one counter both count, and
  two that tag one record keep both tags. Of the eighteen
  alternatives in the [comparison](/guide/comparison), four others have counters that
  converge.
- **Lists, text and trees in the same records, with their past.** A list or a text field
  merges by position — Fugue, so two nodes typing at one spot both keep theirs, each writer's
  run whole — with marks for rich text, cursors that survive edits and elements that move; a
  tree field moves nodes and never forms a cycle. Every record's past reads back from the log,
  by event id, stamp or version vector; tags, diff and restore, an undo stack and branches build
  on it, and every way back is new ops that merge like any write. Of the eighteen alternatives,
  Loro is the only other one with both a movable list and a movable tree. See
  [Lists, text and trees](/guide/lists) and [Versions and history](/guide/versions).
- **The host decides what it accepts.** A hub checks a peer's op before applying it: the op's
  shape and clock skew, the peer's scopes, the entity's validator and `beforeApply`. A failing op
  is skipped there (and still relayed, so the nodes behind the hub judge it for themselves), a
  unique-key clash is reported, and each peer is served only the scopes it was granted. Of the eight alternatives that sync without a server of their own, only RxDB
  validates writes against a schema.
- **A history you can verify and still purge.** Every op is signed by the node that made it —
  the node id is its Ed25519 key, so any peer verifies an op through any relay — and every
  write can be committed to a hash-linked chain that is re-checked when a record is read, so
  silent corruption surfaces as an error, not as data. `purge()` removes a payload from the op
  log, replicates the purge itself, and leaves a header that still verifies.
  Among the tamper-evident stores in the comparison, Automerge, Fireproof and OrbitDB keep
  every payload forever.
- **An engine you can operate.** Hooks run your code inside a write, a read or a peer's batch,
  and can reject the operation with a typed error. Events report everything and can never
  break a write. OpenTelemetry spans and metrics come from the tracer and meter you inject,
  nested under wrpc's spans. `stats()` and `peers()` report where every peer stands.
- **Zero dependencies, one API for Node.js and the browser.** Nothing is installed with it.
  `node:fs` and `node:crypto` on the server, OPFS (or IndexedDB) and Web Crypto in the browser,
  picked by the `browser` export condition. CommonJS without a build step, hand-written typings
  that type the records from their schema, and a core of about 51 KB min+gzip, every block a
  subpath of its own (everything together, `/all`, about 113 KB), each held to a budget in CI.

The [benchmarks](/guide/benchmarks) put a number on all of this. syncom opens a store and reads
a record in about 52 ms, the fastest cold start of the ten libraries measured, and serves a read
from its cache at about 890,000 a second. A write is logged, filed and catalogued: about 46,000 a
second in memory as a pure CRDT, 15,000 signed and chained (`/all`), and about 5,900 new records
a second on disk, where the LevelDB-backed Yjs and PouchDB do 18,000 to 27,000 — a change to a
record that is there, 18,000 to 21,000. An empty replica pulls about 82,000
records a second in memory, behind Yjs and Loro (98,000 to 107,000); checking every op's signature
on the way in brings that to 22,000. Typing into a text runs at 23,000 to 49,000 keystrokes a
second in memory, ahead of Automerge.

## When something else fits better

- **Very long documents typed into by many at once.** syncom's [list and text fields](/guide/lists)
  merge by position — Fugue, with marks, embeds, block markers and cursors — and bind to
  ProseMirror and CodeMirror ([Editors](/guide/editors)), typing a little faster than Automerge.
  Yjs types seven to twenty times faster at either end of a text and about as fast in the middle,
  Loro thirteen to twenty times faster anywhere; Loro replays the automerge-perf editing trace in half a second, Yjs in 5
  seconds, syncom in about 6 ([benchmarks](/guide/benchmarks)); they also ship bindings for
  Monaco, Quill, Lexical and Tiptap.
- **Postgres is your source of truth.** ElectricSQL, PowerSync and Zero replicate a server
  database's tables to clients and send writes through your API. syncom keeps its own records
  and has no Postgres connector.
- **End-to-end encryption.** Ops are signed, but an encrypted record stays on the node that
  wrote it. End-to-end encryption is a [recipe](/guide/scaling#end-to-end-encryption)
  (wrpc's sealer in the hooks, field by field, with no counter, index or query over a sealed
  field). Evolu encrypts everything it syncs; Jazz 2.0 ships encryption as adapters, not yet
  wired into its tables.
- **React Native, a managed cloud.** syncom ships neither. RxDB, TinyBase, Dexie Cloud,
  InstantDB and others do. (UI bindings it has: [`/store`](/guide/frameworks) for React, Svelte,
  Vue and Solid.)
- **A package with a track record.** syncom is a pre-release (0.0.1), not on npm yet, and its
  API may still change before the first release. The
  [Sync](/guide/sync#guarantees-and-limits) guide lists the known limits: a counter straddling a concurrent reset,
  encrypted records that stay local, no proof of key possession at `hello`.

## Where it comes from

syncom is built alongside [wrpc](https://wrpc.vercel.app), the transport it plugs into, and
[metaschema](https://metaschema.vercel.app), whose models it validates with. The three follow
the same rules: collaborators are injected, not required (the transport, the backend, the
validator, the telemetry), there are no runtime dependencies, the code is CommonJS without a
build step, and every number in the docs comes from a script in the repository. The
[architecture](/guide/architecture) page shows how the pieces fit, and the
[benchmarks](/guide/benchmarks) page shows how fast they are next to the alternatives.
