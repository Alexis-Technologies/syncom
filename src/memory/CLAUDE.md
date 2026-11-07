# src/memory/CLAUDE.md — The backend and the engine in memory

`memory()` is an fsi over a Map; `memoryEngine()` the engine contract over Maps. The engine contract and the rules of the core are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/memory/memory.js      @alexify/syncom/memory — memory(), the backend in memory (a Map of dir/name to text; size, dump, the exclusive
                          create, append), and the engine's export — requires engine.js only
src/memory/engine.js      memoryEngine(): the engine in memory — a record as the object it was handed, the pieces and a tag's copies by
                          name, kv namespaces of texts, the op log as rows (a sealed range is a segment, nothing is written), the
                          catalog's rows kept as they are (`db.catalog`); one database per path until remove(path) — requires
                          engine.js, blobs.js, errors.js only
```

## Rules

- **Objects, not texts.** The memory engine keeps what a write set hands it — `stored` as it is, the log's entries as
  the very objects `OpLog` holds — so nothing is stringified or parsed on the way in or out, and a scrub that strips an
  op in memory has stripped it here. That is why nothing of the core may change a stored object in place: `EntryStore`
  copies a meta at its first block in pieces (`#assemble`), and a data object is never changed after a write
  (src/CLAUDE.md). `records.raw(id)` stringifies on demand (a tag's copy).
- **A path outlives its instance.** `open(path)` answers the same database until `remove(path)`: a reopen through the
  same engine reads what the last instance wrote, which is how a test reopens a database in memory and how a mesh in one
  process shares one engine, a path per node. The index is saved as a copy (the log's vector is a live object).
- **Every write set is announced.** `db.changes.subscribe(listener)` hears `{ records: ids }` — the rows put and the
  ids removed by a write set — on a microtask after it, on every instance that listens: the writer never listens (a
  follower alone subscribes, `createDatabase({ readOnly: true })`), so there is nothing of its own to leave out, unlike
  the IndexedDB engine's token. `capabilities.changeStream` is true. The log's groups are not announced: a follower
  reads records whole.
- **Blobs are copies.** `blobs` keeps a Uint8Array per digest and answers a copy (`slice()`): what a caller changes after a put
  or a get is not in the store, as the engine suite asks of every engine.
