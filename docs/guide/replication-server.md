---
title: syncom server replication
description: Replicate with another syncom node acting as the server. Mount its sync unit on a wrpc router, dial it with a token, set write rules, and let any node host.
---

# syncom server replication

Choose this when the other end of your replication is a syncom node you run: a server in the cloud, a
desktop app on the office network, or a process next to your API. The server is an ordinary syncom
database that also mounts its sync unit on a [wrpc](https://wrpc.vercel.app) router. There is no separate
server product and no replication endpoint to write: the unit already speaks the protocol, holds every
record, enforces [scopes](./partial-sync) and write rules, and relays between the nodes that dial it.
[The sync engine](./replication) explains what travels between the nodes; this page sets it up.

<div class="sc-steps">

### Install wrpc next to syncom

syncom has no network code of its own. Both the server and the clients use wrpc, version 2:

```bash
npm install @alexify/syncom @alexify/wrpc
```

### Host the server node

Open a database, mount `db.sync.unit()` under `syncom` on a wrpc router, and listen:

<<< @/examples/replication-server.mjs#host

`access: 'public'` lets any connection reach the unit, and `authorize` then admits a node by the token it
presents in its hello. `authorizeWrite` is the server's rule on what a node may write; both are covered
below.

### Dial it from a client

A client opens its database with a `connect` function that turns a registry entry into a link, and
registers the server once:

<<< @/examples/replication-server.mjs#dial

The registry is saved with the database, so the check before `addNode()` keeps a restart from registering
the server twice (that would reject with `ALX_ERR_NODE_EXISTS`). After a restart the client dials the server
again by itself and resumes from where it stopped.

### Write on either side

<<< @/examples/replication-server.mjs#both-ways

Writes flow both ways: the client pushes its own, and the server's feed brings everything that lands on
the server, whoever wrote it.

</div>

## Decide who may connect

`authorize(context, hello)` runs on every hello. Return `true` to admit the node or `false` to refuse it.
`hello` carries the node's id, its `token` (what it passed to `addNode()`), the `scopes` it asks for and
its schema version. A refused node gets a `403` on its `error` event and receives nothing:

<<< @/examples/replication-server.mjs#refused

A token in the hello is the simplest gate. To use your login sessions instead, keep the unit at wrpc's
default `access: 'session'`, sign clients in through wrpc's
[authenticate hook](https://wrpc.vercel.app/guide/client#authenticating), and read `context.session` in
`authorize`. Use `wss://` in production, so tokens and data are encrypted on the way.

A node's id can also be checked. With the [signing](./signing) plugin, a node's id is its public key, and
`unit({ prove: true })` (on by default under `sync: { signatures: 'require' }`) makes every node sign a
challenge with that key before the server takes or hands it anything; until then its calls are refused
with 403.

`authorize` is also where the server decides which scopes a credential may claim, as
[Partial sync](./partial-sync#let-the-host-decide-what-a-node-may-claim) shows.

## Decide what a node may write

`authorizeWrite({ op, peer, current, after })` is asked about every op a node pushes, with the record as
the server holds it (`current`) and as the op would leave it (`after`). Return `false` and the server
refuses the op without leaving a hole in the node's stream: it logs and relays the op with no payload, and
names it in its answer. The client reports `ALX_ERR_WRITE_REFUSED` and brings the record back to what the server
holds:

<<< @/examples/replication-server.mjs#write-rule

Pass the rule as `createDatabase({ sync: { authorizeWrite } })` to apply it to every unit of the database.
A rule that throws fails the whole push, and the client offers it again. `op.actor` says who made the op
(the `actor` option of the client's database or write) but is the writer's own claim, so check it against
what `authorize` established.

## Let any node host

Hosting is not reserved for servers. A node can dial one host and serve others at the same time: here an
office desktop dials the cloud server and hosts the phones on the local network, which never reach the
server themselves:

<<< @/examples/replication-server-relay.mjs#relay

<<< @/examples/replication-server-relay.mjs#relayed

A node passes on what it receives to its other links, so ops travel across any chain or mesh of nodes. A
node that already has an op drops it, so an op reaches each node once per link at most, and never loops.
Several servers that dial each other form a mesh the same way; [Scaling](./server-scaling) covers that and
the shared log that lets clients move between servers.

## Watch the host

<<< @/examples/replication-server.mjs#hello-event

On the hosting side, `hello` fires when a node is admitted, `refused` when a push carried ops the server
would not take (out of the node's scopes, refused by `authorizeWrite`, or with a bad signature), and
`hosted()` lists the nodes with a live feed. The events of the dialing side, such as `peer` and `sync`, are
the client's ([Sync engine](./replication#watch-replication)).

## Survive a restart

<<< @/examples/replication-server.mjs#restart

Both sides resume after a restart. The client's registry, its position in the server's feed and what the
server has acknowledged are saved with its database. The server's log keeps the identity of its history,
so a returning client continues from its saved position instead of starting over, as long as the server's
log still covers it; past that it gets a snapshot ([Sync engine](./replication#add-a-node-later-or-come-back-after-a-long-time)).

## Options that matter

The unit takes the rest of its options as `db.sync.unit({ … })`:

| Option | What it is for |
| --- | --- |
| `limits` | Per-node push limits: `opsPerPush` (10 000 by default), `bytesPerPush` and `opsPerSecond`. A page over a limit is refused with 413 or 429; the client marks the server `behind` and pushes the rest later |
| `allow` | Which procedures this unit serves: `{ push: false }` makes a read-only mirror, `{ changes: false, snapshot: false }` a write-only sink |
| `query` | Serve one-off queries to [thin clients over HTTP](./replication-websocket#read-from-a-script-over-http) |
| `pageSize`, `pageBytes` | Records per snapshot page and ops per feed page (500), and the size above which a snapshot page is sent inline instead of streamed (4 MiB) |
| `presence` | How the unit relays [presence](./presence) |
| `meta` | Copied onto every procedure, for a wrpc `onRequest` hook (a rate limit per session, an audit) |

Every option, default and refusal code is in the [API reference](../reference/api#syncmanager), and the
procedures themselves in the [wire format](../reference/wire#the-procedures).

## Limitations

- **Run the server with the plugins the clients use.** A server opened without a field kind (such as
  text) still relays those ops, but its snapshots lack those fields, so a client that uses the kind does
  not bootstrap from it. Open the server from `@alexify/syncom/all`, or with the same `plugins` as the
  clients.
- **The server holds every record it serves.** It is a full node, with its own storage and log; choose
  its [storage](./storage) for the size of the whole data set.
- **One position per server.** A client's position in the feed belongs to one server's log. Behind a load
  balancer, keep each client on one server, or give the servers a shared log
  ([NATS and brokers](./replication-nats)).

## Coming from RxDB

RxDB's server replication talks to an RxServer, a separate server that exposes a collection's
replication endpoints, and reports problems on streams such as `unauthorized$` and `outdatedClient$`. In
syncom the server is another syncom node, the same code as the client, and the same refusals arrive as
codes on the client's `error` event: 403 for a node `authorize` refused, 400 for a client of another
protocol version. RxServer's change validator corresponds to `authorizeWrite`, and its query modifier to
[scopes](./partial-sync).

<FromRxdb page="replication-server" :rows="['serverProduct', 'topology', 'relay', 'authn', 'writeRules', 'limits']" />
