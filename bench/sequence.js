/**
 * Lists and text: the sequence engine behind the two kinds — what one
 * keystroke costs the model (the rope under a block: an op on the newest
 * block, as the storage applies them, one after another), a reading, a
 * block hydrated from its JSON, a snapshot join, a diff, and the same
 * through the storage over the memory backend. An edit at an index goes
 * where `placeInsert`/`rangesOf` send it, as `updateText` would — a new
 * run under the element there, or the writer's own run grown; the text is
 * read after every op, as the storage reads it. One row applies every op
 * to the SAME older block — a fork, which re-hints the rope once per op —
 * the cost of editing a version that is not the head.
 *
 * Run with `node bench/sequence.js` or `pnpm bench`.
 */

'use strict';

const { bench } = require('./support/harness.js');
const S = require('../src/text/sequence.js');
const { applyOp, open } = require('../src/all/all.js');
const { diff } = require('../src/text/myers.js');
const { memory } = require('../src/memory/memory.js');

const op = (type, ts, origin, key, value) => ({ origin, seq: ts, ts, type, id: 'r', key, value });

// A seeded index: the same places every run.
const rng = (seed) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const random = rng(7);
const indexIn = (entry) => Math.floor(random() * S.lengthOf(S.indexOf(entry, 'body')));
// What a keystroke at `i` by `origin` sends: a splice placed by the engine.
const insertAt = (entry, ts, origin, i, content = 'z') =>
  applyOp(entry, op('splice', ts, origin, 'body', { ...S.placeInsert(S.indexOf(entry, 'body'), i, origin), content }))
    .entry;
// A character at `i` replaced by one of `origin`: a cut, then an insert there.
const replaceAt = (entry, ts, origin, i) => {
  const cut = S.rangesOf(S.indexOf(entry, 'body'), i, 1);
  const next = applyOp(entry, op('splice', ts, origin, 'body', { cut, content: '' })).entry;
  return insertAt(next, ts + 1, origin, i);
};

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
  // Every row applies its ops to the newest entry, one after another.
  let typed = oneRun;
  let len = 1000;
  await bench('applyOp — append one char to a 1 000-char text (one run)', () => {
    typed = applyOp(typed, op('splice', ++ts, 'A', 'body', { run, from: len++, content: 'z' })).entry;
  });
  let inserted = oneRun;
  await bench('applyOp — insert one char at a random index of a 1 000-char text (one run)', () => {
    inserted = insertAt(inserted, ++ts, 'C', indexIn(inserted));
  });
  let replaced = oneRun;
  await bench(
    'applyOp — replace one char at a random index of a 1 000-char text (a cut, an insert)',
    () => {
      replaced = replaceAt(replaced, (ts += 2), 'C', indexIn(replaced));
    },
    { opsPerIteration: 2 },
  );
  let prepended = chain;
  await bench('applyOp — prepend one char to a 1 000-run text', () => {
    prepended = insertAt(prepended, ++ts, 'C', 0);
  });
  await bench('applyOp — append one char to an older block (a fork: the rope re-hinted)', () =>
    applyOp(oneRun, op('splice', ++ts, 'A', 'body', { run, from: 1000, content: 'z' })));
  await bench('applyOp — merge two pictures of a 1 000-char text', () =>
    applyOp(
      oneRun,
      op('merge', ++ts, 'M', undefined, undefined) && { ...op('merge', ts, 'M'), data: chain.data, meta: chain.meta },
    ));
  const seqJson = JSON.stringify(oneRun.meta.blocks.body);
  await bench('hydrate + render — a 1 000-char text from its JSON', () =>
    S.render(S.hydrate(JSON.parse(seqJson), null)));
  const big = applyOp(null, op('splice', 1, 'A', 'body', { at: '^', content: 'x'.repeat(100_000) })).entry.meta.blocks
    .body;
  const bigJson = JSON.stringify(big);
  await bench('hydrate + render — a 100 KB text (one run) from its JSON', () =>
    S.render(S.hydrate(JSON.parse(bigJson), null)));
  // A pasted document edited anywhere: every keystroke a new run under an
  // element of the one big run.
  let pasted = applyOp(null, op('splice', 1, 'A', 'body', { at: '^', content: 'x'.repeat(100_000) })).entry;
  await bench('applyOp — insert one char at a random index of a 100 KB text (one run)', () => {
    pasted = insertAt(pasted, ++ts, 'C', indexIn(pasted));
  });
  // Ten thousand runs of ten characters, each anchored after the last
  // element of the one before — a 100 KB text as a long chain of right
  // children, origins alternating so no run extends another. Built as a
  // block and folded in through one merge: folding it in op by op is itself
  // the slow path this measures. Edits land anywhere in it, at the head, and
  // as a cut; the reading is built anew.
  const RUNS = 10_000;
  const chainRuns = {};
  const anchors = [];
  let last = null;
  for (let i = 0; i < RUNS; i++) {
    const key = S.runKey(10 + i, i % 2 ? 'B' : 'A');
    chainRuns[key] = [last === null ? S.HEAD : `>${S.elemKey(last, 9)}`, ['xxxxxxxxxx']];
    anchors.push(key);
    last = key;
  }
  const longMeta = {
    clock: {},
    base: null,
    deleted: null,
    counters: {},
    sets: {},
    blocks: { body: { k: 't', ts: 10 + RUNS, runs: chainRuns } },
    trees: {},
  };
  const longText = applyOp(null, {
    ...op('merge', 20_000, 'M'),
    data: { body: 'x'.repeat(RUNS * 10) },
    meta: longMeta,
  }).entry;
  ts = Math.max(ts, 30_000);
  let anywhere = longText;
  await bench('applyOp — insert one char at a random index of a 100 KB text (10 000 runs)', () => {
    anywhere = insertAt(anywhere, ++ts, 'C', indexIn(anywhere));
  });
  let front = longText;
  await bench('applyOp — prepend one char to a 10 000-run text', () => {
    front = insertAt(front, ++ts, 'C', 0);
  });
  let over = longText;
  await bench(
    'applyOp — replace one char at a random index of a 100 KB text (10 000 runs)',
    () => {
      over = replaceAt(over, (ts += 2), 'C', indexIn(over));
    },
    { opsPerIteration: 2 },
  );
  const longJson = JSON.stringify(longText.meta.blocks.body);
  await bench('hydrate + render — a 100 KB text (10 000 runs) from its JSON', () =>
    S.render(S.hydrate(JSON.parse(longJson), null)));
  let marked = oneRun;
  for (let i = 0; i < 50; i++) {
    const start = `<${S.elemKey(run, i * 10)}`;
    const end = `<${S.elemKey(run, i * 10 + 20)}`;
    marked = applyOp(
      marked,
      op('mark', 100 + i, 'A', 'body', { start, end, key: i % 2 ? 'bold' : 'em', value: true }),
    ).entry;
  }
  const markedSeq = marked.meta.blocks.body;
  await bench('spans — 1 000 chars, 50 overlapping marks', () => S.spans(markedSeq, markedSeq));
  const before = 'the quick brown fox '.repeat(50);
  const after = `${before.slice(0, 500)}X${before.slice(500)}`;
  await bench('diff — one keystroke in a 1 KB text', () => diff(before, after));

  const storage = await open({ path: '/bench', fsi: memory(), logger: false, defer: 0 });
  const id = await storage.insert({});
  await storage.updateText(id, 'body', before);
  await bench('storage.push — one char (memory fsi, defer: 0)', () => storage.push(id, 'body', 'z'));
  let n = 0;
  await bench('storage.updateText — one keystroke in a 1 KB text (memory fsi, defer: 0)', async () => {
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
  await bench('storage.move — in a 100-element list (memory fsi, defer: 0)', () =>
    storage.move(list, 'items', n++ % 100, 50));
  // The record file written whole on every keystroke, against the same
  // keystrokes under the default window: the file and the block wait for it.
  const long = await storage.insert({});
  await storage.updateText(long, 'body', 'x'.repeat(10_000));
  await bench('storage.push — one char into a 10 KB text (memory fsi, defer: 0)', () =>
    storage.push(long, 'body', 'z'));
  await storage.close();
  const deferred = await open({ path: '/bench-defer', fsi: memory(), logger: false });
  const lazy = await deferred.insert({});
  await deferred.updateText(lazy, 'body', 'x'.repeat(10_000));
  await bench('storage.push — one char into a 10 KB text (memory fsi, defer: 16, the default)', () =>
    deferred.push(lazy, 'body', 'z'));
  // An editor's stream: a thousand keystrokes sent without waiting for each.
  await bench(
    'storage.push — one char into a 10 KB text, pipelined by 1 000 (memory fsi)',
    async () => {
      const writes = [];
      for (let i = 0; i < 1000; i++) writes.push(deferred.push(lazy, 'body', 'z'));
      await writes[writes.length - 1];
    },
    { opsPerIteration: 1000, warmup: 2 },
  );
  await deferred.close();
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
