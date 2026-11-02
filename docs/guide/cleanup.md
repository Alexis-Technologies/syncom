# Tombstone cleanup

A deleted record keeps a tombstone: its file, with the stamps that keep it dead, so a late op from a peer
stamped below them stays moot and a snapshot hands the deletion on. Over years the tombstones are most of
the files. `@alexify/syncom/cleanup` folds the file of an old one into its catalog row.

```js
const { cleanup } = require('@alexify/syncom/cleanup');

const sweeper = cleanup(db, { minimumDeletedTime: 31 * 24 * 60 * 60 * 1000 });
await sweeper.run();  // { folded, dropped, skipped }
sweeper.start();      // a sweep every runEach ms (five minutes)
sweeper.stop();
```

A sweep folds every tombstone deleted `minimumDeletedTime` ago or more (31 days by default): the record's
file and pieces are removed, and the stamps that keep it dead — the reset watermark, the tombstone's
stamp, the writer's version — ride on the catalog row. A read of the id rebuilds the tombstone from the
row, so:

- a peer's op stamped below the tombstone is still moot;
- a write above it revives the record and writes a file again;
- a snapshot page hands the tombstone on, as it did;
- a reopen reads the folded row (the persisted catalog's format 4 carries the stamps).

## When a tombstone is safe to fold

With `awaitSync` (true by default) a tombstone whose delete this node made is folded only once every
enabled registered node acknowledged the delete op — `node.acked` against the op's seq, what the sync
manager keeps per node. A tombstone a peer made is theirs to deliver and folds on age alone. A node
that is disabled is left out: it bootstraps from a snapshot when it comes back, and a snapshot carries
a folded tombstone.

`run({ drop: true })` takes the folded rows away as well. Then a late op on the id makes a new record,
and a peer that never saw the deletion keeps its copy: the documented danger, never the default.

`leader` is kept for a database shared by several instances; here every instance sweeps. A failed sweep
on the timer is logged as `cleanup.failed`.
