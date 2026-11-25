---
title: Purge
description: Erase a record for good on every replica, see why a purge wins over any write, what stays in the log, and where a purge cannot reach.
---

# Purge

`delete()` is not erasure. A deleted record leaves a tombstone, and its history stays in the log, because
that is what lets a node that was away catch up. When a record must be gone for good (a user exercising the
right to erasure, a secret pasted into the wrong field) you purge it: the record disappears on this node,
and the purge travels to every replica and erases it there too, including the payload of every op that ever
wrote it.

## Erase a record everywhere

<<< @/examples/purge.mjs#purge

`purge(id)` makes a `purge` op and scrubs the record from this node: its file, its catalog row, its copies
in every [tag](./versions#name-the-whole-database-with-a-tag), and the payload of every entry of it in the
log. Every node that receives the purge does the same, and so does a node that hears of it later: one that
was offline, one that bootstraps from a snapshot taken after it, or one that receives an older op of the
record afterwards. A purged record is listed nowhere and reads as `null`, at a tag too, and a live
[document](./document) of it reads `null`. Pass `actor` to record who asked for it.

To purge every record of a collection, `db.<Collection>.remove({ purge: true })` does it in one call.

<FigPurge />

## Why a purge wins at any stamp

The phone edits a customer while offline, a moment before the server purges it:

<<< @/examples/purge.mjs#wins

A purge wins over every other op, older or newer, from any node: the phone's edit arrives after the purge
and changes nothing. Without that rule, a concurrent edit, or one made by a node that has not heard of the
purge yet, would bring the record back. The id stays purged for good: a later write to it is accepted and
changes nothing, an `update()` rejects with `ALX_ERR_NOT_FOUND`, and new data belongs under a new id.

## What stays behind

<<< @/examples/purge.mjs#stays

A purge removes content, not the fact that ops happened. Each log entry of the record keeps its header (the
origin, sequence number, stamp, type, record id), its signature and its digest, and loses its data, its
metadata and the nonce that salted its digest. That keeps every node's [version vector](./operation-log)
whole, so a peer resuming through those ops sees no gap, and the header of a [signed](./signing) op still
verifies. Without the nonce, the digest cannot be used to guess a short payload by trying candidates.

The [audit chain](./chain) keeps only hashes, never record content. [`history()`](./versions) still lists the
record's ops, the purge among them, with `data: null` and `scrubbed: true`, and a read at a version before
the purge rejects with `ALX_ERR_HISTORY_GONE` and `reason: 'scrubbed'`.

## Forget a record on one node only

`purge()` is for erasure everywhere. To drop a record from one node without telling anyone, as a node does
with records of a [scope](./partial-sync) it lost access to, use `forget(id)`:

<<< @/examples/purge.mjs#forget

`forget()` makes no op: the record's file and catalog row go, its log entries are scrubbed and flagged, and
nothing reaches a peer. A later op of the record from a peer makes it again.

## Limits

- Scrubbing rewrites a log file in place, and a crash in the middle can tear it; a peer resuming through a
  torn file bootstraps instead. `purge()` is idempotent, so run it again after a crash.
- A purge reaches every node it can sync with. What a node that never comes back holds, and what is in a
  [backup](./backup) or an [export](./import-export) taken before, is out of its reach: purge those copies
  yourself or let them expire.
- An evidence copy of a corrupted log file under `log/corrupt/` that names the id is removed, since it does
  not read and nothing can be stripped from it; a sealed segment that does not read whole keeps the payload
  until it is compacted away (the `log.segment.unscrubbed` warning names it).

## Coming from RxDB

An RxDB `remove()` marks the document deleted and replicates the deletion, and the cleanup plugin later drops
the tombstone; replicated copies and the server's own history are the server's business. A syncom purge is
the erasure itself, carried to every replica by the same log that carries writes, and it outranks any write
still on its way.
