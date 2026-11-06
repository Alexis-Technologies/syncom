# src/connector/CLAUDE.md — Connectors

A collection kept in step with a backend of its own through two handlers. The rules of the core are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/connector/connector.js @alexify/syncom/connector — replicate(db, { name, collection, pull, push, live, retryTime, batchSize,
                          modifier, resolve }): pulled documents landed as one transaction a page (`source: connector:<name>`), the
                          collection's turns pushed as rows with what the backend was assumed to hold, conflicts the backend wins,
                          the checkpoint `{ pull, pushed }` in the `connector` kv namespace — requires symbols.js, engine.js,
                          shape.js, errors.js, hooks.js, emitter.js only
```

## Rules

- **A pull is a write of this node; an echo is no write.** What the backend hands over lands through `db.transact`
  as `set`/`delete` stamped here — a pulled record reaches every peer like a local one, and the backend never sees
  an op or a meta — under `source: 'connector:<name>'`, which the connector's own `transaction` listener passes
  (never pushed back). A document that reads as the record already does (`same` over the canonical JSON, `$type`
  left out) makes no op: that is how this node's own writes, come back from the backend, make no echo and no
  stamp; a hash table of what was pushed would be lost at a restart. `$type` never leaves (`plain`) and is laid
  back on what comes in. A pulled document that is no document (`documentOf`: an id, an object or `deleted`) is
  said (`connector.document.malformed`) and left out, never the page.
- **A push follows the turns and assumes the backend's state.** Every `transaction` event but this connector's own
  pulls hands the records of the collection it changed (the row's type, a purge's `type`) to `#pending`; one push is
  in flight at a time, `batchSize` rows a call, a row `{ id, data, deleted, assumed }` — `assumed` the backend's state
  as this node last knew it (what came in a pull, what went out in a push, what a conflict said), for a
  compare-and-set backend. The log position taken BEFORE the rows are read is what `pushed` moves to after the push:
  a restart pushes `log.since(pushed)` — the collection's records those entries touched — or every record of the
  collection once where the log cannot resume (`connector.rebuild`; tombstones not among them). A conflict the
  handler answers (the row as the backend holds it) is the backend's win: the record is set to it here under
  `source: 'connector:<name>:resolve'` — a turn the connector hears, so a `resolve` that answers something else goes
  back to the backend with the backend's state as `assumed`. A handler that throws is told (`error`,
  `REPLICATION_FAILED` with `direction`), kept (`errors`, the newest twenty) and tried again after `retryTime`;
  nothing is skipped and no checkpoint moves past it. A pull whose checkpoint does not move while it answers full
  pages is asked `MAX_STALLS` times, then left to the stream.
- **Live is the backend's stream or a timer, never a hook on the peers.** `pull.stream(emit)` hands pages or
  `'RESYNC'`; without one a live connector pulls every `retryTime`. `cancel()` is for good (the stream stopped, the
  listener off, what is in flight awaited, the waiters rejected); `reSync()` pulls and pushes again. Under `/shared`
  the leader runs the connector (`leader` is the plan's; not here yet).
