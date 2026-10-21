/**
 * The op model and the apply path — what a peer's page costs once it has
 * arrived (the applyRemote rows count ops, not pages). `applyOp` is the pure fold one op makes on one entry; `packOps`
 * / `unpackOps` the wire shape of a page; `applyRemote` the whole batch:
 * admit every op, apply it to the record it names, append the batch to the
 * log, write the records, announce. A `chain: false` row shows what the
 * block costs a hub that only replicates.
 *
 * Writes go to a temp directory that is removed on exit.
 *
 * Run with `node bench/apply.js` or `pnpm bench`.
 */

'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { bench } = require('./support/harness.js');
const { applyOp, packOps, unpackOps } = require('../src/ops.js');
const { open } = require('../src/storage.js');

const record = { name: 'Example', email: 'example@example.com', hits: 0, tags: ['a', 'b'], nested: { k: 1 } };

// A page of `n` ops from one origin, seqs continuing where the last page
// stopped — the stream every peer expects.
const pageOf = (origin, state, n, type, data) => {
  const ops = [];
  for (let i = 0; i < n; i++) {
    const seq = ++state.seq;
    const id = type === 'write' ? `${origin}-${seq}` : state.ids[i % state.ids.length];
    const op = { origin, seq, ts: Date.now() + seq, type, id };
    if (type === 'inc') Object.assign(op, { key: 'views', value: 1 });
    else op.data = data;
    ops.push(op);
  }
  return ops;
};

const main = async () => {
  console.log(`Apply benchmark — Node ${process.version}\n`);

  // The pure model: no I/O at all.
  const base = applyOp(null, { origin: 'A', seq: 1, ts: 1, type: 'write', id: 'r', data: record }).entry;
  let ts = 1;
  await bench('applyOp — set one field on a 5-field entry', () =>
    applyOp(base, { origin: 'B', seq: 1, ts: ++ts, type: 'set', id: 'r', data: { hits: ts } }));
  await bench('applyOp — inc a counter', () =>
    applyOp(base, { origin: 'B', seq: 1, ts: ++ts, type: 'inc', id: 'r', key: 'views', value: 1 }));
  await bench('applyOp — write the whole record', () =>
    applyOp(base, { origin: 'B', seq: 1, ts: ++ts, type: 'write', id: 'r', data: record }));
  await bench('applyOp — merge a peer entry', () =>
    applyOp(base, { origin: 'B', seq: 1, ts: ++ts, type: 'merge', id: 'r', data: base.data, meta: base.meta }));
  const page = pageOf('W', { seq: 0, ids: [] }, 500, 'write', record);
  const packed = packOps(page);
  await bench('packOps — 500 writes', () => packOps(page));
  await bench('unpackOps — 500 writes', () => unpackOps(packed));

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncom-bench-apply-'));
  try {
    for (const chain of [true, false]) {
      const storage = await open({ path: path.join(root, chain ? 'chained' : 'plain'), chain, logger: false });
      const label = chain ? '' : ' (chain: false)';
      // One origin per page size: a stream's seqs must start at 1 and run
      // contiguously, or every op of it is a gap.
      for (const n of [100, 500]) {
        const writer = { seq: 0, ids: [] };
        await bench(
          `applyRemote — ${n} writes, new records${label}`,
          () => storage.applyRemote(pageOf(`W${n}`, writer, n, 'write', record)),
          { warmup: 3, measureMs: 1500, opsPerIteration: n },
        );
      }
      // Updates land on records that exist: the entry is read (cached after
      // the first page) and one field moves.
      const ids = [];
      for (let i = 0; i < 100; i++) ids.push(`S-${i}`);
      await storage.applyRemote(
        pageOf('S', { seq: 0, ids }, 100, 'write', record).map((op, i) => ({ ...op, id: ids[i] })),
      );
      const setter = { seq: 100, ids };
      await bench(
        `applyRemote — 100 sets on cached records${label}`,
        () => storage.applyRemote(pageOf('S', setter, 100, 'set', { hits: 1 })),
        { warmup: 3, measureMs: 1500, opsPerIteration: 100 },
      );
      // A counter field of its own: `hits` was written as a register.
      const counter = { seq: 0, ids };
      await bench(
        `applyRemote — 100 incs on cached records${label}`,
        () => storage.applyRemote(pageOf('C', counter, 100, 'inc')),
        { warmup: 3, measureMs: 1500, opsPerIteration: 100 },
      );
      await storage.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
