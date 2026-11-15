---
title: Glossary
description: The words the syncom docs use for nodes, ops, streams, vectors, scopes, hosts and hubs, field kinds, engines and backends, each with the page that teaches it.
---

# Glossary

The terms below are used the same way on every page. Each links to the page that explains it.

### Actor

Who made an op, as the writer claims: a string from `createDatabase({ actor })` or a write's own
`{ actor }`. It is signed with the op and kept in the log, never in the record. See [The operation
log](./operation-log#what-an-op-is).

### Backend (fsi)

The five file functions (`read`, `write`, `exists`, `remove`, `list`, with optional `append`, `create`
and `sync`) that the files engine stores through: `node:fs` in Node.js, OPFS in the browser, or one
you write. See [Storage overview](./storage).

### Bootstrap

Joining another node's state from a snapshot instead of replaying its log, when the log can no longer
resume this node's cursor. The joined records become `merge` ops in this node's own log. See [The sync
protocol](./sync-protocol#join-from-a-snapshot).

### Collection

The records of one kind (one entity of the schema), reached as `db.Task`, with its own queries,
indexes and validator. See [Collection](./collection).

### Counter

A field whose value is a sum, born with `inc()`. Increments made on several nodes at once all count.
See [Fields that merge](./fields).

### Cursor

The event id a dialer saved for a host: where its feed resumes after a reconnect or a restart. See
[The sync protocol](./sync-protocol#follow-the-host-s-feed).

### Database

What `createDatabase()` opens: the records, the operation log, the catalog and the plugins of one node.
See [Database](./database).

### Dialer

The node that opens a connection to another node and says hello. The same node can dial some peers and
host others. See [The sync protocol](./sync-protocol).

### Document

The live object a collection hands out for one record, which refreshes as the record changes. See
[Document](./document).

### Engine

The medium a database keeps every byte in: files (over a backend), memory, IndexedDB, SQLite or MongoDB.
See [Storage overview](./storage).

### Epoch

A random name minted when a log is created. It prefixes every event id of that log, so a position from
a wiped or restored directory is recognized as foreign. See [The operation
log](./operation-log#what-a-node-has-seen-version-vectors).

### Equivocation

A writer that made two different ops at one position of its stream. The [hash
chain](#hash-chain) detects it and every node refuses the second branch. See [The operation
log](./operation-log#who-wrote-it-and-nothing-else-the-hash-chain).

### Event id

A position in one node's log, written `<epoch>.<seq>`. A subscriber hands it back to resume a feed.
See [The operation log](./operation-log#what-a-node-has-seen-version-vectors).

### Floor

The lowest position a log still holds. A cursor below the floor cannot be resumed and its node
bootstraps. See [Retention and acknowledgements](./retention).

### Follower

A read-only database over an engine another instance writes, such as a MongoDB a writer holds. It reads
what the writer lands and can host over a shared log. See [Scaling](./server-scaling#add-read-only-hubs-over-one-database).

### Hash chain

Every op names the fingerprint (SHA-256 of its header) of the op before it in its stream, so each
stream is a chain that shows a fork. See [The operation
log](./operation-log#who-wrote-it-and-nothing-else-the-hash-chain).

### Host

The node that serves the sync unit on a connection: it answers hello, takes pushes, and serves its feed
and snapshots. See [Hosting a node](./server).

### Hub

A host that many clients dial, usually a server. A hub is an ordinary node; several hubs can dial each
other or share a log. See [Scaling](./server-scaling).

### Kind

What a field is: a register, a counter, a set, a list, a text or a tree. The call that first writes a
field decides its kind. See [Fields that merge](./fields).

### Link

What carries the protocol between two nodes: an object with `call`, `subscribe`, `on`, `off` and `close`.
The wrpc adapter makes one from a wrpc client. See [WebSocket](./replication-websocket).

### List

A field holding an array that nodes edit by position, where concurrent inserts at one place are all
kept in order. Part of the `text` plugin. See [Lists](./lists).

### Node

One database that takes part in sync, named by its node id. With the signing plugin the node id is its
Ed25519 public key. See [Sync engine](./replication).

### Op

The record of one write: which node made it, its number, its stamp, and the change. Ops are what the
log keeps and what nodes exchange. See [The operation log](./operation-log).

### Origin

The node that made an op, by its node id. See [The operation log](./operation-log#what-an-op-is).

### Plugin

A module a database opens with: a field kind (`text`, `tree`) or a feature (`sync`, `signing`, `query`,
`schema` and more). `@alexify/syncom/all` registers every one the package ships. See
[Plugins](./plugins).

### Purge

Erasing a record for good: it wins over every other write, and its content is scrubbed from the log
while the ops' headers keep the chain whole. See [Purge](./purge).

### Register

A plain field: the last write wins, by stamp and then node id. Every field written with `insert()` or
`update()` is a register. See [Fields that merge](./fields).

### Retention

How many ops, or how many days of them, a log keeps before it drops old segments. See [Retention and
acknowledgements](./retention).

### Scope

A label a function of yours gives each record (a tenant, a team). A peer is granted scopes, and a host
sends and takes only the records of those scopes. See [Partial sync](./partial-sync).

### Set

A field holding unordered elements, born with `add()`. Concurrent adds are all kept, and a remove takes
only the adds it saw. See [Fields that merge](./fields).

### Shared log

A broker's log (or `mongoSharedLog()`) that several hubs append to and serve their feeds from, so a
client's cursor is valid on every hub. See [Scaling](./server-scaling#serve-every-hub-from-one-log).

### Snapshot

A host's records, paged in id order with the metadata that makes them merge, served to a node that
bootstraps. See [The sync protocol](./sync-protocol#join-from-a-snapshot).

### Stamp

An op's time, `ts`: milliseconds from a clock that never runs backwards and never falls behind a stamp
the node has seen. Stamps, then node ids, order concurrent writes. See [The operation
log](./operation-log#when-it-happened-stamps).

### Stream

The numbered ops of one origin in one scope (`origin` or `origin@scope`), applied in order without
holes. See [The operation log](./operation-log#one-stream-per-origin-and-scope).

### Text

A field holding a string that nodes edit by position, with marks for rich text. Part of the `text`
plugin. See [Text and rich text](./text).

### Tombstone

What a deleted record leaves behind, so the deletion reaches every node and an older write cannot bring
it back. See [Cleanup](./cleanup).

### Tree

A field holding nodes with a parent and a place among their siblings, moved with `treeMove()`;
concurrent moves never make a cycle. Part of the `tree` plugin. See [Trees](./trees).

### Unit

The set of procedures a host mounts on a wrpc router (`db.sync.unit()`): hello, push, the changes feed,
snapshots and the optional reads. See [Hosting a node](./server).

### Version vector

The highest seq a node has applied from each stream. Sending it tells the other side exactly which ops
to send back. See [The operation log](./operation-log#what-a-node-has-seen-version-vectors).
