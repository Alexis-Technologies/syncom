---
title: The operation log
description: What an op is, how streams, version vectors and event ids track what each node has seen, how stamps order writes, and how the hash chain catches a fork.
---

# The operation log

The laptop has been offline all afternoon. It edited a dozen tasks; meanwhile the phone and the server
edited others, and one task on all three. When the laptop reconnects, each node has to answer three
questions about the other: what does it have that I lack, in what order do I apply it, and can I trust
that it is what its writer wrote? syncom answers all three with one structure. Every write becomes an
**op**, a small record of the change, and every node keeps its ops, and the ops it received, in an
append-only log. Replication is the exchange of the ops the other side lacks.

## What an op is

You never build ops yourself. Every call that changes a record makes exactly one, and the database's
`change` event shows each as it lands:

<<< @/examples/operation-log.mjs#change

An op describes the change, not the result: the `update()` op carries `{ done: true }`, not the whole
task, and the `inc()` op carries the amount, so increments made on two nodes add up instead of one
overwriting the other. The kind of field decides how an op merges ([Fields that merge](./fields)
explains registers, counters, sets, lists, text and trees). The log keeps each op with its position:

<<< @/examples/operation-log.mjs#op

<FigOpAnatomy />

`origin` and `seq` name the op: the node that made it and its number on that node, counted from 1.
`ts` is its stamp (below). `type` says what it does: `write` for `insert()` and `set()`, `set` for
`update()`, `unset` for `unset()`, `inc`, `add` and `remove` for counters and sets, `splice`, `assign`, `move`, `mark` and
`tree` for lists, text and trees, `delete` for a tombstone, `purge` for an erasure, `version` for a
[schema migration](./migration-schema#what-a-migration-writes). `id` is the record,
`data` the fields a `write` or `set` carries, and a field op names its field in `key` and its argument in
`value`. `v` is the [schema version](./migration-schema) of the writer, `actor` who made it when you
pass one (`createDatabase({ actor })` or a write's `{ actor }`), and `msg` a transaction's message.
`prev`, `digest`, `nonce` and `sig` hold the op to its place and its writer, as the last sections show.
Every field, payload and type code is in [Wire format](../reference/wire#the-op).

## One stream per origin and scope

The ops one node makes form its **stream**, numbered 1, 2, 3 without a hole. When you split records
into [scopes](./partial-sync), each scope gets a stream of its own, named `origin@scope`, so a node
that syncs only the `web` scope still sees every number of that stream in order:

<<< @/examples/operation-log.mjs#streams

The order inside a stream is what makes a log replicable. A receiver applies a stream's ops in `seq`
order: an op it already has is a duplicate and is dropped, and one that skips ahead is a gap, which it
also drops and receives again when the stream is read from the last position that landed. The ops a
node makes while joining another node's snapshot (`merge` and `advance`) run in a third kind of
stream, `origin@~`, which never travels back to the node the snapshot came from.

## What a node has seen: version vectors

A **version vector** maps every stream to the highest `seq` a node has applied from it. It is the
whole answer to "what do you have": a node that sends its vector lets the other side pick exactly the
ops that are above it.

<<< @/examples/operation-log.mjs#vector

When the phone receives the laptop's op and then writes on its own, its vector holds both streams:

<<< @/examples/operation-log.mjs#vectors-two

A vector says what a node has applied from anyone; an **event id** says where a reader is in one
node's log. It is `<epoch>.<seq>`, the log's own position, and it is the cursor a subscriber hands
back to resume a feed after a reconnect (wrpc carries it as the subscription's `lastEventId`). The
epoch is minted when the log is created, so a cursor from a wiped or restored directory is recognized
as foreign and the reader starts over, instead of being fed whatever happens to sit at that number.
[The sync protocol](./sync-protocol) shows both at work.

## When it happened: stamps

Two nodes that edit the same plain field without seeing each other need a rule for which value wins,
and it must be the same rule on both. syncom gives every op a stamp, `ts`, and compares the pair
`(ts, origin)`: the higher stamp wins, and when two stamps are equal the node id breaks the tie. The
pair is a total order, so every node that holds the same ops reaches the same values, whatever order
the ops arrived in.

<FigStamps />

The stamp is milliseconds since the epoch in UTC, taken from a clock that behaves like a Lamport clock
on top of the wall clock. It returns `max(Date.now(), last + 1)`, so it never repeats and never runs
backwards, and it observes every stamp the node sees: a peer's op, a joined snapshot, its own log when
it opens. A write made after a read is therefore always stamped above what it read, even when the
peer that wrote the old value has a clock an hour ahead. A local write can only lose to a write it has
not seen yet.

Clocks do not have to agree for nodes to converge, only for "last writer" to mean what a person means
by it. When two nodes write the same field concurrently, the faster clock wins on both sides; skew
changes who wins, never whether they agree. Keep clocks synced with NTP if that matters to you. A
stamp more than `sync.maxSkew` ahead of the receiver's clock (24 hours by default) is a broken clock
rather than a concurrent write: the op is refused as malformed and reported with `SKEW`, and the
receiver's clock never observes it.

## Who wrote it, and nothing else: the hash chain

An op's **fingerprint** is the SHA-256 of its header: origin, seq, stamp, type, record, scope,
version, actor, message, `prev` and, on a signed op, the digest of its payload. Every op names the fingerprint
of the op before it in its stream as `prev`, so each stream is a hash chain:

<<< @/examples/operation-log.mjs#chain

<FigHashChain />

The chain is what catches a writer that made two different ops under one number: a directory restored
from an older copy, a second instance running under the same identity, or a key holder that lies.
Without it, two hosts holding different ops at `mallory:3` would each think the other's op is a
duplicate, and the records would differ for good with equal vectors. With it, a node that holds one
op at a seq and is handed another, or is handed an op whose `prev` is not the fingerprint it holds
before it, refuses it and reports `EQUIVOCATION` with both fingerprints. Each node keeps the branch it
took first and never mixes the two. The chain detects a fork; it does not heal one, and the writer's
identity is the one to retire.

With the [signing plugin](./signing) the node id is an Ed25519 public key and every op is signed over
its header, so no relay can change an op, its payload or its place in the chain without the op being
refused as forged. Without signatures the fingerprint covers the header alone, which still tells a
restored copy's op from the original by its stamp, but not two ops that differ only in payload. [Wire format](../reference/wire#the-per-stream-chain)
has every verdict.

## How a write reaches the log

A write goes through the database's mutation queue: the op is checked against the field's kind,
stamped, run through the validator, signed, and appended. The append reserves the op's `seq` at once and frees the
queue for the next write, while the disk is written outside it. Appends that arrive while one group
is being written join the next group, so a burst of writes costs one log write, not one per op
(group commit). Once the op's group is on disk, its record file is written and the events fire, in log
order.

<FigWritePath />

Log first, then the record, is what makes a crash safe: if the process dies after the append and
before the record file, the next open replays the log's unsealed tail onto the records. The append
is the commit point, so a write whose record file then fails still stands and replicates; the database
keeps the record in memory and reports `UNPERSISTED`. By default record files wait up to 16 ms
(`createDatabase({ defer })`) so that several writes to one record land as one file write; the log
itself is durable at once.

## Where the log lives, and how big it gets

Under the default files engine the log is the `log/` directory of the database: a journal of open
groups, sealed segments rolled from it every 64 groups (`sync.log.rollAfter`), and an index. Every
log file carries a CRC-32 of its entries, checked before anything is parsed, so a torn or altered file
is detected at open instead of read in part. The native engines (IndexedDB, SQLite, MongoDB, memory)
keep the same entries in a store of their own. `stats().log` reports where the log stands:

<<< @/examples/operation-log.mjs#stats

The log does not grow for ever. It keeps at least `sync.retention.ops` ops (10 000 by default) and
drops whole sealed segments from the front beyond that, moving `floor` up; a node that dials keeps its
own ops longer, until the nodes it syncs with have them. [Retention and
acknowledgements](./retention) explains the rules and what happens to a peer that was away too long.
The files, entries and index are specified in [Wire format](../reference/wire#the-log).

## Trade-offs

Every write costs a log entry next to the record, signed and hashed when the signing plugin runs, and
the log takes space up to its retention. The log is also what you gain: an audit trail of who wrote
what (`actor` on every op), the past of a record ([Versions and history](./versions) folds it out of
the log), and a sync that needs no server-side diffing. Retention bounds both: the history you can read
back and the outage a peer can sit out without a full snapshot.

## Coming from RxDB

RxDB keeps the current document with a revision (`_rev`) and a last-write time, and replicates by
checkpoint: the newest state of each changed document since a position. syncom keeps the ops that
produced the state, so concurrent edits to different fields of a record both survive and counters add
up, and a node's position is a version vector rather than a single checkpoint. There is no revision
to send back with a write and no conflict handler to write; see [Transactions and
conflicts](./transactions-conflicts).
