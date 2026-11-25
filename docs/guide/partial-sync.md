---
title: Partial sync
description: Give each node only the records it may see with scopes, let the host decide what a node may claim, sync one way, and take access back with revoke.
---

# Partial sync

The task board now serves a whole company. The design team should not carry the mobile team's tasks on
their laptops, a reporting job should read every board but write nothing back, and when Ada leaves the
design team her laptop should stop receiving design tasks and drop the ones it already has. A server that
sends every record to every [node](./glossary#node) cannot do any of that.

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

A node names its scopes in its [hello](./sync-protocol#say-hello), the greeting that opens every
connection, and the host's `authorize` decides whether to accept them. It sees whatever the transport
established about the caller (`context`, such as a wrpc session) and the hello itself: the node's id
(`node`), its `token` and its `scopes`:

<<< @/examples/partial-sync.mjs#authorize

In an app the token is a credential your sign-in gives the device, such as a session token, and
`authorize` checks it with your auth service; the names in `boards` stand in for that here. With wrpc's
own sessions you can read `context.session` instead and leave the token out
([syncom server replication](./replication-server#decide-who-may-connect)). `authorize` also notes each
node's id with its token, which is how the server knows later which nodes to
[take access back](#take-access-back) from; keep that map where your app keeps its users.

Once a node is accepted, the scopes it asked for are a boundary, not a hint. The host serves it
[ops](./glossary#op) and [snapshots](./glossary#snapshot) of those scopes alone, and refuses any op it
pushes for a record outside them. The host checks the record itself, before and after the op, with its
own `sync.scope`, so a node cannot write a record into or out of a scope by claiming another one in the
op. A refused op goes on as a header that applies nowhere, so the node's later writes still land, and the
node reports `ALX_ERR_WRITE_REFUSED` with `reason: 'scope'`; the host hands it nothing of a record it may not see.

## Register a host with scopes

The examples run the server and four nodes in one process over a real wrpc server on `127.0.0.1`, the
wiring an app uses ([Quickstart](./quickstart#sync-with-another-node) walks through it). The server mounts
its [unit](./glossary#unit) with the `authorize` above, and every node opens with `sync: { scope }`:

<<< @/examples/partial-sync.mjs#nodes

Each node then registers the server with the scopes it should carry, and the token its `authorize` will
check:

<<< @/examples/partial-sync.mjs#dial

A node that leaves `scopes` out asks for `'*'`, every scope there is, as the `reports` node does
[below](#sync-in-one-direction), so its token must allow that.

Now write a task on each board, and one that belongs to no board:

<<< @/examples/partial-sync.mjs#boards

<<< @/examples/partial-sync.mjs#read

Each node holds its boards and the global task, nothing else. A node that asks for a scope its token does
not cover is refused at hello, receives nothing and gets the code on its `error` event:

<<< @/examples/partial-sync.mjs#refused

## Why a scope is more than a filter

A node that carries only some scopes still resumes its [feed](./sync-protocol#follow-the-host-s-feed)
exactly where it stopped after a reconnect, and pays nothing for the scopes it does not carry: the host
moves its feed past their ops without sending anything. A filter over documents could not promise that,
because a skipped op would look like a missing one. How the ops are numbered to make that work, and how a
wrpc server tells you who carries which scope, is in the [wire reference](../reference/wire#scopes).

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

When Ada leaves the design team, the server revokes the scope from every node she signed in from, by the
node ids `authorize` noted:

<<< @/examples/partial-sync.mjs#revoke

The laptop's live feed ends at once, the laptop is told, and its registry entry narrows to the scopes it
keeps. It reports `ALX_ERR_REVOKED` on its `error` event and opens its feed again under the narrower grant. The
revocation is saved on the server, so the next hello, even after a restart, grants no more; over a
[shared log](./replication-nats) every hub takes it back.

## What a node forgets

Without a hook, the laptop forgets every record of the revoked scopes:

<<< @/examples/partial-sync.mjs#forgotten

Forgetting is not a delete. The record leaves this node's storage and log, and no op is made, so nothing
reaches the server or any other node: the task is still on the board for everyone who may see it. Global
records and the scopes the node keeps stay. If a peer later sends an op of a forgotten record, the record
is made again from that op.

Revoking the last scope a node asked for works the same way. When Bob moves off the mobile team, the
phone forgets the mobile tasks and its registry entry is left empty:

<<< @/examples/partial-sync.mjs#last

The phone stays connected, and its feed carries the global records alone: a new global task still
arrives, a mobile one never does. Remove the node if it should receive nothing at all.

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
- **A node with no scope left still reads the global records.** A revoke takes scopes, never the
  connection: a node whose last scope was revoked, or that asked for none, keeps the global records in
  step. Remove the node, or refuse it in `authorize`, to stop that too.
- **256 scopes per hello at most.** A node that needs more should get a coarser scope, such as the team
  instead of every project.

## Coming from RxDB

In RxDB, partial sync is one replication per scope, each with its own checkpoint, and your backend filters
what each pull returns; the RxDB server narrows reads with a query modifier. In syncom one link carries
every scope a node holds, the host enforces the scopes on writes as well as reads, and a revoke reaches
the node at once and makes it forget what it may no longer see, where RxDB leaves the client its copy.

<FromRxdb page="partial-sync" :rows="['partial', 'partialLive', 'revoke', 'oneWay', 'access']" />
