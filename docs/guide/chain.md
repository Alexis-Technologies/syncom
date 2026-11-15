---
title: Audit chain
description: Detect a record changed behind syncom's back with the hash-linked audit chain, validate it, run without it on relays, and use a chain on its own.
---

# Audit chain

Every write a database applies is also committed to a hash-linked chain of blocks: each block names the
hash of each record it touched and the hash of the block before it. Change one byte of a record file, or of
a block, and the check fails from there on. The chain is an audit trail for one node: it tells you that what
is on disk is what this node wrote, and lets you prove it later.

The chain is the `chain` plugin, which `@alexify/syncom/all` registers; with the lean core, pass
`plugins: [chain]` from `@alexify/syncom/chain`.

## Check the chain

<<< @/examples/chain.mjs#validate

`validate()` walks the chain backwards, hashing every block and comparing it with the hash the next block
names, until it reaches the first block. `validate({ last })` stops after that many blocks, and
`validate({ from })` starts at a block of your choice. Each block is a read, so a full walk of a long chain
is slow by construction: bound it with `last` on a hot path. `stats().chain.tail` is the hash of the newest
block, the one value to write down somewhere else if you want to prove later that nothing was rewritten.

<FigAuditChain />

## Notice a record changed on disk

A local write commits a block naming the record, the hash of its data and its position in the
[operation log](./operation-log); a page of a peer's ops, a snapshot page or a replay at open commits one
block for every record it touched. A record read from its file for the first time is checked against the
block that committed it:

<<< @/examples/chain.mjs#tampered

A record whose bytes no longer hash to what its block recorded rejects every read with `INTEGRITY`, and
stays that way. Nothing repairs it behind your back, because a file that changed under the chain is evidence
first. When you have looked, [`repair(id)`](./health#repair-a-record-that-fails-its-check) rebuilds the
record from the node's own log.

The check costs one hash per record on a cold read; a record already in the cache is not checked again.
`createDatabase({ integrity: 'lazy' })` skips the check on cold reads when you would rather not pay it.

## Run a relay without a chain

<<< @/examples/chain.mjs#off

A node that only relays ops between others, a hub, has nothing of its own to audit. `chain: false` keeps the
plugin registered and the chain off: no blocks, two file writes fewer per record, no check on reads, and
`validate()` rejects with `NO_CHAIN`. A database opened without the plugin behaves the same, and asking for
`chain: true` without it is `PLUGIN_MISSING`.

## Keep a chain of your own

<<< @/examples/chain.mjs#blockchain

`Blockchain` is the chain without a database, for an audit log of your own or for
[smart contracts](./contracts). A block is `{ prev, timestamp, data }`, its hash is the SHA-256 of that
object, and the tail is kept in `.blockchain.json` so the chain reopens without scanning. Like a database,
the constructor returns a promise: `await new Blockchain(path)`. `readBlock()` of an unknown hash rejects
with `BLOCK_NOT_FOUND`. Give each chain a directory of its own; two writers of one directory overwrite each
other's tail.

## What the chain is not

Each node's chain records the order in which that node applied things. Two nodes that hold the same
records hold different chains, which is expected: the chain is not a consensus mechanism and does not
replicate. What makes nodes agree is the [op model](./transactions-conflicts); what proves who wrote an op is
[signing](./signing). The chain proves that this node's disk holds what this node wrote.

## How big the chain grows

The chain grows by one block per local write and one per batch applied from a peer (on the files engine a
file each, on SQLite or MongoDB a row or a document each), and no block is ever removed: `validate()` walks
from the newest block to the first, so a removed block would leave everything above it unverifiable. The
[log](./retention) is compacted; the chain is not. A database written for years holds as many blocks as it
had landings. Bounding it would take a checkpoint block that vouches for every live record at a point, which
is a format change not in this version; until then, run relays with `chain: false`.

## Coming from RxDB

RxDB has no audit chain. Its `_rev` field numbers a document's revisions for conflict detection, but nothing
links them by hash, so a changed document file goes unnoticed. In syncom the chain detects it on the next
cold read, and `repair()` rebuilds the record from the log.
