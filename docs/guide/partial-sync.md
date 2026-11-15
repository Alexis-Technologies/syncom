---
title: Partial sync
description: Give each node only the records it may see with scopes, let the host decide what a node may claim, sync one way, and take access back with revoke.
---

# Partial sync

The task board now serves a whole company. The design team should not carry the mobile team's tasks on
their laptops, a reporting job should read every board but write nothing back, and when Ada leaves the
design team her laptop should stop receiving design tasks and drop the ones it already has. A server that
sends every record to every node cannot do any of that.

syncom solves it with **scopes**. Every record belongs to one scope, a node asks for the scopes it wants
when it registers a host, and the host decides whether the node may have them. From then on the node
receives only those scopes and may write only records in them.

<FigScopes />

<LiveScopes />

## Give every record a scope

A record's scope comes from its data, through a function you pass as `sync.scope`. Use the same function
on every node, so that a record has the same scope wherever it is read:

<<< @/examples/partial-sync.mjs#scope

Here a task's `board` is its scope. A record the function gives no scope (it returns `'*'`, the default)
is global: it reaches every node, whatever scopes the node asked for. The function runs on the record as
a write leaves it, after validation, so an `update()` that does not touch `board` keeps the task in its
board, and an `update()` that changes `board` moves it.

## Let the host decide what a node may claim

A node names its scopes in its hello, and the host's `authorize` decides whether to accept them. It sees
whatever the transport established about the caller (`context`, such as a wrpc session) and the hello
itself, with the node's `token` and `scopes`:

<<< @/examples/partial-sync.mjs#authorize

Once a node is accepted, the scopes it asked for are a boundary, not a hint. The host serves it ops and
snapshots of those scopes alone, and refuses any op it pushes for a record outside them. The host checks
the record itself, before and after the op, with its own `sync.scope`, so a node cannot write a record
into or out of a scope by claiming another one in the op.

## Register a host with scopes

The examples run every node in one process with `createMesh` from `@alexify/syncom/testing`, which stands
in for the network: the server hosts at `mem://server` with the `authorize` above, and every node opens
with `sync: { scope }`.

<<< @/examples/partial-sync.mjs#mesh

Each node then registers the server with the scopes it should carry, and the token its `authorize` will
check:

<<< @/examples/partial-sync.mjs#dial

Now write a task on each board, and one that belongs to no board:

<<< @/examples/partial-sync.mjs#boards

<<< @/examples/partial-sync.mjs#read

Each node holds its boards and the global task, nothing else. A node that asks for a scope its token does
not cover is refused at hello, receives nothing and gets the code on its `error` event:

<<< @/examples/partial-sync.mjs#refused

## Why a scope is more than a filter

Sequence numbers run per node and per scope: the laptop's design tasks and its web tasks are two streams
of ops, each numbered on its own. A node that carries only some scopes therefore sees no holes in the
streams it reads, and the host can resume its feed exactly where it stopped. A filter over documents
could not do that, because a skipped op would look like a missing one.

One subscription serves all the scopes a node carries. When an op of another scope lands on the host,
the node's feed moves past it without sending anything, so a node pays nothing for the scopes it does not
carry.

On a wrpc server, a greeted node also joins the room `syncom:<scope>` for every scope it asked for, so
`server.rooms.count('syncom:design')` and wrpc's cluster tools tell you who carries what. The ops
themselves never travel through rooms: a room broadcast cannot be resumed, the feed can.

## Sync in one direction

A node that should read but never write back registers its host with `direction: 'pull'`:

<<< @/examples/partial-sync.mjs#pull

A pull-only link subscribes to the feed and pushes nothing, so whatever the reporting node writes stays
there, and its log does not wait for the host to acknowledge its own ops. The opposite,
`direction: 'push'`, only pushes: no feed and no snapshot, so what the host holds never comes back. That
fits a device that only reports, such as a kiosk or a sensor.

The host can make the same choice for everyone who dials a unit with `unit({ allow })`:
`{ push: false }` serves a read-only mirror that answers pushes with 403 (`READ_ONLY`), and
`{ changes: false, snapshot: false }` a write-only sink. Mount several units with different rules if
different callers need different ones.

## Take access back

When Ada leaves the design team, the server revokes the scope from her laptop's node:

<<< @/examples/partial-sync.mjs#revoke

The laptop's live feed ends at once, the laptop is told, and its registry entry narrows to the scopes it
keeps. It reports `REVOKED` on its `error` event and opens its feed again under the narrower grant. The
revocation is saved on the server, so the next hello, even after a restart, grants no more; over a
[shared log](./replication-nats) every hub takes it back.

## What a node forgets

Without a hook, the laptop forgets every record of the revoked scopes:

<<< @/examples/partial-sync.mjs#forgotten

Forgetting is not a delete. The record leaves this node's storage and log, and no op is made, so nothing
reaches the server or any other node: the task is still on the board for everyone who may see it. Global
records and the scopes the node keeps stay. If a peer later sends an op of a forgotten record, the record
is made again from that op.

To decide yourself, pass `sync: { hooks: { onRevoke({ url, node, scopes }) { … } } }`. The laptop then
forgets nothing, and the hook can archive, encrypt or delete the records as your app requires; the feed
is reopened under the new grant after it.

## Trade-offs

- **One scope per record.** A record cannot be in two scopes. Share a record between two teams by giving
  it a scope both carry, or make it global.
- **A node writes what it carries.** A node pushes only the ops of its scopes. A record it creates in a
  scope it does not carry, or moves into one, stays on that node, and the host keeps its last version of
  the record.
- **A node relays only what it carries.** A node that carries one scope can pass on that scope alone, so
  a node that needs more must dial a node that holds more.
- **Scopes are the read filter.** A per-op rule cannot hide an op from a peer without leaving a hole in
  its stream. `beforeSend` (see [hooks](./hooks)) sends such an op as a header with no payload, and the
  host's `authorizeWrite` refuses writes the same way ([syncom server replication](./replication-server)).
  Decide what each node may read with scopes.
- **A node with no scope left.** Revoking the last scope a node asked for leaves it nothing to subscribe
  to: the host refuses its feed with 403 instead of keeping it on the global records. Re-register it with
  the scopes it should have, or remove it.
- **256 scopes per hello at most.** A node that needs more should get a coarser scope, such as the team
  instead of every project.

## Coming from RxDB

In RxDB, partial sync is one replication per scope, each with its own checkpoint, and your backend filters
what each pull returns; the RxDB server narrows reads with a query modifier. In syncom one link carries
every scope a node holds, the host enforces the scopes on writes as well as reads, and a revoke reaches
the node at once and makes it forget what it may no longer see, where RxDB leaves the client its copy.

<FromRxdb page="partial-sync" :rows="['partial', 'partialLive', 'revoke', 'oneWay', 'access']" />
