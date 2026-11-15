---
title: Devtools
description: See what a record is made of with inspect(), field by field and op by op, and hand a case over with anonymize() without giving the data away.
---

# Devtools

When a record does not read the way you expect, you want to see what it is made of: which kind each field
is, who wrote it last, which ops the log holds for it. `@alexify/syncom/inspect` lays a record out raw, and
when you report the case to someone else, it makes a copy with every word hashed out and the structure
intact.

## See what a record is made of

<<< @/examples/devtools.mjs#inspect

`inspect(db, id)` reads one record without the lens or the hooks and writes nothing. What it answers:

- `present`, `alive` and `encrypted`, the reset stamps `base`, `deleted` and `purged`, and `v`, the schema
  version the record was written under.
- `data`, the record in the op model's terms (every path a field of its own), and `reading`, the record as
  `get()` would compose it.
- `fields`, sorted: a register with its `stamp` (`[ts, origin]`), a counter with its `sums` per stream, a set
  with how many `elements` it holds and how many are `live`, a list or a text with its newest stamp and how
  many `runs`, `cuts` and `marks` it carries, a tree with its `nodes` and `moves`. `reachable` says whether
  the reading shows the field: a field under a list element that is not shown is kept but not read.
- `log`, every retained entry of the record: `seq` and `eventId`, the op's `type`, `origin` and its
  sequence number in its stream (`stream`), `ts`, `scope`, `field`, `actor`, `message`, and whether it is
  `signed`, `skipped` (a hook or a validator left it unapplied here) or `scrubbed` (a [purge](./purge) took
  its payload).

Typical questions it answers: why a field did not merge the way you thought (it is a register, not a
counter, because the first write was `update()`), why a text grew heavy (thousands of runs, time for
[`compact()`](./health#rewrite-a-record-that-has-grown)), or why a peer's write is missing (the log has it
as `skipped`, so a `beforeApply` hook refused it). An encrypted record shows its data and no metadata,
since it has none that replicates.

`inspect()` says what one record is. For how the whole node is doing, read [`stats()`](./health) and the
[telemetry](./telemetry); for why a query is slow, [`indexAdvisor()`](./query-optimizer) from the same
subpath.

## Hand a case over

A bug report wants the shape of your data, not the data. `anonymize(value, options)` copies anything JSON,
a report, a snapshot page, an op, a whole export, with every string replaced by a stable hash:

<<< @/examples/devtools.mjs#anonymize

The same id, origin or word reads the same everywhere in the copy, so the structure of the case survives:
which ops touched which record, which node wrote which field. Keys are hashed too by default, because a
set's elements, the origins of a counter and the streams of a vector are keys; `keys: false` keeps them,
which keeps field names readable. Numbers, booleans and nulls stay as they are, since counts, stamps and
lengths are the shape.

Without a `salt`, each call takes a fresh random one. Give the same salt to line two copies up, and keep it
to yourself:

<<< @/examples/devtools.mjs#salt

This is pseudonymization, not anonymization. The hash is two xxHash32, 64 bits, and is not cryptographic:
whoever holds the salt can find a short or guessable string again by trying candidates. Hand over the copy,
never the salt.

## Coming from RxDB

RxDB's dev-mode plugin checks your calls and schemas while you develop. syncom has no mode to switch on
([Development mode](./dev-mode) explains why); `inspect()` is the tool for the other half of debugging:
looking at what a record holds and how it got there.
