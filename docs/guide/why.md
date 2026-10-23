# Why syncom?

`@alexify/syncom` replicates application data between servers, browsers and peers. Every write
lands on the device first, as an operation in a persisted log. From there it goes to every peer
the node talks to, and every replica converges on the same records without a coordinator. The
engine also covers what an application keeps next to replication:

- **Storage.** Records on `node:fs`, OPFS, IndexedDB or memory, schema-driven collections,
  live `Record`s with their own delta, compare-and-swap, counters, encryption at rest.
- **Schema and queries.** Validation with a metaschema model, any Standard Schema, ajv or a
  compiled JSON Schema, on every node a write reaches. Versions travel with every op, and old
  records read through a lens. Mango queries run over an in-memory catalog with indexes,
  unique keys and live views.
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
  alternatives in the [comparison](/guide/comparison), three others have counters that
  converge.
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
  picked by the `browser` export condition. CommonJS without a build step, hand-written typings,
  and a browser bundle of about 42 KB min+gzip that CI holds to a budget.

The [benchmarks](/guide/benchmarks) put a number on all of this. syncom opens a store and reads
a record in about 37 ms, the fastest cold start of the ten libraries measured, and serves a read
from its cache at about a million a second. A write costs more than a CRDT's, because it is
signed, logged, filed, catalogued and chained: about 16,000 a second in memory and 1,500 on
disk, where the LevelDB-backed Yjs and PouchDB do 19,000 to 26,000. And every op a replica
receives is verified against its origin, so an empty replica pulls about 25,000 records a second
in memory, where Yjs and Loro pull 100,000 — `sync.signatures: false` trades that check away.

## When something else fits better

- **Collaborative text, rich text or ordered lists.** syncom merges records field by field. An
  array is one value, and so is a string. Yjs, Automerge and Loro merge text and lists
  character by character and have editor bindings. They can live next to syncom, as a field
  that holds an encoded document.
- **Postgres is your source of truth.** ElectricSQL, PowerSync and Zero replicate a server
  database's tables to clients and send writes through your API. syncom keeps its own records
  and has no Postgres connector.
- **End-to-end encryption.** Ops are signed, but an encrypted record stays on the node that
  wrote it. End-to-end encryption is a [recipe](/guide/scaling#end-to-end-encryption)
  (wrpc's sealer in the hooks, field by field, with no counter, index or query over a sealed
  field). Jazz signs and encrypts every change, and Evolu encrypts everything it syncs.
- **Ready-made UI bindings, React Native, a managed cloud.** syncom ships none of them. RxDB,
  TinyBase, Dexie Cloud, InstantDB and others do.
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
