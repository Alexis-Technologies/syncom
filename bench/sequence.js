/**
 * Lists and text: the sequence engine behind the two kinds — what one
 * keystroke costs the model (a fold over a block with a run per insert), a
 * reading, a snapshot join, a diff, and the same through the storage over
 * the memory backend.
 *
 * Run with `node bench/sequence.js` or `pnpm bench`.
 */

'use strict';

const { bench } = require('./support/harness.js');
const S = require('../src/sequence.js');
const { applyOp } = require('../src/ops.js');
const { diff } = require('../src/myers.js');
const { createMemoryFsi } = require('../src/backend.js');
const { open } = require('../src/storage.js');

const op = (type, ts, origin, key, value) => ({ origin, seq: ts, ts, type, id: 'r', key, value });

const main = async () => {
  console.log(`Sequence benchmark — Node ${process.version}\n`);
  const text = 'x'.repeat(1000);
  // One run of 1 000 characters, and 1 000 runs (a prepend chain).
  const oneRun = applyOp(null, op('splice', 1, 'A', 'body', { at: '^', content: text })).entry;
  let chain = null;
  let prev = null;
  for (let i = 0; i < 1000; i++) {
    const ts = 2 + i;
    const at = prev === null ? '^' : `<${S.elemKey(prev, 0)}`;
    chain = applyOp(chain, op('splice', ts, 'B', 'body', { at, content: 'y' })).entry;
    prev = S.runKey(ts, 'B');
  }
  let ts = 5000;
  const run = S.runKey(1, 'A');
  await bench('applyOp — append one char to a 1 000-char text (one run)', () =>
    applyOp(oneRun, op('splice', ++ts, 'A', 'body', { run, from: 1000, content: 'z' })));
  await bench('applyOp — insert one char into a 1 000-char text (new run)', () =>
    applyOp(oneRun, op('splice', ++ts, 'C', 'body', { at: `<${S.elemKey(run, 500)}`, content: 'z' })));
  await bench('applyOp — delete 10 chars from a 1 000-char text', () =>
    applyOp(oneRun, op('splice', ++ts, 'C', 'body', { cut: [[run, 400, 10]], content: '' })));
  await bench('applyOp — prepend one char to a 1 000-run text', () =>
    applyOp(chain, op('splice', ++ts, 'C', 'body', { at: `<${S.elemKey(prev, 0)}`, content: 'z' })));
  await bench('applyOp — merge two pictures of a 1 000-char text', () =>
    applyOp(
      oneRun,
      op('merge', ++ts, 'M', undefined, undefined) && { ...op('merge', ts, 'M'), data: chain.data, meta: chain.meta },
    ));
  const seq = oneRun.meta.seqs.body;
  await bench('buildIndex + render — a 1 000-char text', () => S.render(S.buildIndex(seq)));
  const big = applyOp(null, op('splice', 1, 'A', 'body', { at: '^', content: 'x'.repeat(100_000) })).entry.meta.seqs
    .body;
  await bench('buildIndex + render — a 100 KB text (one run)', () => S.render(S.buildIndex(big)));
  let marked = oneRun;
  for (let i = 0; i < 50; i++) {
    const start = `<${S.elemKey(run, i * 10)}`;
    const end = `<${S.elemKey(run, i * 10 + 20)}`;
    marked = applyOp(
      marked,
      op('mark', 100 + i, 'A', 'body', { start, end, key: i % 2 ? 'bold' : 'em', value: true }),
    ).entry;
  }
  const markedSeq = marked.meta.seqs.body;
  await bench('spans — 1 000 chars, 50 overlapping marks', () => S.spans(S.buildIndex(markedSeq), markedSeq));
  const before = 'the quick brown fox '.repeat(50);
  const after = `${before.slice(0, 500)}X${before.slice(500)}`;
  await bench('diff — one keystroke in a 1 KB text', () => diff(before, after));

  const storage = await open({ path: '/bench', fsi: createMemoryFsi(), logger: false });
  const id = await storage.insert({});
  await storage.updateText(id, 'body', before);
  await bench('storage.push — one char (memory fsi)', () => storage.push(id, 'body', 'z'));
  let n = 0;
  await bench('storage.updateText — one keystroke in a 1 KB text (memory fsi)', async () => {
    const current = (await storage.get(id)).body;
    n++;
    await storage.updateText(id, 'body', `${current.slice(0, 500 + (n % 7))}Q${current.slice(500 + (n % 7))}`);
  });
  const list = await storage.insert({});
  await storage.push(
    list,
    'items',
    Array.from({ length: 100 }, (_, i) => i),
  );
  await bench('storage.move — in a 100-element list (memory fsi)', () => storage.move(list, 'items', n++ % 100, 50));
  await storage.close();
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
