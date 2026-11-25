---
title: Retention and acknowledgements
description: How long the operation log keeps ops, why a node keeps its own until its hosts have them, what ALX_ERR_UNDELIVERABLE and ALX_ERR_REWOUND mean, and how cleanup and purge fit in.
---

# Retention and acknowledgements

After a year in production the task board's server has applied millions of ops. Keeping every one
for ever costs disk and makes every open slower; dropping them too early strands the laptop that was
switched off during a two-week holiday, because the server can no longer replay what it missed. The
[operation log](./operation-log) settles this with retention: a node keeps a window of recent ops,
drops whole segments beyond it, and makes one exception for the ops nobody else could deliver.

<FigRetention />

## Choose how long the log keeps ops

`sync.retention` sets the window. The log keeps at least `ops` ops (10 000 by default) and can also
drop what is older than `days`:

<<< @/examples/retention.mjs#options

When the log seals a segment and the oldest segments fall outside the window, it drops them whole and
moves its `floor` up: the lowest position it still holds. The `log` event reports each roll:

<<< @/examples/retention.mjs#log-event

The floor is what decides a peer's fate. A client whose cursor is at or above the floor resumes and
receives only what it missed; one whose cursor fell below it is told to
[bootstrap](./sync-protocol#join-from-a-snapshot), which costs a snapshot of its scopes. So size
retention for the longest outage a client should sit out cheaply, on every node that hosts. Retention
by `days` compares stamps with this node's wall clock, so ops stamped by a peer whose clock runs far
ahead age out late, and ops from one far behind age out early; retention by `ops` is unaffected.
`retention: 'all'` never drops a segment, which keeps every past version of every record exact.

## Keep your own ops until your hosts have them

A node's own ops are the one thing no other node can hand to a host. If the laptop wrote offline for
longer than its retention and then dropped those ops, they would be gone. So a node that dials keeps
every op of its own until each enabled node it registered, in the op's scope, has acknowledged it:

<<< @/examples/retention.mjs#kept

<<< @/examples/retention.mjs#offline

`listNodes()` shows how far each registered node holds this node's own streams as `acked`, which the
host's vector sets at hello and every push answer raises. It is saved with the registry, so a restart
keeps it. Once every registered node has an op, it is retained like any other and compacted when its
segment falls outside the window.

Only registered nodes are waited for, and only those that take pushes: a node registered with
`direction: 'pull'` receives nothing from this node, so retention does not wait for it. A registered
node that is never reached holds this node's ops back until you remove it or disable it with
`enableNode(url, false)`, so remove the hosts you no longer use.

## When a host can no longer be caught up

Ops written before the first `addNode()` are retained like any others, because no host was there to
wait for. If they were compacted before a host was registered, the host lacks the start of this node's
stream and this log no longer holds it. The node reports `ALX_ERR_UNDELIVERABLE` once per hello:

<<< @/examples/retention.mjs#undeliverable

Nothing of that stream goes to that host after that, not even later writes, because the first op it
would receive is a gap there. The host gets that state only by bootstrapping from this node, which
happens only if the host itself dials it. Register a node's hosts before it writes, or give a node that
may write for long before its first sync a retention large enough to cover it.

## Restore a node from a backup

A data directory restored from an older copy has forgotten its newest ops, but its hosts have not. If
it wrote again under the old numbers, each host would take the new ops for ones it already holds. The
node notices at the next hello: the host holds more of the node's own stream than the node's log does,
and the node reports `ALX_ERR_REWOUND`:

<<< @/examples/retention.mjs#rewound

A host could claim that falsely, so the node moves its stream past the host's only on proof. The
host's answer carries the newest op of that stream it holds, and with the [signing
plugin](./signing) that op is signed by the node's own key, which no host can forge. Proven, the node
moves its stream past what the host holds, so nothing it writes next collides, and bootstraps from the
host to get back what the lost ops wrote. The error carries `local` and `remote`, what each side held
of each stream, and `adopted`, what moved.

Without proof (no signing plugin, `signatures: false`, or a host whose log no longer holds that op) the
stream stays where the node's log has it, and nothing of it goes to that host until the next hello.
`createDatabase({ sync: { rewind: 'adopt' } })` takes the host's word instead. Decide before the node
writes on that stream again: a write made meanwhile takes a number the host already holds another op
under, which every node that holds both reports as [equivocation](./operation-log#who-wrote-it-and-nothing-else-the-hash-chain).

## What compaction removes, and what it keeps

Compaction drops ops, never records: every record keeps its current state, merge metadata included, so
it goes on merging with whatever arrives later. What a dropped segment takes away is the past. Reading
a record at an earlier version folds the log, so it is exact only while the log still holds what the
record depends on; [Versions and history](./versions) explains how a reader tells, and how the undo
stack pins the segments it needs. `stats().log` shows `floor`, `segments` and `droppedTs`, the newest
stamp among the ops the log no longer holds.

## Tombstones and cleanup

A deleted record leaves a small tombstone behind, so that the deletion reaches every node and an edit
that arrives late does not bring the record back (only a newer whole-record write does). Tombstones are records, not ops, so retention
does not touch them. [Cleanup](./cleanup) folds old tombstones out of the way (a delete this node made
only once every registered node has acknowledged it), and a folded tombstone still wins over a late
write.

## Erase a record for good

Retention and cleanup leave the content of old writes in the log until its segment is dropped. When a
record must be gone now, for a right-to-erasure request or a secret written by mistake, [purge](./purge)
it. A purge wins at any stamp, nothing written after it lands, and every log entry of the record is
scrubbed: the payload and its salt are removed in place, and the header and its signature stay, so the
stream's hash chain stays whole and a peer that resumes takes each scrubbed op as the no-op it is.

<FigPurge />

## Trade-offs

A larger retention costs disk and open time on every node that hosts, and buys longer outages without
a snapshot. A dialing node may hold far more than its retention while a host is away, which is the
price of never losing a write it made offline. A small retention makes bootstraps more frequent;
`retention: 'all'` makes them rare and the past exact, at the cost of a log that only grows.

## Coming from RxDB

RxDB keeps no operation log to retain: a client that comes back pulls the documents changed since its
checkpoint, however long it was away, and the server's storage is the record of the present. syncom's
retention is the window in which a client resumes by replaying ops; past it, the client joins a
snapshot instead, which is the same data in one piece. RxDB's cleanup plugin, which removes deleted
documents after a while, corresponds to [Cleanup](./cleanup).
