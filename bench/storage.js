/**
 * `Storage` — the full write path end to end: hash the record, append a block
 * (two more file writes, see bench/chain.js), write the entry, populate the
 * cache. That makes `insert` the most expensive operation in the library, and
 * the gap between it and a cached `get` is the number worth watching.
 *
 * `get` has two very different costs depending on whether the id is in the
 * in-memory cache: a cold read re-hashes the entry and re-reads its block to
 * verify integrity, so it is several file reads, not one.
 *
 * `swap` is the CAS path — it reads, compares, and writes only on a match; the
 * mismatch row costs a read and nothing else.
 *
 * Writes go to a temp directory that is removed on exit.
 *
 * Run with `node bench/storage.js` or `pnpm bench`.
 */

'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { bench } = require('./support/harness.js');
const { open } = require('../src/storage.js');

const main = async () => {
  console.log(`Storage benchmark — Node ${process.version}\n`);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncom-bench-storage-'));

  try {
    // Key generation is RSA-2048 and happens once per Storage; keeping a
    // single instance keeps that cost out of every row below.
    const storage = await open({ path: root, lock: false });

    const record = { name: 'Example', email: 'example@example.com', hits: 0 };

    await bench('insert — small record', () => storage.insert(record), { warmup: 20 });

    const id = await storage.insert(record);

    await bench('get — cached', () => storage.get(id));
    await bench(
      'get — cold (re-verifies the block)',
      async () => {
        // A second instance on the same directory, closed after the read:
        // left open, every iteration would leak a log and a lock.
        const cold = await open({ path: root, lock: false });
        try {
          return await cold.get(id);
        } finally {
          await cold.close();
        }
      },
      { warmup: 3, measureMs: 500 },
    );

    await bench('update — one field', () => storage.update(id, { hits: 1 }), { warmup: 20 });
    await bench('set — whole record', () => storage.set(id, record), { warmup: 20 });

    await bench(
      'swap — match (writes)',
      async () => {
        await storage.swap(id, { name: 'Example' }, { name: 'Example' });
      },
      { warmup: 20 },
    );
    await bench('swap — mismatch (reads only)', () => storage.swap(id, { name: 'x' }, { name: 'nope' }));

    await bench('has — existing id', () => storage.has(id));
    await bench('record — cached Record instance', () => storage.record(id));

    // The catalog: list() and hasRecord() answer from memory however many
    // records there are; a rebuild is the one scan, and only on an open
    // whose catalog cannot be caught up from the log.
    const many = 2_000;
    for (let i = 0; i < many; i++) await storage.insert({ ...record, i });
    await bench(`list — ${many} ids (catalog)`, () => storage.list(), { warmup: 5 });
    await bench(`hasRecord — ${many} ids (catalog)`, () => storage.hasRecord(id), { warmup: 5 });
    await storage.close();

    // Queries: a covered equality is posting lists and catalog rows; an
    // order with a limit still sorts every candidate; a filter reads them.
    const indexed = await open({
      path: path.join(root, 'indexed'),
      lock: false,
      logger: false,
      schema: { entities: { Item: { index: ['group'] } } },
    });
    for (let i = 0; i < many; i++) await indexed.Item.insert({ group: `g${i % 20}`, rank: i, name: `item ${i}` });
    await bench(`select — covered eq over ${many}`, () =>
      indexed.Item.select({ group: 'g7' }).projection(['group']).fetch());
    await bench(`select — eq + order + limit over ${many}`, () =>
      indexed.Item.select({ group: 'g7' }).desc('rank').limit(20).fetch());
    await bench(`select — uncovered filter over ${many}`, () => indexed.Item.select({ rank: { $gte: 1900 } }).fetch(), {
      warmup: 3,
    });
    await indexed.close();
    await bench(
      `open — catalog caught up from the log (${many} records)`,
      async () => {
        const reopened = await open({ path: root, lock: false });
        await reopened.close();
      },
      { warmup: 1, measureMs: 2000 },
    );
    await fs.rm(path.join(root, 'index'), { recursive: true, force: true });
    await bench(
      `open — catalog rebuilt from a scan (${many} records, integrity lazy)`,
      async () => {
        const rebuilt = await open({ path: root, lock: false, integrity: 'lazy', logger: false });
        await fs.rm(path.join(root, 'index'), { recursive: true, force: true });
        await rebuilt.close();
      },
      { warmup: 1, measureMs: 2000 },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

void main();
