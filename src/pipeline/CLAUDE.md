# src/pipeline/CLAUDE.md — Pipelines

A handler over every change of a collection, once, with a checkpoint. The rules of the core are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/pipeline/pipeline.js  @alexify/syncom/pipeline — createPipeline(db, { name, source, handler }): the `transaction` events of the
                          source's records handed to the handler inside one transaction each, the turn's eventId kept in the
                          `pipeline` kv namespace, a reopen replayed from `log.since(checkpoint)` or rebuilt — requires symbols.js,
                          engine.js, hooks.js only
```

## Rules

- **Once, in order, checkpointed after the write.** A turn's batch is handled inside one transaction; the checkpoint
  (the turn's `eventId`, which the `transaction` event carries) is written after the transaction landed, so a crash
  between hands the turn over again, never skips it. A replay from the log hands the ids alone (`changes: null`);
  where the log cannot resume, every record of the source once (`rebuilt`). Reads of the target are never held up
  (RxDB's `awaitBeforeReads` was refused: a read that waits for a write that waits for the read).
