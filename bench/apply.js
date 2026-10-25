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
const { applyOp, observedTags, packOps, unpackOps } = require('../src/ops.js');
const { generateSigningKeys } = require('../src/crypto.js');
const { signOp, verifyOp } = require('../src/signing.js');
const { open } = require('../src/storage.js');
const S = require('../src/text/sequence.js');

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
    else if (type === 'add') Object.assign(op, { key: 'labels', value: [`t${seq}`] });
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
  // A 20-element set: an add or a remove re-reads the whole field.
  const members = Array.from({ length: 20 }, (_, i) => `m${i}`);
  const withSet = applyOp(base, {
    origin: 'A',
    seq: 2,
    ts: ++ts,
    type: 'add',
    id: 'r',
    key: 'labels',
    value: members,
  }).entry;
  await bench('applyOp — add to a 20-element set', () =>
    applyOp(withSet, { origin: 'B', seq: 1, ts: ++ts, type: 'add', id: 'r', key: 'labels', value: ['new'] }));
  const tags = observedTags(withSet.meta, 'labels', ['m3']);
  await bench('applyOp — remove from a 20-element set', () =>
    applyOp(withSet, { origin: 'B', seq: 1, ts: ++ts, type: 'remove', id: 'r', key: 'labels', value: tags }));
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
      // The same page, signed by its origin: what the verify pre-pass costs
      // on top of the writes. Pages are signed ahead so signing is not timed;
      // past the prepared pages, a page is signed on the fly.
      const keys = await generateSigningKeys();
      const prepared = [];
      const signer = { seq: 0, ids: [] };
      const signPage = async (n) => {
        const ops = pageOf(keys.id, signer, n, 'write', record);
        for (const op of ops) await signOp(op, keys.privateKey);
        return ops;
      };
      for (let i = 0; i < 150; i++) prepared.push(await signPage(100));
      await bench(
        `applyRemote — 100 signed writes, new records${label}`,
        async () => storage.applyRemote(prepared.length > 0 ? prepared.shift() : await signPage(100)),
        { warmup: 3, measureMs: 1500, opsPerIteration: 100 },
      );
      if (chain) {
        const page = await signPage(100);
        await bench('verifyOp — 100 signed writes', () => Promise.all(page.map((op) => verifyOp(op, 'require'))), {
          opsPerIteration: 100,
        });
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
      // A set field of its own, growing by one element per op.
      const adder = { seq: 0, ids };
      await bench(
        `applyRemote — 100 adds on cached records${label}`,
        () => storage.applyRemote(pageOf('T', adder, 100, 'add')),
        { warmup: 3, measureMs: 1500, opsPerIteration: 100 },
      );
      // A text record from a peer: one run of 5 000 characters, then pages
      // of splices at random places of it — each a new run anchored inside
      // the first, the field read anew per op.
      const texter = { seq: 0 };
      const textId = `${chain ? 'c' : 'p'}-text`;
      const textOp = (value) => ({
        origin: 'X',
        seq: ++texter.seq,
        ts: 1_000_000 + texter.seq,
        type: 'splice',
        id: textId,
        key: 'body',
        value,
      });
      await storage.applyRemote([textOp({ at: S.HEAD, content: 'x'.repeat(5000) })]);
      const firstRun = S.runKey(1_000_001, 'X');
      let r = 0;
      await bench(
        `applyRemote — 500 random inserts into a 5K text${label}`,
        () =>
          storage.applyRemote(
            Array.from({ length: 500 }, () =>
              textOp({ at: `<${S.elemKey(firstRun, (r = (r * 7919 + 13) % 5000))}`, content: 'z' }),
            ),
          ),
        { warmup: 3, measureMs: 1500, opsPerIteration: 500 },
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
