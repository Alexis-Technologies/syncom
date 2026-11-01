/**
 * The storage engines side by side — the same database over the files engine
 * on node:fs, the engine in memory, SQLite (a file), IndexedDB (fake-indexeddb,
 * the object stores under Node) and, with `MONGODB_URL` set (a replica set),
 * MongoDB over the driver — never over the fake driver of tests, which scans
 * its collections and would measure itself:
 *
 * - `insert` awaited one by one, the full write path: an append, a landing;
 * - `transact — 1000 inserts`: one log group and one write set of a thousand;
 * - `update — one field`, `get — cached`;
 * - `open — 10k records`: a cold open over what the inserts left (the
 *   catalog read back or rebuilt, the log loaded);
 * - `round trips per write`: how many transactions, statements or bulk writes
 *   the medium takes per awaited insert — printed, not timed.
 *
 * The chain is off (`chain: false`), as a hub that only replicates runs, and so
 * are signatures (`/all` registers signing; the rows measure the medium, not
 * Ed25519); the files engine on node:fs is today's default, the number to beat.
 *
 * Run with `node bench/engines.js` or `pnpm bench engines`.
 */

'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { bench } = require('./support/harness.js');
const { createDatabase, memoryEngine } = require('../src/all/all.js');
const { IDBFactory, IDBKeyRange, IDBDatabase } = require('fake-indexeddb');
const { idbEngine } = require('../src/idb/idb.js');
const { mongoEngine } = require('../src/mongodb/mongodb.js');

require('../tests/utils/quiet-sqlite.js');
const { sqliteEngine } = require('../src/sqlite/sqlite.js');

const record = { name: 'Example', email: 'example@example.com', hits: 0, kind: 'a' };
const SEED = 10_000;

// A counter of the medium's round trips: the SQLite driver's transactions, IndexedDB's readwrite transactions, the
// fake driver's bulk writes.
const counting = () => {
  const counts = { sqlite: 0, idb: 0 };
  const { DatabaseSync } = require('node:sqlite');
  const sqliteDriver = {
    open(file) {
      const conn = new DatabaseSync(file);
      return {
        exec(sql) {
          if (sql.startsWith('BEGIN')) counts.sqlite++;
          return conn.exec(sql);
        },
        prepare: (sql) => conn.prepare(sql),
        close: () => conn.close(),
      };
    },
  };
  const originalTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args) {
    if (args[1] === 'readwrite') counts.idb++;
    return originalTransaction.apply(this, args);
  };
  return { counts, sqliteDriver };
};

const main = async () => {
  console.log(`Engines benchmark — Node ${process.version}\n`);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncom-bench-engines-'));
  const { counts, sqliteDriver } = counting();
  // The engine alone: no chain, no signatures (`/all` registers signing, and `'verify'` would sign every op with
  // Ed25519 and keep the write made at once off — the rows would measure the signature, not the medium).
  const plain = { lock: false, chain: false, logger: false, sync: { signatures: false } };
  const engines = [
    {
      label: 'files (node:fs)',
      open: (name) => createDatabase({ path: path.join(root, name), ...plain }),
    },
    { label: 'memory', engine: memoryEngine() },
    {
      label: 'sqlite (a file)',
      engine: sqliteEngine({ file: path.join(root, 'bench.sqlite'), driver: sqliteDriver }),
      count: 'sqlite',
    },
    {
      label: 'idb (fake-indexeddb)',
      engine: idbEngine({ indexedDB: new IDBFactory(), IDBKeyRange, channel: null }),
      count: 'idb',
    },
  ];
  // MongoDB over the real driver alone (`MONGODB_URL`, a replica set): the fake driver scans its collections (a
  // Map, no index), so a row over it measures the fake, not the engine — it is not measured.
  const url = process.env.MONGODB_URL;
  if (url) {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(url);
    await client.connect();
    engines.push({
      label: 'mongodb (the driver)',
      engine: mongoEngine({ client, name: `syncom_bench_${process.pid}`, transactions: true }),
      client,
    });
  } else {
    console.log('mongodb: not measured — set MONGODB_URL (a replica set) to measure the engine over the driver\n');
  }
  try {
    for (const { label, engine, open, count, seed = true } of engines) {
      const opened = (name) => (open ? open(name) : createDatabase({ path: name, engine, ...plain }));
      const db = await opened('bench');
      await bench(`insert — ${label}`, () => db.insert(record), { warmup: 50 });
      const id = await db.insert(record);
      await bench(`update — one field — ${label}`, () => db.update(id, { hits: 1 }), { warmup: 50 });
      await bench(`get — cached — ${label}`, () => db.get(id));
      await bench(
        `transact — 1000 inserts — ${label}`,
        () =>
          db.transact(async (tx) => {
            for (let i = 0; i < 1000; i++) await tx.insert(record);
          }),
        { warmup: 2, measureMs: 2000, opsPerIteration: 1000 },
      );
      if (count !== undefined) {
        const before = counts[count];
        await db.insert(record);
        await db.insert(record);
        console.log(
          `${`round trips per write — ${label}`.padEnd(60)} ${String((counts[count] - before) / 2).padStart(12)}`,
        );
      }
      await db.close();
      if (!seed) {
        console.log();
        continue;
      }
      // A cold open over ten thousand records: a fresh database, its catalog read back or rebuilt.
      const seeded = await opened('seeded');
      await seeded.transact(async (tx) => {
        for (let i = 0; i < SEED; i++) await tx.insert(record);
      });
      await seeded.close();
      await bench(
        `open — ${SEED.toLocaleString('en-US')} records — ${label}`,
        async () => {
          const cold = await opened('seeded');
          await cold.close();
        },
        { warmup: 2, measureMs: 2000 },
      );
      console.log();
    }
  } finally {
    for (const { engine, client } of engines) {
      if (client === undefined) continue;
      await engine.destroy();
      await client.close();
    }
    for (const { engine } of engines) await engine?.close?.();
    await fs.rm(root, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
