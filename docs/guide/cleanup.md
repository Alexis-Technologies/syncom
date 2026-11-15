---
title: Cleanup
description: Why a deleted record leaves a tombstone, when syncom can safely fold it away, and how cleanup() keeps years of deletions small.
---

# Cleanup

You delete a task on your laptop while your phone is offline. A week later the phone comes back with an edit it
made to that task before the deletion. If the laptop had forgotten the task entirely, the edit would bring it back
to life, and the phone would never learn that it was deleted. So a deleted record leaves a **tombstone**: the
record's file, kept with the timestamps that prove the deletion is newer than anything else written to it. The
late edit is older than the deletion, so it changes nothing, and the deletion reaches the phone.

Tombstones are small, but an app that deletes for years ends up with more tombstones than records.
`@alexify/syncom/cleanup` folds old tombstones into a compact form without giving up what makes them work.

## Fold old tombstones

<<< @/examples/cleanup.mjs#run

`cleanup(db, options)` returns a sweeper. `run()` folds every tombstone deleted at least `minimumDeletedTime` ago
(31 days by default) and resolves to the counts: `folded`, `dropped` (see below), and `skipped` for the tombstones
not old enough or not yet safe to fold. Deciding costs nothing: the deletion time is in the catalog, so a sweep
reads no record to choose.

<<< @/examples/cleanup.mjs#later

The `now` option replaces the clock, which is how a test checks a month-old deletion without waiting a month.

## What folding keeps

Folding moves the whole tombstone (its collection, the data the delete carried, its timestamps) into a compact
store beside the records, and removes the record's file in the same atomic write. Everything a tombstone did, a
folded one still does:

- an edit from a peer older than the deletion is still ignored;
- a newer write brings the record back, as it would have before;
- a node that joins later receives the deletion in its snapshot;
- the catalog finds the deletion when it is rebuilt.

<<< @/examples/cleanup.mjs#revive

On the files engine a folded tombstone is still one small file; on SQLite, IndexedDB and MongoDB it is one row.

## When a tombstone is safe to fold

<FigCleanup />

A folded tombstone is lossless, but it is still worth being careful with your own deletions: until a peer has
the delete op, this node is the only one that can deliver it. By default (`awaitSync: true`) a tombstone of a
delete this node made is folded only once every enabled node this node syncs with has acknowledged that op:

<<< @/examples/cleanup.mjs#await-sync

A deletion that came from a peer is that peer's to deliver, so it folds on age alone. A node you disabled is not
waited for; when it comes back it catches up through a snapshot, and a snapshot carries folded tombstones too.

## Run it on a schedule

<<< @/examples/cleanup.mjs#schedule

`start()` runs a sweep every `runEach` milliseconds (five minutes by default) until `stop()` or until the database
closes. A sweep that fails on the timer is logged as `cleanup.failed` and the next one runs as planned. Folds go a
hundred records at a time, each batch one write, so a sweep does not hold up the app's own writes for long.

## Sweep from one tab of several

Every instance that opens the database and starts cleanup sweeps. When several tabs share one database through
[`openShared()`](./leader-election), give cleanup the tab's handle as `leader`, with its `db` as the database:

<<< @/examples/cleanup.mjs#leader

The timer then runs only in the tab that leads, and moves to the tab that takes over when the leader closes.
`run()` in a tab that follows sweeps nothing and resolves to zero counts.

## Drop tombstones for good

`run({ drop: true })` also removes the folded tombstone and the record's catalog entry. After that, the record is
forgotten: an old edit from a peer creates it again, and a peer that never received the deletion keeps its copy
forever. Drop only when every device that could hold the record is known to have synced, for example after a
server-side retention period your app enforces. Under `awaitSync`, a deletion of this node's own whose op the log
no longer keeps is never dropped, because this node cannot prove it reached anyone.

## Limitations

- Folding is safe at any age, so `minimumDeletedTime` is a space setting. Dropping is not: `run({ drop: true })`
  drops every tombstone folded so far, and a device offline since before the deletion brings the record back.
- Without `leader`, every instance that opens the database and starts cleanup sweeps.
- Cleanup does not touch the operation log; [retention](./retention) decides how long ops are kept, and
  [purge](./purge) removes a record's data from the log.

## Coming from RxDB

RxDB's cleanup deletes old tombstones outright after the minimum time, waiting for replications to be idle. syncom
folds them by default and drops them only when you ask: a folded tombstone still wins against a late edit, so
the 31 days are a space setting, not a correctness risk. The wait is per delete op and per peer, rather than for
replication to be idle.

::: code-group

<<< @/examples/cleanup.mjs#run [syncom]

<<< @/examples/rxdb/cleanup.mjs#run [RxDB]

:::

<FromRxdb page="cleanup" :rows="['tombstoneCleanup']" />

The options and counts are in the [reference](../reference/api#cleanup-subpath).
