---
title: NATS and brokers
description: Share one log between syncom hubs over NATS JetStream, Redis Streams, Kafka or AMQP, so a client resumes on any hub behind a load balancer.
---

# NATS and brokers

syncom has no NATS replication plugin, and clients never talk to NATS. What a broker does for syncom is
connect the **hubs**: several server processes behind one load balancer share one log in NATS JetStream,
Redis Streams, Kafka or AMQP, through wrpc's broker adapters. Every hub appends the ops it accepts to the
log and applies the others' ops from it, and clients keep dialing hubs over [WebSocket](./replication-websocket)
as before.

Choose this when one hub is not enough and clients must be able to land on any hub. Without a shared log,
hubs can dial each other and converge too, but a client's position in a feed belongs to one hub's log, so
a client moved to another hub starts over there. With a shared log, a client's position is a position in
the shared log, the same on every hub, and it resumes wherever the load balancer sends it.
[Scaling](./server-scaling) compares the options.

<div class="sc-steps">

### Open every hub over the broker's log

Every hub process opens its database with the broker's log as `sync.sharedLog`. The example uses wrpc's
in-process `MemoryBroker`, which has the same log as the real brokers:

<<< @/examples/replication-nats.mjs#hubs

The hubs need no links between them. Each one appends what it accepts, its own writes and its clients'
pushes, and applies from the log what the others appended.

### Put the hubs behind one address

Each hub mounts its unit on a wrpc server as usual. Clients dial one url, and whichever hub answers serves
them; here an in-process link stands in for the load balancer:

<<< @/examples/replication-nats.mjs#balancer

### Write anywhere

<<< @/examples/replication-nats.mjs#across

A client's push to hub 1 reaches hub 2 through the log, and a write on hub 2 reaches the client through
the log and hub 1.

### Move a client to another hub

<<< @/examples/replication-nats.mjs#move

A hub over a shared log answers hello with the log's identity, `shared:<topic>`, instead of its own, so
the client's saved position stays valid on every hub. When the load balancer sends it elsewhere, it
resumes from that position, with no snapshot and no replay.

</div>

## Use NATS JetStream

In production the log is a real broker's. With NATS, inject the connection and the JetStream factories
into wrpc's NATS broker and hand its `log` to syncom:

<<< @/examples/replication-nats-jetstream.mjs#jetstream

`@alexify/wrpc/broker/redis`, `/kafka` and `/amqp` work the same way: create the broker, pass
`broker.log`. The same broker can also be the wrpc server's backplane for rooms and cluster calls. Without
a broker, a MongoDB that the hubs already share can hold the log (`mongoSharedLog()` of
`@alexify/syncom/mongodb`, described in [Scaling](./server-scaling)).

## What the hubs share

Beyond the ops, a hub over a shared log shares two things with the others. A revocation made on one hub
(`sync.revoke()`, see [Partial sync](./partial-sync#take-access-back)) goes into the log, and every hub
takes the scopes back from that node. And a new client, which has no position yet, gets a snapshot that is
positioned in the log, so nothing written while it reads the pages falls between the snapshot and the
feed.

`sync.shared()` reports how a hub stands to the log: its read position, how far its own ops have been
appended, whether it is behind or stuck, and counts of what it relayed and applied. Failures come as
`SHARED_LOG_FAILED` on the sync manager's `error` event, and the hub recovers by itself: an append that
failed is appended again once the broker answers, also at the next start.

## Options that matter

`sync.sharedLog` takes the log alone, or `{ log, topic, inbox, stopWait }`: the topic every hub appends
to (`'syncom'` by default), the inbox through which a read-only hub forwards its clients' pushes to a hub
that writes (`<topic>.inbox`, or `false` for none), and how long `stop()` waits for an append in flight
(5 seconds). Hubs that should share data must use the same topic; give each deployment its own topic.

## Limitations

- **Clients never connect to the broker.** NATS has no notion of syncom's scopes or write rules, so it
  stays behind the hubs, where the hubs enforce them.
- **Retention is the broker's.** The shared log keeps what the broker keeps (a JetStream stream's limits,
  the Redis broker's `maxLen`); a client whose position was trimmed away gets a snapshot.
- **Every hub writes everything to its own storage.** The log carries ops between hubs; it does not
  replace each hub's database.
- **A fresh client needs a hub that writes.** A read-only hub (a follower over a shared MongoDB) serves
  feeds but no snapshots, so route clients with no saved position to a hub that writes
  ([Scaling](./server-scaling)).

## Coming from RxDB

RxDB's NATS plugin replicates one collection with a NATS JetStream stream, a subject per document, and
recommends doing it from your Node.js server rather than from untrusted clients. syncom puts NATS in the
same place, behind the server, but uses it differently: as the log the hub processes share, carrying ops
for every collection, so that clients can move between hubs. The clients' own replication stays syncom's
protocol over wrpc.

<FromRxdb page="replication-nats" :rows="['nats', 'scaleOut']" />
