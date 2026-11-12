/**
 * Attachments (src/attachments/attachments.js) over the memory engine: a blob
 * put and read back, plain and at rest — the bytes sealed as iv ‖ ciphertext
 * at the blob's place (review №7, E7.4; the first version's base64 round trips
 * made a 64 MiB put cost 28× its size in memory) — and what the at-rest put
 * of a 64 MiB blob costs in time and resident memory.
 *
 * Run with `node bench/attachments.js` or `pnpm bench`.
 */

'use strict';

const { bench } = require('./support/harness.js');
const { createDatabase, memoryEngine } = require('../src/all/all.js');
const { attachments } = require('../src/attachments/attachments.js');
const { atRest } = require('../src/encryption/encryption.js');

const MIB = 1024 * 1024;
const SIZE = 16 * MIB;
const LARGE = 64 * MIB;
const KEY = new Uint8Array(32).fill(7);

const bytesOf = (size) => {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 2654435761) >>> 24;
  return out;
};

const main = async () => {
  const bytes = bytesOf(SIZE);
  const subjects = [
    ['plain', memoryEngine()],
    ['at rest', atRest(memoryEngine(), { key: KEY })],
  ];
  for (const [label, engine] of subjects) {
    const db = await createDatabase({ engine, path: 'bench/a', logger: false, defer: 0, plugins: [attachments()] });
    const id = await db.insert({ title: 'a record with a file' });
    let n = 0;
    await bench(
      `put — 16 MiB ${label}: the blob stored by its digest, the register written`,
      () => db.attachments.put(id, `f${n++}.bin`, bytes, { type: 'application/octet-stream' }),
      { warmup: 1, measureMs: 1 },
    );
    await bench(`get — 16 MiB ${label}: the bytes read back, checked against the register`, () =>
      db.attachments.get(id, 'f0.bin', { fetch: false }));
    await db.close();
  }

  const sealed = await createDatabase({
    engine: atRest(memoryEngine(), { key: KEY }),
    path: 'bench/large',
    logger: false,
    defer: 0,
    plugins: [attachments()],
  });
  const id = await sealed.insert({ title: 'a record with a large file' });
  const large = bytesOf(LARGE);
  global.gc?.();
  const before = process.memoryUsage().rss;
  const started = performance.now();
  await sealed.attachments.put(id, 'large.bin', large, { type: 'application/octet-stream' });
  const ms = performance.now() - started;
  const grown = process.memoryUsage().rss - before;
  console.log(
    `put — 64 MiB at rest, once: ${ms.toFixed(0)} ms, RSS +${(grown / MIB).toFixed(0)} MiB (${(grown / LARGE).toFixed(1)}× the blob)`,
  );
  await sealed.close();
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
