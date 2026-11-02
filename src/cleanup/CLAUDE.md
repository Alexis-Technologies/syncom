# src/cleanup/CLAUDE.md — Tombstone cleanup

A tombstone's file folded into its catalog row. The rules of the core are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/cleanup/cleanup.js    @alexify/syncom/cleanup — cleanup(db, { minimumDeletedTime, runEach, awaitSync }): old, acknowledged
                          tombstones folded through [SOURCE].fold (EntryStore.fold → Catalog.fold), a timer — requires symbols.js,
                          vector.js only
```

## Rules

- **A folded tombstone still wins.** `EntryStore.fold` removes the file and pieces and keeps `{ base, deleted, v }` on the
  catalog row (`folded`; catalog FORMAT 4); a read of the id rebuilds the entry from the row (`#folded`), so a late op
  below the stamps is moot, a revival above them writes a file again, and a snapshot page hands the tombstone on. It
  runs inside the queue behind the landings. Nothing is folded before every enabled registered node acknowledged this
  node's delete (`awaitSync`); a peer's delete is theirs to deliver. `drop: true` forgets the row — documented danger.
