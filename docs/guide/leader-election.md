---
title: Leader election
description: Pick one tab or process to lead among several over one database, hand leadership on when it goes away, and run work only where it leads.
---

# Leader election

A user opens your task board in three browser tabs. Each tab would like to sync with the server, send
reminders and clean up old tasks, but doing that three times wastes battery and bandwidth, and three
instances writing the same database would mint the same sequence numbers for their ops. syncom's answer
is an election: the tabs agree on one leader, the leader does the work that must happen once, and when
the leader's tab closes another tab takes over.

<LiveElection />

## How a leader is chosen

In a browser the election is a [Web Lock](https://developer.mozilla.org/docs/Web/API/Web_Locks_API):
every tab asks for the same exclusive lock, the browser grants it to one of them, and the others wait in
line. A lock outlives nothing but its holder, so a tab that closes or crashes lets go of it and the next
tab in line is granted it. No timer guesses whether the leader is still alive. Web Locks are scoped to an
origin, so there is one leader per lock name per origin: the tabs of `app.example.com` elect among
themselves, and two databases with different names elect two leaders.

Node.js has Web Locks too (`navigator.locks`), which is how the examples on this page run. Where a
platform has no locks but has a `BroadcastChannel`, the election falls back to a heartbeat.

## Elect a leader for your own work

`elect()` from `@alexify/syncom/shared` runs an election without a database, for work only one tab
should do. Each "tab" below joins the same election:

<<< @/examples/leader-election.mjs#elect

`onLead` fires at every grant from the moment you attach it. A grant can arrive before `elect()` returns
(Node.js grants a free lock at once), so check `election.leader` as well, as the example does. When the
leader goes away, the next tab in line leads:

<<< @/examples/leader-election.mjs#release

`release()` leaves the election for good, which is what closing the tab does by itself. `yield()` steps
aside for now and `request()` asks again later, and `onLost` tells you when the lead was taken from you.
`election.mode` says how the election runs: `'locks'`, `'heartbeat'`, `'follower'` for an instance created
with `follower: true` that never leads, or `'alone'` when neither locks nor a channel were given and the
instance leads at once.

## Elect without Web Locks

Pass a `BroadcastChannel` instead of `locks`:

<<< @/examples/leader-election.mjs#heartbeat

A candidate claims the lead with a random token and waits. The leader repeats that it leads every
`heartbeat` milliseconds (1000 by default), and a candidate that hears no leader for `misses` beats (3 by
default) takes over. If two instances end up leading at once, the one with the smaller token stays and
the other steps down. The heartbeat is slower to notice a crash than a lock, so pass `locks` wherever the
platform has them.

## Let the leader own the database

When several tabs share one database, the election decides who opens it for writing. `openShared()` takes
what `createDatabase()` takes, plus the `createDatabase` function itself and an `election`:

<<< @/examples/leader-election.mjs#shared

The leader is a full database: it writes, and it is the only instance that runs [replication](./replication),
so there is one connection to the server however many tabs are open. Every follower is a read-only database
over the same engine. It reads what the leader writes and hears about it through the engine's change
stream, so queries and live documents work in every tab. On a follower, `shared.sync` throws `NOT_LEADER`,
and a write is forwarded to the leader over a `channel` you give `openShared()`; without one, as here, a
follower's write is refused with `NOT_LEADER`. [SharedWorker storage](./storage-shared-worker) shows the
channel over wrpc, where a SharedWorker holds the election and every tab follows.

`isLeader()` tells you the role now, `waitForLeadership()` resolves when this instance leads, and
`onLeader(listener)` calls you at every promotion. The `leader` and `follower` events say the same on
`shared.on()`. The engine must be one that several instances may open at once: [IndexedDB](./storage-indexeddb),
[memory](./storage-memory) or [MongoDB](./storage-mongodb), never the filesystem or SQLite, whose files and
connections belong to one instance.

## Hand leadership on

When the leading tab closes, the next tab in line is granted the lock and promotes itself:

<<< @/examples/leader-election.mjs#failover

<FigFailover />

The new leader opens the database beside its follower, moves everything it handed out to the new
instance, and only then closes the follower, so `shared.db` is never empty. It is the same node as
before: the same node id, the same log, the same list of peers. The server sees a reconnect, not a new
node, and the new leader dials where the old one did. `generation` counts up at every change of instance,
and the `rebind` event fires once everything was moved. A live `shared.document(id)` keeps working across
the change and reads the record again once from the new instance.

A follower's write that reached no leader (the old one was already gone) waits for the new leader and runs
there, for up to `failover` milliseconds (10 seconds by default); past that it rejects with `LEADER_LOST`. A
write that may have reached the old leader is never run twice: the new leader does not know it, so it rejects
at once with `LEADER_LOST` and `maybeApplied: true`, which means the write may have landed. Read the record
before writing again.
An instance granted the lead that cannot open the database reports `PROMOTE_FAILED` on its `error` event,
steps aside so the next instance can lead, and asks again later; it never holds a lock it cannot use.

## Trade-offs

A follower is a second database over the same storage, with its own cache and catalog, so every tab pays
for its reads. A forwarded write costs one round trip to the leader, and the follower reads its own write
once the change reaches it through the engine. The election itself is one lock request per tab. If you only need
the tabs to see each other's writes and do not mind several connections to the server, the engine's change
stream already gives you that; the election is for the work that must happen once.

## Coming from RxDB

RxDB's leader election plugin elects among tabs that each open the same database, and you start work with
`waitForLeadership()`, typically replication. syncom's election goes further down: it decides which tab
opens the database for writing at all, the followers forward their writes, and replication runs only in
the leader without you starting it there. For work of your own, `elect()` is the equivalent of
`waitForLeadership()`.

::: code-group

<<< @/examples/leader-election.mjs#elect [syncom]

<<< @/examples/rxdb/leader-election.mjs#elect [RxDB]

:::

<FromRxdb page="leader-election" :rows="['leader', 'multiTab', 'replMultiTab']" />

The options of `openShared()` and `elect()` and the error codes they raise: [API reference](../reference/api#shared-subpath).
