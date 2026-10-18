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
        const cold = await open({ path: root, lock: false });
        return cold.get(id);
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
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

void main();
