---
title: Sync engine
description: How syncom keeps nodes in sync, offline included. Every write is an op in a log, nodes host or dial, and fields merge without a conflict handler.
---

# Sync engine

Take the task board from the [Quickstart](./quickstart) to a small team. The board lives on a `server`,
Ada works on her `laptop`, and Bob checks tasks off on his `phone`. On the train Bob's phone has no
signal, so he closes a task there. At the same moment Ada renames that task on her laptop. When the
phone is back online, both devices should show the renamed task, closed, without anyone being asked
which version to keep and without either edit getting lost.

That is what the sync engine does. Each node keeps a complete database of its own, reads and writes it
offline, and exchanges with the others only what they are missing. This page shows how that works from
the outside: what a node sends, when it sends it, and what you can wait for and listen to.

<LiveReplication />

## What happens when you write

Every write you make, `insert()`, `update()`, `inc()` or any other, becomes an **op**: a small record of
what changed (the record, the field, the new value or the amount), labeled with the node that made it, its
sequence number on that node and a timestamp. The node appends the op to its
[operation log](./operation-log) and then updates the record. Ops that arrive from other nodes go through
the same log, so the log is the node's history of everything it applied, in order.

<FigWritePath />

Replication is the exchange of ops, not of whole records. A node knows how far it has read every other
node's stream of ops (a version vector), so two nodes that meet compare their vectors and send only the
ops the other lacks. An op that arrives twice is recognized and dropped, so delivering one again is
always safe.

## How nodes connect: host and dial

A node connects to another in one of two roles. A node that **hosts** mounts its sync unit,
`db.sync.unit()`, on a server, and other nodes connect to it. A node that **dials** registers a host with
`db.sync.addNode()` and opens links to it through the `connect` function you give it. Both roles are the
same database class: a node can host, dial, or do both, which is how a desktop app can dial the cloud and
serve the phones on the office network at the same time ([syncom server replication](./replication-server)
shows it).

When a dialer reaches a host, three things happen. It says **hello**, and the two exchange their node ids
and vectors. It **pushes** the ops the host lacks. It **subscribes** to the host's feed, which sends
every op that lands on the host from the dialer's last position onward, including ops from other nodes.
After that the link stays live: each new op on the dialer is pushed, and each op that lands on the host
comes down the feed. That is how Ada's write reaches Bob's phone: laptop to server by push, server to
phone by feed.

<FigHandshake />

The details of the protocol (the procedures, their arguments, the codes a host answers with) are in
[The sync protocol](./sync-protocol) and the byte-level [wire format](../reference/wire).

## Set up the nodes

The examples on this page run all three nodes in one process. `MemoryLink` from
`@alexify/syncom/testing` stands in for the network: it behaves like a wrpc connection, including
dropping and coming back. In an app, `connect` opens a WebSocket instead
([WebSocket](./replication-websocket) shows the two lines).

<<< @/examples/replication.mjs#nodes

The server opens a database and mounts its unit. The laptop and the phone open theirs with a `connect`
function and register the server with `addNode()`. A node with `connect` starts dialing as soon as it
opens, and the registry is saved in its storage, so on the next start it dials the same nodes again
without another `addNode()`. The `url` is whatever your `connect` understands; syncom never parses it.

`awaitInitialReplication()` resolves once every registered node has been reached and its feed read to
the end once. Use it before the first read on a new device, but do not make the app wait for it before
it can be used: it resolves only once the host has answered, and the database works offline anyway. A
node whose dial failed is not waited for.

## Write on one node, read on another

<<< @/examples/replication.mjs#write

The phone did nothing to receive the task. The laptop pushed the op to the server, the server's feed
carried it to the phone, and the phone's live query ran again, the same way it does for a local write.
`awaitDocumentPushed(id)` resolves once every node the laptop pushes to holds the laptop's newest write of
that record, which is how you show "saved to the server" in a UI.

## Go offline and come back

<<< @/examples/replication.mjs#offline

While the phone was disconnected, its writes went into its own log as usual. When the link came back,
the phone said hello again, pushed the two ops the server lacked, and its feed resumed from the last
position it had read, so nothing the server had was sent twice. Both nodes then merged the edits field
by field: the title from the laptop, `done` from the phone, and both votes, because `votes` is a counter.

<FigResume />

Reconnecting is the transport's job. A wrpc client retries with backoff and reopens the subscription from
its last position by itself; syncom repeats only the hello and the push. If `connect()` itself rejects,
for example because the host could not be reached when the app started, the node stays registered and
the next `db.sync.sync()` dials it again, so call it when the device comes back online.

A node that dials also keeps its own ops in its log until every registered node holds them, even past the
log's normal retention. A laptop that works offline for a month still delivers every write when it
reconnects. Register the host before going offline: ops written before the first `addNode()` are
retained like any other ops.

## Edit the same field on two nodes

Different fields never conflict, as the previous example showed. When two nodes write the same plain
field without seeing each other's write, one value has to win, and every node must pick the same one:

<<< @/examples/replication.mjs#same-field

A plain field (a register) keeps the write with the later timestamp, and when two timestamps are equal,
the node id decides. Every node applies that rule to the same ops, so all of them agree whatever order the
ops arrive in. There is no conflict handler to write. Fields that should not lose writes merge instead:
counters add up, sets keep concurrent additions, and lists and text keep both insertions.
[Fields that merge](./fields) covers each kind, and [Transactions and conflicts](./transactions-conflicts)
shows how to notice when a write lost.

## Add a node later, or come back after a long time

A new node reads the host's log from the start, as long as the host still holds all of it. A host keeps
about the last 10 000 ops by default (`sync.retention`), and once it has dropped older ones, a new node, or one
that was away longer than that, cannot be caught up from the log. The host sends a **snapshot** instead:
every record in the node's [scopes](./partial-sync), page by page. Here the server keeps a tiny log so the
example shows it:

<<< @/examples/replication-bootstrap.mjs#retention

<<< @/examples/replication-bootstrap.mjs#long-gone

<<< @/examples/replication-bootstrap.mjs#newcomer

The phone pushed its offline write first, then joined the snapshot and continued from the position the
snapshot was taken at. Whatever landed on the host while the pages were read comes down the feed after,
and merges in as a no-op where the snapshot already had it. The joined records also enter the node's own
log, so a third node that later dials the phone gets them from there.

<FigBootstrap />

Size the host's retention for the longest outage a device should be able to sit out without a snapshot,
and see [Retention and acknowledgements](./retention) for what else keeps ops in a log.

## Wait until the nodes are in sync

Three promises tell you how far replication has come. Each resolves at once if its condition already
holds, and each takes a `{ signal }` to give up waiting.

| Method | Resolves once |
| --- | --- |
| `awaitInitialReplication()` | every enabled node has been reached and its feed read to the end at least once since it was dialed |
| `awaitInSync()` | every enabled node is connected, nothing is left to push to it, and its feed is read to the end, right now |
| `awaitDocumentPushed(id)` | every node this node pushes to holds this node's newest write of the record |

"In sync" means in sync with the hosts this node dials, at that moment. A write that another node has
not pushed to the server yet is not part of it, and a node that is disabled, or whose dial failed, is not
waited for.

## Watch replication

<<< @/examples/replication.mjs#events

`peer` fires when a link comes up, drops or comes back. `sync` fires after every push (`pushed`) and every
page received (`received`, `applied` and the counts of what was skipped). `bootstrap` fires when a
snapshot was joined. `error` carries the failures on the way to a peer, each with `url`: a host that
refused the hello (a numeric code such as `403`), a page that could not be applied (`PAGE_FAILED`, retried
from the saved position, `STUCK` after the third failure in a row), or a scope taken back (`REVOKED`). A
listener that throws is logged and never breaks replication. To take part instead of watching, for
example to refuse a peer's op, use [hooks](./hooks). The full payloads are in the
[reference](../reference/api#syncmanager).

`peers()` is the live view of every dialed node: whether it is `connected` and `subscribed`, how many ops
are `pending`, whether it is `behind` after a failed push, `caughtUp` with its feed, and its `lastError`.

## Pause, resume and remove a node

<<< @/examples/replication.mjs#control

`enableNode(url, false)` hangs up but keeps the node, its saved position and what it has acknowledged;
`enableNode(url, true)` dials it again and resumes where it stopped. `removeNode(url)` hangs up and
forgets the node, and adding the same url twice rejects with `NODE_EXISTS`. `stop()` closes every link
and `start()` dials every enabled node again; a database with `connect` starts on open unless you pass
`sync: { autoStart: false }`. `sync()` pushes what the peers lack right now and dials a node whose dial
failed. On the hosting side, `revoke(node, scopes)` takes scopes back from a node that dials you, which
[Partial sync](./partial-sync#take-access-back) shows.

## Native sync or a connector?

Everything above is syncom talking to syncom: ops travel, fields merge, writes from any node flow to every
other, and the host can be any node you run. Choose it when you control both ends.

When the data must live in someone else's backend, such as a REST API, GraphQL, CouchDB, Firestore,
Supabase or a MongoDB collection your other services use, use a [connector](./connectors) instead. A
connector keeps one collection in step with that backend through a pull handler and a push handler: what
it pulls lands as ordinary writes, your writes are pushed as rows, and on a conflict the backend wins
unless you resolve it. You give up field-level merging, scopes and presence there, because the backend
stores documents, not ops. Both can run in one database: native sync between your own nodes and a
connector to the system of record.

## Trade-offs

- **Every node holds its whole share.** A node stores every record of its scopes, not a cache of recent
  ones. Use [partial sync](./partial-sync) to keep that share small.
- **Last writer wins on plain fields.** Concurrent writes of one plain field keep one value, chosen by
  timestamp. Clock skew changes which write wins, never whether the nodes agree; keep clocks synced if
  "later" should mean what a person expects, and use counters, sets or text where every write must count.
- **A nested object is one field.** Two nodes that change different keys of one nested object keep only
  one of the objects. Write the keys as separate fields, or as [paths](./fields).
- **The other end must be syncom.** Native sync needs a syncom node to host. For another backend, use a
  connector.
- **The transport is not included.** syncom ships no network code. It runs over
  [wrpc](./replication-websocket), which you install next to it, or any link you write against the
  [link contract](./sync-protocol).

## Coming from RxDB

RxDB replicates documents: a pull handler fetches documents changed since a checkpoint, a push handler
sends each changed document with the state the client assumed the server held, and a conflict handler on
the client decides when the two disagree. syncom replicates ops instead, so there is no checkpoint
document layout to design on the server, no `_deleted` field, and no conflict handler: the merge rules
are built into each field's kind. The waiting methods keep RxDB's names. If your backend is not syncom,
RxDB's model is what syncom's [connectors](./connectors) follow.

<FromRxdb page="replication" :rows="['replModel', 'wire', 'offline', 'bootstrap', 'conflictResolve', 'awaitSync']" />
