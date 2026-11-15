---
title: Engine performance
description: How syncom's storage engines compare on inserts, updates, reads and opening, what each benchmark row measures, and what it means when you pick a storage.
---

<script setup>
import BenchEngine from '../.vitepress/theme/components/BenchEngine.vue';
</script>

# Engine performance

The same database runs on several [storages](./storage), and the code above the storage is the same on every one
of them: the op log, the catalog, the queries, sync. What changes is what a write and an open cost. This page
shows syncom's own benchmark of the engines side by side, says what each row measures, and what the numbers
mean when you choose a storage. How syncom compares with other libraries is on [Benchmarks](./benchmarks).

## The engines side by side

<BenchEngine subject="engines" />

Every number comes from `bench/engines.js`, recorded in `bench/results/engine.json` and drawn by the chart; the
machine, the Node.js version and the date are under it. Read the numbers as relative guidance: the order of the
engines and the size of the gaps carry over to other hardware, the exact figures do not. The other buttons of
the chart are the rest of syncom's benchmarks, from the whole Database API to the hash behind the chain.

## What each row measures

`bench/engines.js` opens one database per engine through `@alexify/syncom/all` with `chain: false` and
`sync: { signatures: false }`, the way a hub that only replicates would run, so that the rows measure the storage
and not SHA-256 or Ed25519. The records are small: four short fields. Each engine gets the same five rows.

- **insert**: one new record, awaited, through the whole write path. The op is appended to the log, then the
  record lands within the [deferred window](./performance-tips#let-the-defer-window-merge-writes-to-one-record)
  of 16 ms. An insert also asks the engine whether a record already holds the id.
- **update, one field**: a field written on a record that is in memory, awaited.
- **get, cached**: a read that the cache answers. The engine is not asked, so this row is the same on every
  engine and shows what the layer above the storage costs.
- **transact, 1000 inserts**: a thousand inserts in one [transaction](./transactions-conflicts), counted per
  insert: one group in the log and one write set for the engine.
- **open, 10,000 records**: one cold open of a database that holds ten thousand records. The open reads the
  catalog back (or rebuilds it) and loads the retained log; [Faster open](./open-cost) explains both.

The update and get rows run on the database that the insert row just filled, so it holds more records on a
faster engine. The IndexedDB row runs under Node.js on `fake-indexeddb`, an IndexedDB written in JavaScript that
keeps everything in memory: it measures syncom's IndexedDB engine and that implementation, not a browser's
IndexedDB. MongoDB is measured only over the real driver, when `MONGODB_URL` names a replica set; the committed
results do not include it.

## What the numbers say

**Memory is the fastest at everything that touches the storage.** In the recorded run an insert took about
15 µs on the [memory engine](./storage-memory) against about 135 µs on the files engine, and opening ten thousand
records about 5 ms against 25 ms. It keeps records as the objects it was handed and the log as rows, so no JSON
text is made, written or parsed. Nothing survives the process.

**SQLite inserts about twice as fast as the files engine and opens a little slower.** An insert on
[SQLite](./storage-sqlite) took about 66 µs, and the pace held inside a transaction (about 63 µs per insert):
every write set is one SQLite transaction in one file, where the files engine writes a file per record. Opening ten thousand records took about 33 ms
against the files engine's 25 ms.

**The files engine is the baseline.** It is the default in Node.js ([Filesystem](./storage-filesystem)), writes
each record as a JSON file and the log as journal lines, and inside a transaction it still writes a file per
record (about 114 µs per insert), so grouping saves log writes but not record files.

**The IndexedDB engine writes at about the files engine's pace here and is the slowest to open** (about 67 ms for
ten thousand records). Treat that row as a measure of the code path, for the reason above.

**A cached read costs the same everywhere,** about 20 µs, because the cache in front of every engine answers it.
Queries behave the same way: the catalog and the indexes are in memory on every engine, so a query reads the
storage only for records that are not cached. What you read often should fit in the cache
([Performance tips](./performance-tips#fit-the-cache-to-your-working-set)).

Two other subjects of the chart help with the choice. **Database** runs the whole API on node:fs with the chain
and signing on, and includes the one layered row: an insert over a memory layer above node:fs, written back from a
queue ([Memory over disk](./storage-layered)), took about 240 µs against 173 µs on node:fs alone. **Write path**
runs small writes on a record already in memory: an awaited counter increment took about 7 µs over the
`memory()` backend and about 24 µs over node:fs, which is what the disk adds to a small write.

## Choose a storage

In a browser the choice is between [OPFS](./storage-opfs), the default, and [IndexedDB](./storage-indexeddb).
The repository has no browser measurement of either, so pick by behavior: IndexedDB when several tabs open one
database or a database holds many records, OPFS otherwise. [Browser storage compared](./browser-storage) and
[IndexedDB performance](./slow-indexeddb) go through the trade-offs.

In a Node.js app or a command-line tool, start with the files engine: it needs nothing, its files are readable,
and a crash loses nothing that was logged. Move to SQLite when write throughput matters or you want the database
in one file, at the price of a slightly slower open. A server with several instances over one database, or
read-only followers, wants [MongoDB](./storage-mongodb), which these rows do not measure. Tests, server-side
rendering and caches that can be rebuilt want memory.

## Measure your own workload

The rows above are small records on one machine. Your records, your indexes and your options (the chain,
signing, hooks) change the numbers, so time the operations your app does on the storages you are choosing
between:

<<< @/examples/storage-performance.mjs#measure

In a running app, `db.stats().engine` counts the write sets the engine took (`writes`), the ones that failed and
the milliseconds they spent (`ms`); [Health and maintenance](./health) covers the rest of `stats()`.

## Run the benchmarks yourself

```bash
pnpm bench engines                    # the engines side by side, printed
MONGODB_URL='mongodb://localhost:27017/?replicaSet=rs0' pnpm bench engines   # MongoDB too, over the driver
pnpm bench --save                     # every subject, written to bench/results/engine.json
pnpm bench --save engines             # this subject only; the others stay as they were
pnpm bench:report                     # the generated tables and images of Benchmarks and the README
```

`pnpm bench engines` also prints, untimed, how many transactions SQLite and IndexedDB take per awaited insert.
`pnpm bench` alone runs every subject, one process each. The chart on this page reads
`bench/results/engine.json` when the site is built, so a saved run shows here without `pnpm bench:report`.

## Limitations

- **One machine, Node.js only.** No row runs in a browser, so OPFS and a real IndexedDB are not measured.
- **Small records.** Large texts, lists and trees have their own subjects in the chart (Lists and text, Trees).
- **No MongoDB in the committed results.** Run the command above against a replica set to see it.

## Coming from RxDB

RxDB's storage page compares its storages (several of them Premium) in milliseconds for bulk and serial inserts,
finds and counts, in the browser and in Node.js, and it does publish browser numbers, which syncom does not have
yet. syncom's chart compares engines under the same database code, and it matters less which engine answers a
query: the indexes live in memory above every engine, so a query costs about the same on each once its records
are cached.

<FromRxdb page="rx-storage-performance" :rows="['benchmarks', 'indexStorage', 'memoryMapped', 'openCost']" />
