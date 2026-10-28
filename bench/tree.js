/**
 * Trees: the movable tree behind the tree kind — one move folded over a
 * block of thousands of moves, the fold made from a block's JSON and the
 * reading the block keeps, one move after a chain of 10 000 nodes, the fold
 * of a block at MAX_MOVES in its worst shape; a move on a random tree of
 * 2 000, 8 000 and 32 000 nodes, a peer's page in stamp order, a peer's move
 * ten moves late; through the storage over the memory backend a move among
 * many siblings, a move on a random tree and an outline built in one
 * transaction.
 *
 * Run with `node bench/tree.js` or `pnpm bench`.
 */

'use strict';

const { bench } = require('./support/harness.js');
const T = require('../src/tree/moves.js');
const { applyOp, open } = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');

const op = (ts, origin, value) => ({ origin, seq: ts, ts, type: 'tree', id: 'r', key: 'outline', value });

let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
// A random tree of n nodes as one snapshot block: a root in ten, else under an earlier node.
const randomBlock = (n) => {
  const moves = {};
  for (let i = 0; i < n; i++) {
    moves[`n${i}`] = [[i + 1, 'S', i === 0 || rnd() < 0.1 ? null : `n${Math.floor(rnd() * i)}`, 'V']];
  }
  return { k: 'tree', ts: n, moves };
};
const merged = (block) =>
  applyOp(null, {
    origin: 'S',
    seq: 1,
    ts: 1,
    type: 'merge',
    id: 'r',
    data: {},
    meta: { clock: {}, counters: {}, blocks: { outline: block } },
  }).entry;
// A move of a random node under a random parent, or to the roots.
const anyMove = (n) => {
  const node = `n${1 + Math.floor(rnd() * (n - 1))}`;
  const parent = rnd() < 0.2 ? null : `n${Math.floor(rnd() * n)}`;
  return { node, parent: parent === node ? null : parent, fi: 'V' };
};

const main = async () => {
  console.log(`Tree benchmark — Node ${process.version}\n`);
  // A root, 1 000 nodes under it, 4 000 more moves among them: a block of
  // 5 000 moves.
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
  await bench('applyOp — one move on a tree of 5 000 moves', () => {
    entry = applyOp(entry, op(++ts, 'C', { node: `n${ts % 1000}`, parent: 'root', fi: 'V' })).entry;
  });
  const json = JSON.parse(JSON.stringify(block));
  await bench('the fold of 5 000 moves from the block’s JSON, anew', () => T.stateOf({ ...json }));
  await bench('renderTree — the reading the block keeps', () => T.renderTree(entry.meta.blocks.outline));

  // A move on a random tree: the newest in the fold's order — a local move,
  // or a peer's in stamp order — folded in one step, the reading path-copied.
  for (const n of [2000, 8000, 32_000]) {
    let tree = merged(randomBlock(n));
    let at = n + 10;
    await bench(`applyOp — one move on a random tree of ${n.toLocaleString('en-US')} nodes`, () => {
      tree = applyOp(tree, op(++at, 'C', anyMove(n))).entry;
    });
  }
  // A peer's page of 100 moves in stamp order on 8 000 nodes, move by move as applyRemote applies them.
  let paged = merged(randomBlock(8000));
  let pageTs = 9000;
  await bench(
    'applyOp — a peer’s page of 100 moves in stamp order, 8 000 nodes',
    () => {
      for (let i = 0; i < 100; i++) paged = applyOp(paged, op(++pageTs, 'P', anyMove(8000))).entry;
    },
    { warmup: 20, opsPerIteration: 100 },
  );
  // A peer's move ten moves late — stamped before the last ten of this
  // node's — landed by undo and redo: the pair, this node's move and the late one.
  let late = merged(randomBlock(8000));
  let lateTs = 9000;
  for (let i = 0; i < 12; i++) late = applyOp(late, op((lateTs += 20), 'C', anyMove(8000))).entry;
  await bench(
    'applyOp — a move, then a peer’s ten moves late, 8 000 nodes (the pair)',
    () => {
      late = applyOp(late, op((lateTs += 20), 'C', anyMove(8000))).entry;
      late = applyOp(late, op(lateTs - 195, 'B', anyMove(8000))).entry;
    },
    { opsPerIteration: 2 },
  );

  // A chain of 10 000 nodes, one snapshot block: the fold walked every
  // node's ancestors, 50 million steps, until the walk stopped at MAX_WALK.
  const chain = {};
  let parent = null;
  for (let i = 0; i < 10_000; i++) {
    chain[`c${i}`] = [[i + 1, 'A', parent, 'V']];
    parent = `c${i}`;
  }
  const meta = { clock: {}, counters: {}, blocks: { outline: { k: 'tree', ts: 10_000, moves: chain } } };
  let deep = applyOp(null, { origin: 'A', seq: 1, ts: 1, type: 'merge', id: 'r', data: {}, meta }).entry;
  let at = 10_000;
  await bench(
    'applyOp — one move after a chain of 10 000 nodes',
    () => {
      deep = applyOp(deep, op(++at, 'C', { node: `x${at % 100}`, parent: null, fi: 'V' })).entry;
    },
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
  await bench(`the fold of MAX_MOVES (${T.MAX_MOVES}) moves from JSON, the worst shape`, () => T.stateOf({ ...full }), {
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
  for (const size of [2000, 8000, 32_000]) {
    const rid = `t${size}`;
    await storage.mergeSnapshot([
      { id: rid, data: {}, meta: { clock: {}, counters: {}, blocks: { outline: randomBlock(size) } } },
    ]);
    await bench(`storage.treeMove — a random tree of ${size.toLocaleString('en-US')} nodes (memory fsi)`, async () => {
      const move = anyMove(size);
      await storage.treeMove(rid, 'outline', move.node, move.parent).catch((error) => {
        if (error.code !== 'CYCLE' && error.code !== 'OUT_OF_RANGE') throw error;
      });
    });
  }
  // An outline built in one transaction: every move resolved and folded against the one before.
  for (const size of [2000, 8000]) {
    await bench(
      `storage.transact — an outline of ${size.toLocaleString('en-US')} nodes in one transaction (per move)`,
      async () => {
        const rid = await storage.insert({});
        await storage.transact(async (tx) => {
          for (let i = 0; i < size; i++) {
            await tx.treeMove(rid, 'outline', `n${i}`, i === 0 || rnd() < 0.1 ? null : `n${Math.floor(rnd() * i)}`);
          }
        });
      },
      { warmup: 1, opsPerIteration: size },
    );
  }
  await storage.close();
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
