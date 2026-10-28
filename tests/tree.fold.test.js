'use strict';

// The incremental fold against the full one (tests/utils/tree-oracle.js, the
// fold as it was before it was kept): the same moves, delivered in and out
// of stamp order, by several origins, some under one forged stamp, around a
// chain that reaches past MAX_DEPTH and MAX_WALK and under names no move
// places yet — and after every one the block's JSON, the reading, every
// node's parent, the change report (order included) and what a local move
// reads agree. Older blocks are read again after their fold moved on, a
// block is forked, and the JSON round trip, a reset and a join start new
// lineages midway.

const test = require('node:test');
const assert = require('node:assert');
const T = require('../src/tree/moves.js');
const O = require('./utils/tree-oracle.js');

const lcg = (seed) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
// Places that tie, and one that is no fractional index (malformed).
const FIS = ['V', 'WV', 'UV', 'XV', 'VV', 'WUV', 'V', 'W'];

// What the oracle says of one move: its block, its reading and the change report.
const oracleMove = (block, stamp, payload) => {
  const r = O.applyTreeMove(block, stamp, payload);
  const out = { tree: r.tree, changed: r.changed, reason: r.reason };
  if (r.changed) out.change = O.treeChanges(O.renderTree(block), O.renderTree(r.tree));
  return out;
};

// Everything the two folds hold of one block, compared.
const agree = (block, oblock, label) => {
  assert.strictEqual(JSON.stringify(block), JSON.stringify(oblock), `${label}: the JSON`);
  assert.deepStrictEqual(T.renderTree(block), O.renderTree(oblock), `${label}: the reading`);
  const s = T.stateOf(block);
  const { parentOf } = O.resolve(oblock);
  for (const id of Object.keys(oblock.moves)) {
    assert.strictEqual(s.nodes.get(id).parent, parentOf.get(id), `${label}: the parent of ${id}`);
  }
};
// What a local move reads, compared for a node and a parent.
const reads = (block, oblock, node, parent, label) => {
  const s = T.stateOf(block);
  const folded = O.childrenOf(oblock);
  const cycle = parent !== null && parent !== O.TRASH && O.subtree(oblock, node, folded).has(parent);
  assert.strictEqual(T.under(s, node, parent), cycle, `${label}: a cycle`);
  const sibs = [];
  for (const n of T.kidsOf(s, parent)) sibs.push({ id: n.id, fi: n.place[3] });
  assert.deepStrictEqual(sibs, O.siblings(oblock, parent, folded), `${label}: the siblings`);
  if (parent !== null && parent !== O.TRASH) {
    assert.strictEqual(T.depthOf(s, parent), O.depthOf(folded, parent), `${label}: the depth`);
  }
  assert.strictEqual(T.heightOf(s, node), O.heightOf(folded, node), `${label}: the height`);
  assert.strictEqual(T.shows(block, node), shown(O.renderTree(oblock)).has(node), `${label}: whether it shows`);
};
const shown = (nodes) => {
  const out = new Set();
  const stack = [...nodes];
  while (stack.length > 0) {
    const n = stack.pop();
    out.add(n.id);
    stack.push(...n.children);
  }
  return out;
};

// A chain `d0`…: deep enough to cross MAX_DEPTH and MAX_WALK, as a snapshot block.
const DEEP = T.MAX_WALK + 6;
const chainBlock = (ts) => {
  const moves = {};
  let parent = null;
  for (let i = 0; i < DEEP; i++) {
    moves[`d${i}`] = [[ts + i, 'S', parent, 'V']];
    parent = `d${i}`;
  }
  // A second chain under a name no move places, one walk long: a move under
  // its last node walks exactly MAX_WALK steps.
  parent = 'ghost';
  for (let i = 0; i < T.MAX_WALK; i++) {
    moves[`g${i}`] = [[ts + DEEP + i, 'S', parent, 'V']];
    parent = `g${i}`;
  }
  return { k: 'tree', ts: ts + DEEP + T.MAX_WALK - 1, moves };
};

// The moves of a seeded walk by three origins. `deep`: around the two chains,
// else a handful of nodes from nothing — where an op far out of order folds
// the log from scratch.
const walk = (seed, steps, deep) => {
  const rnd = lcg(seed);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const nodes = [];
  for (let i = 0; i < (deep ? 24 : 8); i++) nodes.push(`n${i}`);
  const chain = [];
  const near = [];
  if (deep) {
    for (let i = 0; i < DEEP; i++) chain.push(`d${i}`);
    for (let i = T.MAX_DEPTH - 6; i < DEEP; i++) near.push(`d${i}`);
  } else near.push('n0', 'n1');
  const ghosts = deep ? ['ghost', 'ghost2', `g${T.MAX_WALK - 1}`, 'g3'] : ['ghost', 'ghost2'];
  const anyNode = () => {
    const roll = rnd();
    if (roll < 0.6) return pick(nodes);
    if (roll < 0.8) return pick(near);
    if (roll < 0.9 && deep) return pick(chain);
    return pick(ghosts);
  };
  let ts = 10_000;
  const made = [];
  for (let i = 0; i < steps; i++) {
    const node = anyNode();
    const roll = rnd();
    const parent =
      roll < 0.15 ? null : roll < 0.25 ? T.TRASH : roll < 0.6 ? pick(nodes) : roll < 0.85 ? pick(near) : anyNode();
    if (parent === node) continue;
    // One in twenty under the last stamp again (forged), one in ten under the
    // last stamp's time by another origin (two clocks that read alike).
    const last = made[made.length - 1];
    const roll2 = rnd();
    let stamp = [++ts, pick(['A', 'B', 'C'])];
    if (last !== undefined && roll2 < 0.05) stamp = [last.stamp[0], last.stamp[1]];
    else if (last !== undefined && roll2 < 0.15) stamp = [last.stamp[0], last.stamp[1] === 'A' ? 'B' : 'A'];
    made.push({ stamp, payload: { node, parent, fi: pick(FIS) } });
  }
  return made;
};

// The walk delivered from a pool of `pool` moves — the oldest most often —
// to both folds, compared after every move; now and then an older block is
// read again, the block before is forked, the block goes through JSON, or is
// reset and joined with what fell.
const run = (seed, steps, deep, pool) => {
  const rnd = lcg(seed * 7 + 1);
  const start = deep ? chainBlock(1) : T.createTree();
  let block = JSON.parse(JSON.stringify(start));
  let oblock = JSON.parse(JSON.stringify(start));
  const made = walk(seed, steps, deep);
  const pending = [];
  const history = [];
  let delivered = 0;
  let next = 0;
  while (next < made.length || pending.length > 0) {
    while (next < made.length && pending.length < pool) pending.push(made[next++]);
    const at = rnd() < 0.6 ? 0 : Math.floor(rnd() * pending.length);
    const [op] = pending.splice(at, 1);
    const label = `${deep ? 'deep' : 'small'} seed ${seed}, op ${delivered++}`;
    const r = T.applyTreeMove(block, op.stamp, op.payload);
    const o = oracleMove(oblock, op.stamp, op.payload);
    assert.deepStrictEqual([r.changed, r.reason], [o.changed, o.reason], `${label}: the outcome`);
    assert.deepStrictEqual(r.change, o.change, `${label}: the change report`);
    history.push([block, oblock]);
    block = r.tree;
    oblock = o.tree;
    agree(block, oblock, label);
    reads(block, oblock, op.payload.node, op.payload.parent, label);
    const roll = rnd();
    if (roll < 0.04) {
      // An older block read again: its JSON and its reading as they were.
      const [old, oold] = history[Math.floor(rnd() * history.length)];
      agree(old, oold, `${label}, an older block`);
    } else if (roll < 0.07 && history.length > 1) {
      // A fork: a move landed on the block before, which no longer heads its fold.
      const [old, oold] = history[history.length - 1];
      const fork = T.applyTreeMove(old, [op.stamp[0], 'F'], { node: 'n1', parent: null, fi: 'V' });
      const ofork = oracleMove(oold, [op.stamp[0], 'F'], { node: 'n1', parent: null, fi: 'V' });
      assert.deepStrictEqual(fork.change, ofork.change, `${label}: a fork's change report`);
      if (fork.changed) agree(fork.tree, ofork.tree, `${label}, a fork`);
      agree(block, oblock, `${label}, after the fork`);
    } else if (roll < 0.09) {
      // The JSON round trip: a block read from a file.
      block = JSON.parse(JSON.stringify(block));
      agree(block, oblock, `${label}, from JSON`);
    } else if (roll < 0.1) {
      // A reset under a stamp a few moves back, and a join with what fell.
      const base = [op.stamp[0] - 3, 'A'];
      const pruned = T.pruneTree(block, base);
      const opruned = O.pruneTree(oblock, base);
      if (pruned !== null) {
        agree(pruned, opruned, `${label}, pruned`);
        block = T.joinTrees(pruned, block);
        oblock = O.joinTrees(opruned, oblock);
        agree(block, oblock, `${label}, joined`);
      }
    }
  }
  return delivered;
};

// Moves applied to both folds in the order given, compared after each.
const both = (block, oblock, moves) => {
  for (const [stamp, payload] of moves) {
    const r = T.applyTreeMove(block, stamp, payload);
    const o = oracleMove(oblock, stamp, payload);
    assert.deepStrictEqual(r.change, o.change, JSON.stringify(payload));
    block = r.tree;
    oblock = o.tree;
    agree(block, oblock, JSON.stringify(payload));
  }
  return [block, oblock];
};
const delta = (before) => ({ folds: T.walks.folds - before.folds, undone: T.walks.undone - before.undone });

test('the kept fold reads as the full fold, op by op', async (t) => {
  await t.test('the fold, the reading and the change report agree with the full fold over a seeded walk', () => {
    const before = { ...T.walks };
    let ops = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) ops += run(seed, 260, true, 6);
    for (const seed of [7, 8, 9, 10]) ops += run(seed, 200, false, 24);
    assert.ok(ops > 2000, `${ops} moves delivered`);
    assert.ok(T.walks.undone > before.undone, 'moves older than some were landed by undo and redo');
    assert.ok(T.walks.folds > before.folds, 'and some by a fold from scratch');
  });

  await t.test('a move newest in the fold is one step; an older one undoes the newer and does them again', () => {
    let block = T.createTree();
    let oblock = O.createTree();
    const moves = [];
    for (let i = 0; i < 60; i++) {
      moves.push([[100 + i, 'A'], { node: `n${i}`, parent: i === 0 ? null : `n${Math.floor(i / 3)}`, fi: 'V' }]);
    }
    [block, oblock] = both(block, oblock, moves.slice(0, 1));
    let before = { ...T.walks };
    [block, oblock] = both(block, oblock, moves.slice(1));
    assert.deepStrictEqual(delta(before), { folds: 0, undone: 0 }, 'in stamp order: no fold, nothing undone');
    // A peer's move stamped before the last three: those three undone and done again.
    before = { ...T.walks };
    [block, oblock] = both(block, oblock, [[[156, 'B'], { node: 'n7', parent: 'n40', fi: 'WV' }]]);
    assert.deepStrictEqual(delta(before), { folds: 0, undone: 3 });
    // The reading shares what the move did not touch: n1's subtree is the same object.
    const read = T.renderTree(block);
    const moved = T.applyTreeMove(block, [200, 'A'], { node: 'n59', parent: null, fi: 'XV' });
    const next = T.renderTree(moved.tree);
    assert.strictEqual(next[0].children[0], read[0].children[0], 'an untouched subtree is shared');
    assert.notStrictEqual(next, read);
    assert.deepStrictEqual(read, O.renderTree(oblock), 'and the reading before reads as it did');
    // Far out of order — past half the log — the fold is made again from scratch.
    before = { ...T.walks };
    const far = T.applyTreeMove(moved.tree, [1, 'Z'], { node: 'n5', parent: null, fi: 'UV' });
    const ofar = oracleMove(
      O.applyTreeMove(oblock, [200, 'A'], { node: 'n59', parent: null, fi: 'XV' }).tree,
      [1, 'Z'],
      {
        node: 'n5',
        parent: null,
        fi: 'UV',
      },
    );
    assert.deepStrictEqual(delta(before), { folds: 1, undone: 0 });
    assert.deepStrictEqual(far.change, ofar.change);
    agree(far.tree, ofar.tree, 'far out of order');
  });

  await t.test('a walk exactly MAX_WALK long that ended on a name no move placed is moot once a move places it', () => {
    // g0 … g(MAX_WALK - 1) under `ghost`, which no move places: z under the
    // last walks MAX_WALK steps and takes. Once `ghost` is placed the walk is
    // one step longer: z's move is moot, in any order, as the full fold has it.
    const moves = {};
    let parent = 'ghost';
    for (let i = 0; i < T.MAX_WALK; i++) {
      moves[`g${i}`] = [[i + 1, 'S', parent, 'V']];
      parent = `g${i}`;
    }
    moves.z = [[T.MAX_WALK + 1, 'S', null, 'V']];
    const start = { k: 'tree', ts: T.MAX_WALK + 1, moves };
    const under = [[T.MAX_WALK + 2, 'A'], { node: 'z', parent, fi: 'V' }];
    const ghost = [[T.MAX_WALK + 3, 'B'], { node: 'ghost', parent: null, fi: 'V' }];
    for (const order of [
      [under, ghost],
      [ghost, under],
    ]) {
      const [block] = both(JSON.parse(JSON.stringify(start)), JSON.parse(JSON.stringify(start)), order);
      assert.strictEqual(T.stateOf(block).nodes.get('z').parent, null, 'z stays a root');
      assert.deepStrictEqual(
        T.renderTree(block).map((node) => node.id),
        ['z', 'ghost'],
      );
    }
    const before = { ...T.walks };
    const [taken] = both(JSON.parse(JSON.stringify(start)), JSON.parse(JSON.stringify(start)), [under]);
    assert.strictEqual(T.stateOf(taken).nodes.get('z').parent, parent, 'before ghost: the move takes');
    const after = T.walks.folds;
    T.applyTreeMove(taken, ghost[0], ghost[1]);
    assert.strictEqual(T.walks.folds - after, 1, 'the newest move, folded from scratch');
    assert.ok(T.walks.folds - before.folds >= 2);
  });

  await t.test(
    'a block whose fold moved on reads as it was: its JSON from the next block’s, its fold made again',
    () => {
      // Seven nodes moved in turn, each a few times: a block's JSON is the next
      // one's with the moved node set back, newest first.
      const move = (i) => [[i + 1, 'A'], { node: `n${i % 7}`, parent: i % 3 ? null : `n${(i + 3) % 7}`, fi: 'V' }];
      let block = T.createTree();
      const blocks = [];
      for (let i = 0; i < 30; i++) {
        blocks.push(block);
        block = T.applyTreeMove(block, ...move(i)).tree;
      }
      const replay = (count) => {
        let o = O.createTree();
        for (let i = 0; i < count; i++) o = O.applyTreeMove(o, ...move(i)).tree;
        return o;
      };
      // The newest but one, a middle one, then the oldest: each read through the chain of the ones after it.
      for (const i of [29, 20, 2, 9]) {
        const before = T.walks.folds;
        agree(blocks[i], replay(i), `block ${i}`);
        assert.strictEqual(T.walks.folds - before, 1, 'folded again, once');
      }
      agree(block, replay(30), 'the head');
    },
  );

  await t.test('siblings tied by a forged stamp read in the order of the first move of each that took', () => {
    // b took first, a after it; then one forged stamp moves both under r at
    // one place: they tie on the place and the stamp, and read b, a — the
    // fold's order of their first moves, not their ids — delivered in either order.
    const moves = [
      [[1, 'A'], { node: 'r', parent: null, fi: 'V' }],
      [[2, 'A'], { node: 'b', parent: null, fi: 'WV' }],
      [[3, 'A'], { node: 'a', parent: null, fi: 'XV' }],
      [[9, 'EVIL'], { node: 'a', parent: 'r', fi: 'V' }],
      [[9, 'EVIL'], { node: 'b', parent: 'r', fi: 'V' }],
      [[4, 'B'], { node: 'c', parent: 'r', fi: 'V' }],
      [[1, 'Z'], { node: 'a', parent: null, fi: 'UV' }],
    ];
    const orders = [
      moves,
      [...moves].reverse(),
      [moves[4], moves[0], moves[3], moves[6], moves[1], moves[5], moves[2]],
    ];
    for (const order of orders) {
      const [block] = both(T.createTree(), O.createTree(), order);
      assert.deepStrictEqual(
        T.renderTree(block)[0].children.map((node) => node.id),
        ['c', 'a', 'b'],
        'a took first now (at 1:Z), then b',
      );
    }
    const [block] = both(T.createTree(), O.createTree(), moves.slice(0, 5));
    assert.deepStrictEqual(
      T.renderTree(block)[0].children.map((node) => node.id),
      ['b', 'a'],
    );
    // The same landed by undo and redo: older moves enough that the newer
    // ones are undone, a's first move with them, and done again after it.
    const filler = [];
    for (let i = 0; i < 20; i++) filler.push([[i + 1, 'F'], { node: `f${i}`, parent: null, fi: 'V' }]);
    const late = [
      [[30, 'A'], { node: 'r', parent: null, fi: 'V' }],
      [[31, 'A'], { node: 'b', parent: null, fi: 'WV' }],
      [[32, 'A'], { node: 'a', parent: null, fi: 'XV' }],
      [[39, 'EVIL'], { node: 'a', parent: 'r', fi: 'V' }],
      [[39, 'EVIL'], { node: 'b', parent: 'r', fi: 'V' }],
    ];
    const before = { ...T.walks };
    const [undone] = both(T.createTree(), O.createTree(), [
      ...filler,
      ...late,
      [[30, 'Z'], { node: 'a', parent: null, fi: 'UV' }],
    ]);
    assert.deepStrictEqual(delta(before), { folds: 1, undone: 4 }, 'the empty tree folded, four moves undone');
    const r = T.renderTree(undone).find((node) => node.id === 'r');
    assert.deepStrictEqual(
      r.children.map((node) => node.id),
      ['a', 'b'],
    );
  });

  await t.test(
    'a node at the last level a tree reads keeps no children in the reading, whatever lands under it',
    () => {
      const moves = {};
      let parent = null;
      for (let i = 0; i < T.MAX_DEPTH; i++) {
        moves[`d${i}`] = [[i + 1, 'S', parent, 'V']];
        parent = `d${i}`;
      }
      const start = { k: 'tree', ts: T.MAX_DEPTH, moves };
      const last = `d${T.MAX_DEPTH - 1}`;
      const [block] = both(JSON.parse(JSON.stringify(start)), JSON.parse(JSON.stringify(start)), [
        [[T.MAX_DEPTH + 1, 'A'], { node: 'x', parent: null, fi: 'WV' }],
        [[T.MAX_DEPTH + 2, 'A'], { node: 'x', parent: last, fi: 'V' }],
        [[T.MAX_DEPTH + 3, 'A'], { node: 'y', parent: last, fi: 'V' }],
        [[T.MAX_DEPTH + 4, 'A'], { node: 'x', parent: 'd3', fi: 'V' }],
        [[T.MAX_DEPTH + 5, 'A'], { node: 'd1', parent: last, fi: 'V' }],
        [[T.MAX_DEPTH + 6, 'A'], { node: 'd500', parent: null, fi: 'XV' }],
      ]);
      assert.strictEqual(T.renderTree(block).length, 2);
    },
  );
});

test('a tree through the storage folds a local move, a peer’s page and an outline in one step a move', async () => {
  const { open } = require('../src/all/all.js');
  const { memory } = require('../src/memory/memory.js');
  const storage = await open({ path: '/fold', fsi: memory(), logger: false });
  const peer = await open({ path: '/peer', fsi: memory(), logger: false });
  try {
    const id = await storage.insert({ title: 't' });
    await storage.treeMove(id, 'outline', 'root');
    const before = { ...T.walks };
    await storage.transact(async (tx) => {
      for (let i = 0; i < 200; i++) await tx.treeMove(id, 'outline', `n${i}`, i < 10 ? 'root' : `n${i % 10}`);
    });
    for (let i = 0; i < 50; i++) {
      await storage.treeMove(id, 'outline', `n${i}`, `n${(i * 7 + 3) % 200}`).catch(() => {});
    }
    await storage.treeRemove(id, 'outline', 'n3');
    assert.deepStrictEqual(delta(before), { folds: 0, undone: 0 }, 'local moves: one step each');
    // The same moves as a peer's pages, in order: one step each there too.
    const ops = [];
    for (const { op } of storage.log.read(undefined).entries) ops.push(op);
    // The record and the field's first move (an empty block folded), then the rest.
    await peer.applyRemote(ops.slice(0, 2));
    const page = { ...T.walks };
    await peer.applyRemote(ops.slice(2));
    assert.deepStrictEqual(delta(page), { folds: 0, undone: 0 }, 'a page in stamp order: one step each');
    assert.deepStrictEqual((await peer.get(id)).outline, (await storage.get(id)).outline);
  } finally {
    await storage.close();
    await peer.close();
  }
});
