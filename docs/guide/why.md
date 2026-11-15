---
title: Why syncom?
description: What syncom is for, what sets it apart from other local-first databases and CRDT libraries, how fast it is, and when another tool fits better.
---

# Why syncom?

syncom keeps your application's data on the device and replicates it between servers, browsers and
peers. Every write lands locally first, as an operation in a log kept on disk. From there it travels to
every node the device talks to, and every copy ends up with the same records without a central server
deciding who wins. Your app reads and writes local data at local speed, keeps working offline, and catches
up when the network comes back.

It is a database as much as a sync engine. One package gives you storage on disk, OPFS, IndexedDB,
SQLite, MongoDB or memory; collections with schemas, indexes and live queries; the past of every record;
and an integrity chain you can verify. It has no runtime dependencies.

## What you get in one package

**Storage.** Records live in the [storage](./storage) you choose, in [collections](./collection) defined by a
schema or in no collection at all. A [document](./document) is a live object you assign to and save. Writes
can be [transactions](./transactions-conflicts) or compare-and-swap, records can be [encrypted](./encryption),
and a field can be a counter, a set, a list, a text or a tree as well as a plain value
([Fields that merge](./fields)).

**Schema and queries.** A [schema](./schema) validates every write with a metaschema model, any Standard
Schema (zod, valibot, arktype), ajv or a compiled JSON Schema, on every node the write reaches. The schema
version travels with every operation, and older records read through a [lens](./migration-schema). Mango
[queries](./query) run over an in-memory catalog with indexes, unique keys and live results.

**The past.** A record reads back at any version the log still holds; [tags](./versions) name the whole
database at a moment; diff, restore, an [undo stack](./undo) and [branches](./branches) that merge back all
build on that.

**Integrity and operations.** A [hash-linked chain](./chain) is checked again when a record is read.
[`purge()`](./purge) removes a payload from the log, and `repair(id)` rebuilds a record from it.
[Hooks](./hooks) run inside a write, events report everything, [OpenTelemetry](./telemetry) is injected,
and every operational failure is an [error with a code](./errors).

## What sets it apart

### Replication without a coordinator

Every node can dial other nodes and host them. The same database works as a hub on a server, as a
browser tab that dials it, and as a peer that browsers reach over WebRTC; hubs can dial each other. A node
resumes from the last operation it saw, and a newcomer, or a node away longer than the host keeps its log,
starts from a streamed snapshot. There is no service to run, and the transport is something you hand in:
[wrpc](./replication-websocket) over WebSocket or [WebRTC](./replication-webrtc) out of the box. The
[sync engine](./replication) page shows how it works.

### Records that merge field by field

A plain field keeps the last value written, decided per field by a clock that never runs behind what the
node has seen. Counters add up across nodes, sets keep every concurrent add, and a deleted record comes
back when someone writes to it later. So two devices that edit different fields of one task both keep
their change, two that vote on it both count, and two that tag it keep both tags. Of the eighteen
alternatives in the [comparison](./comparison), four others have counters that converge.

### Lists, text and trees in the same records, with their past

A [list](./lists) or a [text](./text) field merges by position (the Fugue algorithm), so two people typing
at one spot both keep what they typed, each run whole. Texts carry marks for rich text, cursors that
survive edits, and elements that move; a [tree](./trees) field moves nodes and never forms a cycle. Every
way back to an earlier version is new operations that merge like any write. Of the eighteen alternatives,
Loro is the only other one with both a movable list and a movable tree.

### The host decides what it accepts

A hub checks a peer's operation before applying it: its shape and clock, the peer's
[scopes](./partial-sync), the collection's validator and your `beforeApply` hook. An operation that fails
is skipped there, and still relayed, so the nodes behind the hub judge it for themselves. A unique-key
clash is reported, and each peer is served only the scopes it was granted. Of the eight alternatives that
sync without a server of their own, only RxDB also validates writes against a schema.

### A history you can verify and still purge

With the [signing](./signing) plugin every operation is signed by the node that made it, and the node id
is its Ed25519 public key, so any peer verifies an operation that reached it through any relay. Every write
can also go into a hash-linked chain that is checked when a record is read, so silent corruption surfaces
as an error, not as data. `purge()` removes a payload from the log, replicates the purge itself, and leaves
a header that still verifies. Among the tamper-evident stores in the comparison, Automerge, Fireproof and
OrbitDB keep every payload forever.

### An engine you can operate

Hooks run your code inside a write, a read or a peer's batch, and can reject the operation with a typed
error. Events report everything and can never break a write. OpenTelemetry spans and metrics come from the
tracer and meter you inject, nested under wrpc's spans, and `stats()` reports where every peer stands.

### No dependencies, one API for Node.js and the browser

Nothing is installed with it. It uses `node:fs` and `node:crypto` on the server, and OPFS (or IndexedDB)
and Web Crypto in the browser, picked by the bundler with no configuration. The code is CommonJS without a
build step, the hand-written types type your records from their schema, and every block is a subpath of its
own: the core is about 78 KB minified and gzipped, everything together about 181 KB, each held to a budget
in CI ([Installation](./install)).

## How fast it is

The [benchmarks](./benchmarks) put numbers on this, all measured by scripts in the repository. syncom opens
a store and reads a record in about 57 ms, the fastest cold start of the libraries measured, and serves a
read from its cache 850,000 to 890,000 times a second. A write is logged, filed and catalogued: about
43,000 a second in memory as a pure CRDT, about 15,000 signed and chained (`/all`), and about 5,400 new
records a second on disk, where the LevelDB-backed Yjs and PouchDB do 18,000 to 23,000. A change to a
record that is already there runs at about 22,000 a second on disk.

An empty replica pulls about 73,000 records a second in memory, behind Yjs and Loro (about 100,000);
checking every operation's signature on the way in brings that to 22,000. Typing into a text with every
keystroke awaited runs at 38,000 to 74,000 keystrokes a second in memory, ahead of Automerge. Through an
editor's handle it types 322,000 a second at the end of a text in memory and 262,000 on disk, the fastest
durable keystroke measured, and the automerge-perf editing trace replays at 158,000 keystrokes a second,
three times Yjs.

## When something else fits better

**Very long documents typed into by many at once.** syncom's text fields merge by position with marks,
embeds, blocks and cursors, and bind to ProseMirror and CodeMirror ([Editors](./editors)). Yjs still types
five to ten times faster at either end of a text when each keystroke is awaited (syncom is ahead in the
middle), Loro eight to nine times faster anywhere, and Loro replays the editing trace three times faster.
Both also ship bindings for Monaco, Quill, Lexical and Tiptap.

**Postgres is your source of truth.** ElectricSQL, PowerSync and Zero replicate a server database's
tables to clients and send writes through your API. syncom keeps its own records and has no Postgres
connector.

**End-to-end encryption.** Operations are signed, but an encrypted record stays on the node that wrote it.
End-to-end encryption is a recipe you build in the hooks, field by field, with no counter, index or query
over a sealed field ([Encryption](./encryption)). Evolu encrypts everything it syncs.

**React Native or a managed cloud.** syncom ships neither; RxDB, TinyBase, Dexie Cloud, InstantDB and
others do. It does have UI bindings: [`/store`](./frameworks) for React, Svelte, Vue and Solid.

**A package with a track record.** syncom is a pre-release (`0.0.1`), not on npm yet, and its API may still
change before the first release. The [sync engine](./replication) page lists its known limits: a counter
straddling a concurrent reset, encrypted records that stay local, no proof of key possession at `hello`.

## Where it comes from

syncom is built alongside [wrpc](https://wrpc.vercel.app), the transport it plugs into, and
[metaschema](https://metaschema.vercel.app), whose models it validates with. The three follow the same
rules: collaborators are injected rather than required (the transport, the storage, the validator, the
telemetry), there are no runtime dependencies, the code is CommonJS without a build step, and every number
in the docs comes from a script in the repository. The [architecture](./architecture) page shows how the
pieces fit, and [Compared with RxDB](./vs-rxdb) and [Compared with CRDT libraries](./vs-crdt) go row by
row.
