# src/pipeline/CLAUDE.md — Pipelines

A handler over every change of a collection, at least once, in order, with a checkpoint. The rules of the core are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/pipeline/pipeline.js  @alexify/syncom/pipeline — createPipeline(db, { name, source, handler, leader }): the `transaction` events of the
                          source's records handed to the handler inside one transaction each, the turn's eventId kept in the
                          `pipeline` kv namespace, a reopen replayed from `log.since(checkpoint)` or rebuilt; a failure stops it
                          before the turn — requires symbols.js, engine.js, errors.js, hooks.js only
```

## Rules

- **At least once, in order, never skipped; checkpointed after the write.** A turn's batch is handled inside one
  transaction; the checkpoint (the turn's `eventId`, which the `transaction` event carries) is written after the
  transaction landed, so a crash between hands the turn over again, never skips it. A handler that throws STOPS the
  pipeline before the turn (`halt`): the checkpoint stays, the database's `error` event carries `ALX_ERR_PIPELINE_FAILED`
  (`name`, `eventId`, `cause`), `errors` keeps the newest twenty, and `start()` hands the turn over again — the
  checkpoint never moves past a turn the handler did not finish. A replay from the log hands the ids alone
  (`changes: null`); where the log cannot resume, every record of the source once (`rebuilt`) — both `PAGE` (500) ids
  per batch (`paged`), one transaction each, the checkpoint after the last page alone (`final`): a failure in the
  middle starts the replay over. A live turn that comes while one is handled joins the live batch waiting (`push`:
  the ids each once, the changes in order, the newer `eventId`) while it holds under `PAGE` ids — one live batch waits
  at a time. A checkpoint that does not parse is `pipeline.checkpoint.unreadable` and a rebuild. The source of a
  change is its row's collection — a tombstone's row keeps it — or, of a purge, the change's `type`. Reads of the
  target are never held up (RxDB's `awaitBeforeReads` was refused: a read that waits for a write that waits for the
  read).
- **Under `leader`, the leading instance alone, and nothing of `/shared` required.** `leader` is what `openShared()`
  answers, duck-typed (`db`, `isLeader()`, `live()`), `db` its instance: `start()` subscribes through `live()`, whose
  `make(db)` runs at once and at every change of instance — where the instance leads it binds that database (its kv
  namespace, its seam, its logger: `bind`) and follows it from the checkpoint the engine's kv holds, so the next
  leader resumes where the last one left; the stop it answers marks the binding `gone`, takes its listener off and
  drops its queued batches. `live()` calls the old stop a microtask AFTER the new `make`, so nothing is shared
  between two bindings but the queue (each item carries its binding) and `bound` moves only to the newest. A batch
  of a binding let go of that fails is nobody's to tell (no `ALX_ERR_PIPELINE_FAILED`): the next leader hands the turn over —
  at least once, as after a crash. A started pipeline on a follower is not `stopped`: it waits for the lead.
