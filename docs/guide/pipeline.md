# Pipelines

`@alexify/syncom/pipeline` runs a handler over every change of a collection, in order, at least once — a derived
collection, a running total, an index kept somewhere else.

```js
const { createPipeline } = require('@alexify/syncom/pipeline');

const totals = createPipeline(db, {
  name: 'totals',
  source: 'Order',
  async handler({ ids }, tx) {
    for (const id of ids) {
      const order = await tx.get(id);
      if (order !== null) await tx.set(`total.${order.customer}`, { $type: 'Total', amount: order.amount });
    }
  },
});
await totals.start();
```

Of every turn of the database that changed a record of `Order` — a write, a transaction, a peer's page,
a joined snapshot — the handler gets `{ ids, changes, replay, rebuilt, eventId }`: the records that
changed (each once), their changes, and the turn's log position; `tx` is one transaction the handler
writes through, so the derived writes land whole, or not at all.

## The checkpoint

After the handler's transaction landed, the turn's `eventId` is written to the `pipeline` kv namespace
under the pipeline's name. `start()` reads it back: the turns the log holds since it are replayed first
(their ids, `replay: true`, `changes: null` — a replay reads the records), then the live turns follow.
Where the log cannot resume from the checkpoint — compacted past it, another epoch, or no checkpoint
yet — every record of the source is handed over once (`rebuilt: true`). A replay or a rebuild hands
500 records over per batch, one transaction each, and writes the checkpoint after the last page — a
failure in the middle starts it over at the next `start()`. A crash between the transaction and the
checkpoint hands the turn over again; nothing is skipped.

A turn that comes while another is handled joins the one waiting behind it — the ids each once, every
change in order, the newer position — up to 500 ids, so however slow the handler, one live batch waits at
a time and a burst of writes is one turn of the handler.

A handler that throws stops the pipeline before the turn: the error is kept (`pipeline.errors`, the newest twenty),
the database's `error` event carries `PIPELINE_FAILED` (`name`, `eventId`, `cause`), the log line `pipeline.failed`
says so, the checkpoint stays, and nothing is handed over until `start()` — which hands the failed turn over again.
A turn is handled at least once and never skipped; a handler is written to be idempotent for that reason. `stopped`
says whether the pipeline follows nothing now; `idle()` whether anything is queued or running; `awaitIdle()` resolves
once nothing is; `stop()` stops following (what is queued waits for the next start).

## What to derive into

A handler's write to the source collection is another turn, handed over again: derive into another
collection. Reads of the target are never held up — RxDB's `awaitBeforeReads` was refused, a read that
waits for a write that waits for the read. `leader` is kept for a database shared by several instances;
here every instance runs the pipeline.
