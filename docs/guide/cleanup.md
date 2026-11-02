# Tombstone cleanup

A deleted record keeps a tombstone: its file, with the stamps that keep it dead, so a late op from a peer
stamped below them stays moot and a snapshot hands the deletion on. Over years the tombstones are most of
the files. `@alexify/syncom/cleanup` folds an old one whole into the `tombstones` kv namespace.

```js
const { cleanup } = require('@alexify/syncom/cleanup');

const sweeper = cleanup(db, { minimumDeletedTime: 31 * 24 * 60 * 60 * 1000 });
await sweeper.run();  // { folded, dropped, skipped }
sweeper.start();      // a sweep every runEach ms (five minutes)
sweeper.stop();
```

A sweep folds every tombstone deleted `minimumDeletedTime` ago or more (31 days by default) — the stamp is on
the catalog row, so nothing is read to decide: the whole tombstone — its collection, the data the delete carried, its
meta — is written to the `tombstones` kv namespace and the record's file and pieces are removed, in ONE write set
(atomic where the engine has transactions). The catalog row stays; a read of the id finds the tombstone in the
namespace, so:

- a peer's op stamped below the tombstone is still moot — below a field unset or a set element removed above the
  delete too;
- a write above it revives the record, writes a file again and takes the kv entry away in the same write set;
- a snapshot page hands the tombstone on whole, as it did;
- a reopen reads it, and so does a rebuild of the catalog (other indexes, collections added after the open, a lost
  catalog file): the catalog is derived from the records and the tombstones alike.

On the files engine a folded tombstone is still one file (`tombstones/<id>`), smaller than the record's and read
without a chain check; on a row store (SQLite, IndexedDB, MongoDB) it is a kv row beside the records. A folded
tombstone has no chain block.

## When a tombstone is safe to fold

With `awaitSync` (true by default) a tombstone whose delete this node made is folded only once every
enabled registered node acknowledged the delete op — `node.acked` against the op's seq, what the sync
manager keeps per node. A tombstone a peer made is theirs to deliver and folds on age alone. A node
that is disabled is left out: it bootstraps from a snapshot when it comes back, and a snapshot carries
a folded tombstone. A delete of this node's own that the log no longer retains folds — nothing is lost by a
fold — but is never dropped under `awaitSync`: a node that only hosts cannot prove the delete reached anyone.

`run({ drop: true })` takes the kv entry and the catalog row away as well. Then a late op on the id makes a new
record, and a peer that never saw the deletion keeps its copy: the documented danger, never the default.

Folds and drops go a hundred ids a turn of the mutation queue, one write set each. `leader` is kept for a database
shared by several instances; here every instance sweeps. `start()` runs a sweep every `runEach` ms until `stop()`
or the database closes; a failed sweep on the timer is logged as `cleanup.failed`.
