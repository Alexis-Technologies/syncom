---
title: Pipelines
description: Derive one collection from another with createPipeline(), in order, at least once per change, and resumed from a checkpoint after a restart.
---

# Pipelines

Some data is computed from other data: an activity feed from the tasks that were closed, a search index from the
text of every note, a total per customer from the orders. Recomputing it on every read is slow, and updating it
from a `change` listener loses updates when the app closes between the write and the listener. A pipeline runs a
handler for every change of one collection, in order, and remembers how far it got, so it picks up exactly where
it stopped, whatever happened in between.

## Derive one collection from another

<<< @/examples/pipeline.mjs#create

`createPipeline(db, { name, source, handler })` describes the pipeline; `start()` runs it. The handler gets the
ids of the source's records that changed and a transaction to write through. Everything it writes through `tx`
lands together or not at all, so the derived collection never holds half a batch.

<<< @/examples/pipeline.mjs#write

`awaitIdle()` resolves once the handler has caught up with every write made so far, which is what a test waits for.
The app usually does not wait: the Activity record appears a moment after the task changes, and a
[query watch](./query) on Activity sees it arrive.

Changes from every source go through the pipeline: local writes, transactions, ops from a peer, a snapshot joined
at bootstrap. A task closed on another device produces an Activity record here too.

## What the handler receives

<<< @/examples/pipeline.mjs#batch

Each batch carries `ids` (each changed record once), `changes` (what each write did, in order), the turn's
`eventId` in the log, and two flags. `replay` is true when the batch comes from the log at start rather than from
a live write, and then `changes` is `null`: read the records you need. `rebuilt` is true when the pipeline had no
checkpoint to resume from and hands over every record of the source once, as it does on its very first start.

Write the handler so that running it twice for the same records gives the same result. The pipeline hands each
change over at least once and never skips one, so after a crash a batch can come again. Deriving by id, as the
`done.<id>` records above do, makes that free.

## Restart without missing a change

<FigPipeline />

After the handler's transaction has landed, the pipeline stores the batch's `eventId` as its checkpoint. On the
next `start()`, it replays the turns the log holds since that checkpoint before it follows live writes:

<<< @/examples/pipeline.mjs#restart

The task written while no pipeline was running is handed over on start. If the log can no longer resume from the
checkpoint (it was [compacted](./retention) past it, or the checkpoint is unreadable), the pipeline rebuilds:
every record of the source once, with `rebuilt: true`. Because the checkpoint is written after the transaction, a
crash between the two hands the turn over again rather than losing it.

A replay or a rebuild goes 500 records per batch, one transaction each, and writes the checkpoint after the last
batch. Live writes that arrive while the handler is busy are merged into the one batch waiting (up to 500 ids),
so a burst of writes becomes a few handler calls, not one per write.

## When the handler throws

<<< @/examples/pipeline.mjs#failure

A handler that throws stops the pipeline before that batch. The checkpoint stays where it was, the database emits
an `error` with code `PIPELINE_FAILED` (with the cause), the error is kept in `pipeline.errors` (the newest twenty),
and `stopped` becomes true. Nothing more is handed over until you call `start()` again, which hands the failed
batch over first. Fix the cause (a service that was down, a bug) and start the pipeline again; a retry loop with
backoff around `start()` is yours to write if you want one.

## What to derive into

Write the result into another collection. A handler that writes to its own source collection makes a new change of
that collection, which comes back to the handler as another batch.

Reads of the derived collection never wait for the pipeline. Right after a write, the derived records may not be
there yet; when you need them, `await pipeline.awaitIdle()` first.

`stop()` stops following; whatever is queued waits for the next `start()`. `idle()` tells you whether anything is
queued or running.

## Limitations

- A pipeline runs in the process that started it. Every instance that opens the database and starts the pipeline
  runs it, so in an app with several tabs over one database, start it in the [leading tab](./leader-election)
  only. The `leader` option is accepted but does not elect anything yet.
- A batch is one transaction, so a handler that calls a slow service holds that transaction open meanwhile. Fetch
  first, then write.
- The handler sees only the source collection. To derive from two collections, run two pipelines into the same
  target.

## Coming from RxDB

The shape is the same as RxDB's pipelines: a handler per batch of changes, a checkpoint, at-least-once delivery.
The differences are in what the handler gets (ids and changes, with a transaction for its writes) and in reads:
RxDB holds reads of the destination while a batch runs, which syncom does not, because a read that waits for a
write that waits for a read can deadlock.

::: code-group

<<< @/examples/pipeline.mjs#create [syncom]

<<< @/examples/rxdb/pipeline.mjs#create [RxDB]

:::

<FromRxdb page="rx-pipeline" :rows="['pipeline']" />

Every option and member is in the [reference](../reference/api#pipeline-subpath).
