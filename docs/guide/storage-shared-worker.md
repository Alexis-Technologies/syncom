---
title: SharedWorker
description: Run one database for every tab of your app in a SharedWorker, with each tab reading the same IndexedDB and writing through the worker.
---

# SharedWorker

A database is opened by one instance at a time: a second tab that opens the same path gets `LOCKED`, because two
writers would hand out the same sequence numbers. With `@alexify/syncom/shared` every tab still gets a working
database. One instance leads: it holds the full database, writes, and syncs with other nodes. Every other instance
follows: it reads the same store itself and sends its writes to the leader. In a browser the natural leader is a
SharedWorker, the one place every tab of your site can reach and that lives as long as any of them is open.

This page builds that setup. Where no SharedWorker is available, the tabs can elect a leader among themselves
instead; [Leader election](./leader-election) covers the election and what happens when a leader goes away.

<div class="sc-steps">

### Carry calls over a port

A tab sends its writes to the leader over a channel: an object whose `call(method, payload)` delivers the payload
to the leader and resolves to the leader's answer. Both are plain values, so a few lines over a `MessagePort` do:

<<< @/examples/storage-shared-worker.mjs#channel

The leader answers every call as a value, `{ ok: true, value }` or `{ ok: false, error }`, never by throwing, so a
refusal such as `NOT_FOUND` reaches the tab with its code and fields intact, and the tab throws it again. Each call
carries an id, and the leader keeps its recent answers: a call sent again after a lost answer is answered from what
the leader kept, never run twice.

### Lead from the worker

The worker opens the database with `openShared()` and serves the leader's writers on every port a tab hands it:

<<< @/examples/storage-shared-worker-browser.mjs#worker

`openShared()` takes what `createDatabase()` takes, plus `createDatabase` itself (the one you import, the core's or
`/all`'s). The Web Locks election only matters when a newer version of the worker starts while the old one still
runs: the new one waits for the lock, so two workers never write at once.

### Follow from every tab

Each tab opens the same database over the same engine as a follower that never leads, with a channel that hands a
fresh port to the worker:

<<< @/examples/storage-shared-worker-tab.mjs#tab

The tab reads IndexedDB itself, so reads, queries and live queries cost no round trip to the worker. It hears the
worker's writes through the engine's change stream, the `BroadcastChannel` the IndexedDB engine keeps between tabs.

### Read and write from a tab

The same code runs in a tab and in the worker. Here it is in Node.js, where the worker and the tabs are stand-ins in
one process:

<<< @/examples/storage-shared-worker.mjs#use

The insert went to the worker and was written there; the tab's live query heard it through the store. A
`collection()` of the shared database writes through the leader and reads the current instance's data, and
`insert()` answers the id on either role, since a live document does not cross a port.

</div>

## Run sync in the worker

Replication is the leader's job. Pass `sync` options to the worker's `openShared()` and use `shared.sync` there; on
a follower, reading `sync` throws `NOT_LEADER`, and a follower never dials or hosts. The worker's database is a node
like any other: the [Sync engine](./replication) page applies to it unchanged, and the tabs see what it receives as
it lands in the store.

## What a tab cannot do

A follower is a read-only database with its writes forwarded, which leaves a few things to the leader:

- `observe()` is not offered on the shared database, because a follower raises no `transaction` event; use a
  live query (`select().watch()`) or `shared.document(id)` instead.
- A collection's `modify(id, fn)` and a write by query (`remove()`) reject with `NOT_LEADER`: a function does not
  cross a port.
- `transact(fn)` on a follower is recorded: `fn` runs in the tab, its writes are noted and sent as one transaction,
  so `fn` cannot read what it wrote, and `insert()` is refused inside it (use `set()` with an id of your own).
- A write waits for a leader for up to `failover` milliseconds (10 000 by default), for example while a new worker
  takes over, and then rejects with `LEADER_LOST`; `maybeApplied: true` on that error means read the record before
  you write it again.

## Limitations

- **A shared engine only.** The leader and the followers open the same store at the same time, which the memory,
  IndexedDB and MongoDB engines allow. The files engine (OPFS) and SQLite belong to one instance, and a follower
  over them is refused.
- **Not every browser has SharedWorker.** Check `typeof SharedWorker !== 'undefined'` and fall back to tabs that elect
  a leader among themselves ([Leader election](./leader-election)).
- **The channel is yours.** The worker cannot run a wrpc server, so the port channel above is application code.
  Where the leader can run one (a Node.js process, Electron's main process), `createSharedChannel()` from
  `@alexify/syncom/wrpc` turns a wrpc client into the same channel.
- **Each follower is a second database over the store**, with its own cache and catalog, built when the tab opens.

## Coming from RxDB

RxDB's SharedWorker storage, a Premium plugin, moves the storage into the worker and every tab's database talks to
it. In syncom the worker holds the whole database, including its log and its sync, while every tab keeps a
read-only database over the same IndexedDB and forwards only its writes.

<FromRxdb page="rx-storage-shared-worker" :rows="['worker', 'multiTab', 'replMultiTab']" />

Every member of the shared database is listed in the [API reference](../reference/api#shared-subpath).
