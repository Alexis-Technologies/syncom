# src/cleanup/CLAUDE.md — Tombstone cleanup

A tombstone folded whole into the `tombstones` kv namespace. The rules of the core are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/cleanup/cleanup.js    @alexify/syncom/cleanup — cleanup(db, { minimumDeletedTime, runEach, awaitSync }): old, acknowledged
                          tombstones folded through [SOURCE].foldMany (EntryStore.foldMany), dropped through forgetMany
                          (EntryStore.dropMany), BATCH ids a turn of the queue; a timer stopped with the database — requires symbols.js, vector.js, telemetry/writer.js only
```

## Rules

- **A folded tombstone is the whole tombstone, elsewhere.** `EntryStore.foldMany` writes `{ type, data, meta }` — the
  collection, the data a delete carried, the normalized meta as `applyBase` left it — to the `tombstones` kv namespace
  (the key is the id) and removes the record file and its pieces in ONE write set (atomic where the engine has
  transactions; the kv put before the file on files, so a crash leaves both, the file wins, and the next rebuild takes
  the entry). The catalog row does not change: the catalog is derived from the records AND the namespace
  (`EntryStore.open` lists it before the catalog loads; `#loadCatalog` rebuilds from both). `load`/`loadMany` fall back
  to the namespace for a gone row with no file, so a late op below the stamps is moot exactly as before — watermarks
  and set slots above the delete included — a revival above them writes a file again and takes the kv entry away in
  the same write set (`writeMany`), and a snapshot page hands the tombstone on whole. Nothing is read to decide a
  sweep: the horizon from the row's `deleted` stamp, the ack check from the log's index. Nothing of this node's own is
  folded before every enabled registered node acknowledged the delete (`awaitSync`); a peer's delete is theirs to
  deliver and folds on age; an own delete the log no longer retains folds (lossless) but is never dropped under
  `awaitSync` — a node that only hosts cannot prove it was delivered. `drop: true` takes the kv entry and the row —
  documented danger.
