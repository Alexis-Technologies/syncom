---
title: Scaling
description: Grow from one hub to hubs that dial each other, hubs that share a broker's log, and read-only hubs over one MongoDB, and what each step costs.
---

# Scaling

Your task board starts with one [hub](./server): every laptop and phone dials it, and it relays what
each writes to the others. Then the team grows. You want a hub per region so a phone in Sydney does
not sync through Frankfurt, or several hub processes behind a load balancer so one machine is not the
limit, or a database cluster that holds the data while stateless processes serve the clients. syncom
has no coordinator, so each of these is a question of topology: which nodes dial which, and where a
client's position in the stream is kept.

<FigHubs />

## Run hubs that dial each other

A hub is a node like any other, so a second hub dials the first exactly as a client would. Ops that a
client pushes to hub 1 reach hub 2 over that link, and hub 2's clients receive them from there.

<<< @/examples/server-scaling.mjs#mesh

Each hub keeps a full replica in its own database and mounts its own unit. Every node relays what it
applies to its other links, and the [version vector](./operation-log#what-a-node-has-seen-version-vectors)
stops an op that a node already has, so an op reaches a node at most once per link it has, and never
loops.

The one rule this topology imposes on your load balancer is **sticky sessions**. A client's cursor is
a position in one hub's log (`<epoch>.<seq>`), and every hub has its own epoch. A client sent to
another hub sees another epoch at hello, drops its cursor and starts over there: it reads that hub's
whole retained log, or [bootstraps](./sync-protocol#join-from-a-snapshot) once that hub has compacted
past the beginning. That is correct, only more expensive. A hub that restarts keeps its epoch, so its
own clients resume from their cursors.

## Serve every hub from one log

What hubs that dial each other cannot give you is a cursor that is valid on every hub. A shared log
does: every op a hub accepts (its own writes, a client's push, a joined snapshot) is appended to one
topic of a broker, every other hub applies from the topic what it lacks, and every hub serves its
clients' feeds from the topic. The hubs need no link between them.

<<< @/examples/server-scaling.mjs#shared

The log is anything shaped like wrpc's `BrokerLog` (`append`, `read`, `parseId`): the `.log` of a
wrpc broker over Redis Streams, NATS JetStream, Kafka or AMQP fits as it is ([NATS and
brokers](./replication-nats) covers each), and `isSharedLog()` checks a log of your own. Over a shared
log a client's cursor is a position in the topic, and every hub answers hello with the log's epoch:

<<< @/examples/server-scaling.mjs#epoch

So the load balancer can send a client anywhere, and the client resumes on the new hub from where it
was, with no bootstrap. A hub reads the topic once however many clients follow it: its consumer keeps
the last 1 024 entries it passed and serves every feed from them, and only a feed that fell further
behind reads the log on its own until it catches up.

A new client still starts with a snapshot. The hub first appends a marker to the topic, waits until
its consumer has passed it, and takes the first page there, so nothing lands between the pages and the
cursor the client resumes from. How long the topic keeps entries is the broker's retention (or
`trim()`); a client whose cursor was trimmed away bootstraps again. A [revocation](./partial-sync) made
on one hub goes into the topic too, so no hub grants those scopes again.

When the broker fails, the hub reports `ALX_ERR_SHARED_LOG_FAILED` on its manager's `error` event with a
`reason`, and recovers by itself: an append that failed (`append`) is retried with everything its log
holds above the last position it knows reached the topic, a cursor the broker trimmed (`gone`) is read
from the oldest entry, an entry that could not be applied (`apply`) is retried with backoff. An entry
that a hook refuses three times leaves the topic `stuck` until you stop and start the manager.
`hub.sync.shared()` shows the cursors, those positions and the counts.

## Add read-only hubs over one database

With MongoDB you can go one step further: one database holds the records, one process writes to it,
and any number of read-only processes serve clients from it. The writer holds the database's lease
and lands every op:

<<< @/examples/server-scaling-mongodb.mjs#writer

A follower opens the same database with `readOnly: true`, reads the records the writer lands through
MongoDB's change stream, and hosts over the shared log (each process has its own client in
production):

<<< @/examples/server-scaling-mongodb.mjs#follower

`mongoSharedLog()` keeps the topic in two collections of the database the hubs already share, so
there is no broker to run. A follower answers hello with the vector as the log moved it and serves
its clients' feeds from the log. A push it receives is checked as a writer would check it (forged or
unsigned ops stop there) and forwarded to an inbox topic; the writer lands it under its
`authorizeWrite` rule and appends it to the topic, where the follower sees it come back. The bytes of
an [attachment](./attachments#limits) go to the follower as well: once the writer has landed the
record, the follower stores them in the database's blob store, which the writer and every other
follower read.

A follower serves no snapshot, because its view can run ahead of what its engine has read, so a
fresh client must bootstrap from a hub that writes (403 `READ_ONLY` otherwise). That is the load
balancer's rule here: a client with no cursor goes to the writer, and follows on any hub after.
Without an inbox (`sharedLog: { log, inbox: false }`) a follower refuses pushes with 503. A writer
whose lease is lost becomes read-only and hosts the same way, except that it takes no attachment
bytes: it is fenced from the database, so it refuses them for good. `docs/examples/server-scaling.mjs`
runs this arrangement over the memory engine, which is shared within one process.

## Split the data into buckets

A hub that holds every tenant's data does not have to send all of it to everyone. Give each record a
scope with `sync.scope(id, data)` (a tenant, a project, a team), register each client with the scopes
it may hold, and the hub sends each client its scopes alone and takes from it only writes to them.
Sequence numbers run per origin and scope, so a client of one scope sees no holes in its streams.
[Partial sync](./partial-sync) shows the setup, and scopes work the same on every topology above.

## What each step costs

| Topology | A client moved to another hub | What you run besides the hubs | A new client bootstraps from |
| --- | --- | --- | --- |
| One hub | nowhere to move | nothing | the hub |
| Hubs that dial each other | starts over there (sticky sessions avoid it) | nothing | the hub it dials |
| Hubs over a shared log | resumes from its cursor | a broker with a log | any hub |
| One writer and read-only hubs | resumes from its cursor | MongoDB (one database, one log) | the writer |

Every hub that keeps its own database stores a full replica and checks every op it takes: its shape,
its signature and its scope. Signature checks run on libuv's thread pool in Node.js, which is four
threads unless `UV_THREADPOOL_SIZE` says otherwise and is shared with file I/O and DNS, so raise it on
a hub that serves many peers. Retention decides how long a client may stay away before it must
bootstrap (see [Retention](./retention)), and a bootstrap costs one snapshot of the client's scopes.
For limits on what one client may push, see [Hosting a node](./server#bound-what-a-peer-can-push);
for metrics and traces of replication, [OpenTelemetry](./telemetry).

## Limitations

- **A shared log is a bus, not a second database.** Each hub still keeps its own log and records; the
  topic only carries what hubs accepted. Size the broker's retention for the longest a client may be
  away, as you size a hub's.
- **Several writers over one inbox each land every entry.** That is correct but wasteful: hubs that
  all write need no inbox (`inbox: false`); one writer and its followers need one.
- **A follower never writes.** It cannot take over as the writer by itself; a new writer opens the
  database and takes the lease.

## Coming from RxDB

RxDB scales the server by running several processes over one database that talk through a
BroadcastChannel, by moving storage into a worker, by putting memory in front of disk, and by a tree of
servers that replicate from a central datastore. In syncom every hub is a full node, so a tree or a
mesh of hubs is replication between nodes, a broker's log replaces the processes' channel, and a
MongoDB cluster with read-only followers plays the part of a storage that scales by itself. A memory
layer and a worker are options of the storage, not of the server: see [Memory over
disk](./storage-layered) and [Worker](./storage-worker).

<FromRxdb page="rx-server-scaling" :rows="['scaleOut', 'topology', 'multiMaster', 'nats', 'serverStorage', 'partial']" />
