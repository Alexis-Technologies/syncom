/**
 * Trees: the movable tree behind the tree kind — one move folded over a
 * block of thousands of moves, the fold read anew and read from the block
 * that keeps it, and a move among many siblings through the storage over
 * the memory backend.
 *
 * Run with `node bench/tree.js` or `pnpm bench`.
 */

'use strict';

const { bench } = require('./support/harness.js');
const T = require('../src/tree.js');
const { applyOp } = require('../src/ops.js');
const { createMemoryFsi } = require('../src/backend.js');
const { open } = require('../src/storage.js');

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
  const block = entry.meta.trees.outline;
  await bench('applyOp — one move on a tree of 5 000 moves', () =>
    applyOp(entry, op(++ts, 'C', { node: 'n5', parent: 'root', fi: 'V' })));
  await bench('resolve — the fold of 5 000 moves, anew', () => T.resolve(block));
  await bench('renderTree — the fold kept by the block', () => T.renderTree(block));

  const storage = await open({ path: '/bench', fsi: createMemoryFsi(), logger: false });
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
