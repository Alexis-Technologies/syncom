/**
 * Trees: the movable tree behind the tree kind — one move folded over a
 * block of thousands of moves, the fold read anew and read from the block
 * that keeps it, one move after a chain of 10 000 nodes, the fold of a
 * block at MAX_MOVES in its worst shape, and a move among many siblings
 * through the storage over the memory backend.
 *
 * Run with `node bench/tree.js` or `pnpm bench`.
 */

'use strict';

const { bench } = require('./support/harness.js');
const T = require('../src/tree/moves.js');
const { applyOp, open } = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');

const op = (ts, origin, value) => ({ origin, seq: ts, ts, type: 'tree', id: 'r', key: 'outline', value });

const main = async () => {
  console.log(`Tree benchmark — Node ${process.version}\n`);
  // A root, 1 000 nodes under it, 4 000 more moves among them: a block of
  // 5 000 moves, the fold of which is what every op pays for.
  let entry = applyOp(null, op(1, 'A', { node: 'root', parent: null, fi: 'V' })).entry;
  let ts = 1;
  for (let i = 0; i < 1000; i++) {
    entry = applyOp(entry, op(++ts, 'A', { node: `n${i}`, parent: 'root', fi: 'V' })).entry;
  }
  for (let i = 0; i < 4000; i++) {
    const node = `n${i % 1000}`;
    const parent = `n${(i * 7 + 3) % 1000}`;
    if (node !== parent) entry = applyOp(entry, op(++ts, 'B', { node, parent, fi: 'V' })).entry;
  }
  const block = entry.meta.blocks.outline;
  await bench('applyOp — one move on a tree of 5 000 moves', () =>
    applyOp(entry, op(++ts, 'C', { node: 'n5', parent: 'root', fi: 'V' })));
  await bench('resolve — the fold of 5 000 moves, anew', () => T.resolve(block));
  await bench('renderTree — the fold kept by the block', () => T.renderTree(block));

  // A chain of 10 000 nodes, one snapshot block: the fold walked every
  // node's ancestors, 50 million steps, until the walk stopped at MAX_WALK.
  const chain = {};
  let parent = null;
  for (let i = 0; i < 10_000; i++) {
    chain[`c${i}`] = [[i + 1, 'A', parent, 'V']];
    parent = `c${i}`;
  }
  const meta = { clock: {}, counters: {}, blocks: { outline: { k: 'tree', ts: 10_000, moves: chain } } };
  const deep = applyOp(null, { origin: 'A', seq: 1, ts: 1, type: 'merge', id: 'r', data: {}, meta }).entry;
  let at = 10_000;
  await bench(
    'applyOp — one move after a chain of 10 000 nodes',
    () => applyOp(deep, op(++at, 'C', { node: 'x', parent: null, fi: 'V' })),
    { warmup: 5 },
  );
  // MAX_MOVES moves in the shape the walk costs most: a chain MAX_WALK deep, every other move under its last node.
  const worst = {};
  let last = null;
  for (let i = 0; i < T.MAX_MOVES; i++) {
    worst[`w${i}`] = [[i + 1, 'A', last, 'V']];
    if (i < T.MAX_WALK) last = `w${i}`;
  }
  const full = T.normalizeTree({ k: 'tree', ts: T.MAX_MOVES, moves: worst });
  await bench(`resolve — the fold of MAX_MOVES (${T.MAX_MOVES}) moves, the worst shape`, () => T.resolve(full), {
    warmup: 3,
  });

  const storage = await open({ path: '/bench', fsi: memory(), logger: false });
  const id = await storage.insert({});
  await storage.treeMove(id, 'outline', 'root');
  for (let i = 0; i < 300; i++) await storage.treeMove(id, 'outline', `n${i}`, 'root');
  let n = 0;
  await bench('storage.treeMove — among 300 siblings (memory fsi)', () => {
    n++;
    return storage.treeMove(id, 'outline', `n${n % 300}`, 'root', { after: `n${(n + 7) % 300}` });
  });
  await storage.close();
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
