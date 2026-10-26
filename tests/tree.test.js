'use strict';

// The movable tree on its own: the fold of moves in stamp order, cycles
// that never form, the reset rule and the join.

const test = require('node:test');
const assert = require('node:assert');
const T = require('../src/tree/moves.js');

let clock = 0;
const tick = () => ++clock;
const move = (tree, origin, node, parent, fi = 'V', ts = tick()) => {
  const r = T.applyTreeMove(tree, [ts, origin], { node, parent, fi });
  return { tree: r.tree, op: { ts, origin, node, parent, fi }, changed: r.changed };
};
const replay = (ops) => {
  let tree = T.createTree();
  for (const { ts, origin, node, parent, fi } of ops) {
    tree = T.applyTreeMove(tree, [ts, origin], { node, parent, fi }).tree;
  }
  return tree;
};
const permutations = (items) => {
  if (items.length <= 1) return [items];
  const out = [];
  items.forEach((item, i) => {
    for (const tail of permutations([...items.slice(0, i), ...items.slice(i + 1)])) out.push([item, ...tail]);
  });
  return out;
};
const orderedPerOrigin = (ops) => {
  const last = {};
  for (const op of ops) {
    if ((last[op.origin] ?? 0) > op.ts) return false;
    last[op.origin] = op.ts;
  }
  return true;
};
const assertCommutes = (ops, expected) => {
  const results = permutations(ops).filter(orderedPerOrigin).map(replay);
  for (const tree of results) {
    assert.deepStrictEqual(T.renderTree(tree), expected);
    assert.deepStrictEqual(tree, results[0]);
  }
};
const flat = (nodes, depth = 0) =>
  nodes.flatMap((n) => [`${'  '.repeat(depth)}${n.id}`, ...flat(n.children, depth + 1)]);

test('tree', async (t) => {
  await t.test('nodes are created by a move, ordered among siblings, removed under $trash', () => {
    let { tree } = move(T.createTree(), 'A', 'root', null);
    ({ tree } = move(tree, 'A', 'b', 'root', 'V'));
    ({ tree } = move(tree, 'A', 'a', 'root', 'UV'));
    ({ tree } = move(tree, 'A', 'c', 'root', 'WV'));
    ({ tree } = move(tree, 'A', 'c1', 'c'));
    assert.deepStrictEqual(flat(T.renderTree(tree)), ['root', '  a', '  b', '  c', '    c1']);
    assert.deepStrictEqual(
      T.siblings(tree, 'root').map((s) => s.id),
      ['a', 'b', 'c'],
    );
    assert.deepStrictEqual([...T.subtree(tree, 'c')].sort(), ['c', 'c1']);
    ({ tree } = move(tree, 'A', 'c', 'a'));
    assert.deepStrictEqual(flat(T.renderTree(tree)), ['root', '  a', '    c', '      c1', '  b']);
    ({ tree } = move(tree, 'A', 'c', T.TRASH));
    assert.deepStrictEqual(flat(T.renderTree(tree)), ['root', '  a', '  b'], 'the subtree goes with it');
    const again = move(tree, 'B', 'c', 'root', 'XV');
    assert.deepStrictEqual(
      flat(T.renderTree(again.tree)),
      ['root', '  a', '  b', '  c', '    c1'],
      'moved out of the trash, children back',
    );
    // Two children at one place order by stamp; the same stamp twice is nothing.
    const same = move(again.tree, 'A', 'd', 'root', 'XV');
    assert.deepStrictEqual(flat(T.renderTree(same.tree)).slice(-3), ['  c', '    c1', '  d']);
    assert.strictEqual(
      T.applyTreeMove(same.tree, [same.op.ts, 'A'], { node: 'd', parent: 'root', fi: 'XV' }).changed,
      false,
    );
    // A node under a parent that is not here yet is not read until it is.
    const orphan = move(same.tree, 'A', 'e', 'ghost');
    assert.strictEqual(flat(T.renderTree(orphan.tree)).includes('    e'), false);
    const ghost = move(orphan.tree, 'A', 'ghost', 'root', 'YV');
    assert.deepStrictEqual(flat(T.renderTree(ghost.tree)).slice(-2), ['  ghost', '    e']);
  });

  await t.test('concurrent moves that would make a cycle: exactly one takes, the same one everywhere', () => {
    const base = T.createTree();
    const r = move(base, 'A', 'r', null);
    const x = move(r.tree, 'A', 'x', 'r', 'UV');
    const y = move(x.tree, 'A', 'y', 'r', 'WV');
    // Apart: A moves x under y, B moves y under x.
    const underY = move(y.tree, 'A', 'x', 'y');
    const underX = move(y.tree, 'B', 'y', 'x');
    const ops = [r.op, x.op, y.op, underY.op, underX.op];
    assertCommutes(ops, [{ id: 'r', children: [{ id: 'y', children: [{ id: 'x', children: [] }] }] }]);
    // The newer move lost; a later move of y makes the lost one moot and
    // another can land x back where it was.
    const tree = replay(ops);
    const yOut = move(tree, 'C', 'y', 'r', 'XV');
    assert.deepStrictEqual(flat(T.renderTree(yOut.tree)), ['r', '  y', '    x']);
    // A removal concurrent with a move into the removed subtree hides the mover too.
    const trash = move(y.tree, 'A', 'y', T.TRASH);
    const into = move(y.tree, 'B', 'x', 'y');
    assertCommutes([r.op, x.op, y.op, trash.op, into.op], [{ id: 'r', children: [] }]);
    // Three-way: a ring of moves, one lost per the fold.
    const a = move(base, 'A', 'a', null, 'UV');
    const b = move(a.tree, 'A', 'b', null, 'V');
    const c = move(b.tree, 'A', 'c', null, 'WV');
    const ab = move(c.tree, 'A', 'a', 'b');
    const bc = move(c.tree, 'B', 'b', 'c');
    const ca = move(c.tree, 'C', 'c', 'a');
    const ring = [a.op, b.op, c.op, ab.op, bc.op, ca.op];
    const results = permutations(ring).filter(orderedPerOrigin).map(replay);
    for (const t2 of results) assert.deepStrictEqual(t2, results[0]);
    const rendered = flat(T.renderTree(results[0]));
    assert.strictEqual(rendered.length, 3, 'every node is read once');
    assert.ok(rendered.filter((line) => !line.startsWith(' ')).length === 1, 'one root: two moves took, one lost');
  });

  await t.test('a reset drops moves below it; join equals replay; a peer’s block is rebuilt', () => {
    const r = move(T.createTree(), 'A', 'r', null);
    const x = move(r.tree, 'A', 'x', 'r');
    const base = [tick(), 'R'];
    const y = move(x.tree, 'B', 'y', 'r');
    const pruned = T.pruneTree(y.tree, base);
    assert.deepStrictEqual(Object.keys(pruned.moves), ['y'], 'r and x fell below the reset');
    assert.deepStrictEqual(T.renderTree(pruned), [], 'y hangs under a parent that is gone');
    assert.strictEqual(T.pruneTree(x.tree, base), null);
    assert.strictEqual(T.pruneTree(x.tree, null), x.tree);
    const left = replay([r.op, x.op]);
    const right = replay([r.op, y.op]);
    const joined = T.joinTrees(left, right);
    assert.deepStrictEqual(joined, replay([r.op, x.op, y.op]));
    assert.deepStrictEqual(T.joinTrees(right, left), joined);
    const hostile = JSON.parse(
      JSON.stringify({
        k: 'tree',
        ts: 1,
        moves: {
          r: [
            [r.op.ts, 'A', null, 'V'],
            [r.op.ts, 'A', null, 'V'],
            ['x', 'A', null, 'V'],
            [5, 'A', 'r', 7],
          ],
          ['__proto__']: [[1, 'A', null, 'V']],
          [T.TRASH]: [[1, 'A', null, 'V']],
          bad: 'nope',
          self: [[2, 'A', 'self', 'V']],
        },
      }),
    );
    const normalized = T.normalizeTree(hostile);
    assert.deepStrictEqual(normalized, {
      k: 'tree',
      ts: r.op.ts,
      moves: { r: [[r.op.ts, 'A', null, 'V']], self: [[2, 'A', 'self', 'V']] },
    });
    assert.deepStrictEqual(T.renderTree(normalized), [{ id: 'r', children: [] }], 'a self-parent move never takes');
    assert.strictEqual(T.normalizeTree({ moves: {} }), null);
    assert.strictEqual(T.normalizeTree(null), null);
    for (const bad of [
      null,
      { node: 'n' },
      { node: '$trash', parent: null, fi: 'V' },
      { node: 'n', parent: 'n', fi: 'V' },
      { node: 'n', parent: null, fi: '' },
    ]) {
      assert.strictEqual(T.applyTreeMove(x.tree, [tick(), 'A'], bad).reason, 'malformed', JSON.stringify(bad));
    }
  });

  await t.test('moves with one forged stamp fold the same on every node: ties go by node id', () => {
    const r = move(T.createTree(), 'A', 'r', null);
    const x = move(r.tree, 'A', 'x', 'r', 'UV');
    const y = move(x.tree, 'A', 'y', 'r', 'WV');
    const ts = tick();
    const forged = [
      { ts, origin: 'EVIL', node: 'x', parent: 'y', fi: 'V' },
      { ts, origin: 'EVIL', node: 'y', parent: 'x', fi: 'V' },
    ];
    const one = replay([r.op, x.op, y.op, ...forged]);
    const two = replay([r.op, x.op, y.op, forged[1], forged[0]]);
    assert.deepStrictEqual(two, one);
    assert.deepStrictEqual(flat(T.renderTree(one)), ['r', '  y', '    x'], 'x before y: x moves, y’s move would cycle');
    assert.deepStrictEqual(flat(T.renderTree(two)), flat(T.renderTree(one)));
    assert.deepStrictEqual(T.joinTrees(one, two), T.joinTrees(two, one));
  });

  await t.test('a tree reads MAX_DEPTH levels and no deeper: a 4 000-deep chain renders, folds and joins', () => {
    let tree = T.createTree();
    let parent = null;
    for (let i = 0; i < 4000; i++) {
      tree = move(tree, 'A', `n${i}`, parent).tree;
      parent = `n${i}`;
    }
    const rendered = T.renderTree(tree);
    let depth = 0;
    for (let at = rendered; at.length > 0; at = at[0].children) depth++;
    assert.strictEqual(depth, T.MAX_DEPTH);
    assert.ok(JSON.stringify(rendered).length > 0, 'and it serializes');
    const { parentOf } = T.resolve(tree);
    assert.strictEqual(parentOf.get(`n${T.MAX_WALK}`), `n${T.MAX_WALK - 1}`, 'the fold keeps every move it can walk');
    assert.strictEqual(parentOf.has(`n${T.MAX_WALK + 1}`), false, 'a parent past MAX_WALK ancestors: moot');
    assert.deepStrictEqual(T.renderTree(T.joinTrees(tree, tree)), rendered);
    const up = move(tree, 'B', 'n3999', null, 'ZV');
    assert.ok(flat(T.renderTree(up.tree)).includes('n3999'), 'moved up, the deep node shows again');
  });

  await t.test('a chain of 10 000 nodes folds in at most MAX_WALK steps a move, never the chain per move', () => {
    assert.ok(T.MAX_WALK >= T.MAX_DEPTH, 'every parent the tree reads is within the walk');
    const moves = {};
    let parent = null;
    for (let i = 0; i < 10_000; i++) {
      moves[`n${i}`] = [[i + 1, 'A', parent, 'V']];
      parent = `n${i}`;
    }
    // One snapshot block (some 330 KB): the fold of it walked 50 million
    // ancestors, four seconds, on every op that changed the field.
    const chain = T.normalizeTree({ k: 'tree', ts: 10_000, moves });
    const before = T.walks.steps;
    T.resolve(chain);
    const steps = T.walks.steps - before;
    assert.ok(steps <= 10_000 * T.MAX_WALK, `${steps} steps`);
    let depth = 0;
    for (let at = T.renderTree(chain); at.length > 0; at = at[0].children) depth++;
    assert.strictEqual(depth, T.MAX_DEPTH, 'it reads as it did');
  });

  await t.test('a move whose parent sits past MAX_WALK ancestors is moot, on every node and in any order', () => {
    const K = T.MAX_WALK;
    // A chain n0 … nK by A: n(K-1) sits at level K, nK at level K + 1.
    const ops = [];
    let parent = null;
    for (let i = 0; i <= K; i++) {
      ops.push({ ts: tick(), origin: 'A', node: `n${i}`, parent, fi: 'V' });
      parent = `n${i}`;
    }
    // B: z a root, then z under nK — K + 1 ancestors to walk: moot, z stays a
    // root, like a move that would make a cycle; w under n(K-1) — K: it takes.
    ops.push({ ts: tick(), origin: 'B', node: 'z', parent: null, fi: 'WV' });
    ops.push({ ts: tick(), origin: 'B', node: 'z', parent: `n${K}`, fi: 'V' });
    ops.push({ ts: tick(), origin: 'B', node: 'w', parent: `n${K - 1}`, fi: 'V' });
    const forward = replay(ops);
    const shuffled = [...ops];
    let seed = 7;
    for (let i = shuffled.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const j = seed % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const halves = T.joinTrees(replay(ops.filter((op, i) => i % 2 === 0)), replay(ops.filter((op, i) => i % 2 === 1)));
    for (const tree of [replay([...ops].reverse()), replay(shuffled), halves]) {
      assert.deepStrictEqual(tree, forward);
    }
    for (const tree of [forward, halves]) {
      const { parentOf } = T.resolve(tree);
      assert.strictEqual(parentOf.get(`n${K}`), `n${K - 1}`, 'K ancestors: the move takes');
      assert.strictEqual(parentOf.get('z'), null, 'K + 1 ancestors: moot, z stays where it was');
      assert.strictEqual(parentOf.get('w'), `n${K - 1}`);
      assert.deepStrictEqual(
        T.renderTree(tree).map((node) => node.id),
        ['n0', 'z'],
      );
    }
    // Moved up the chain, the same move of z takes.
    const later = move(forward, 'C', `n${K}`, 'n0', 'XV');
    const again = move(later.tree, 'C', 'z', `n${K}`);
    assert.strictEqual(T.resolve(again.tree).parentOf.get('z'), `n${K}`);
  });

  await t.test(
    'a tree field holds MAX_MOVES moves: one more is a bound refusal, a block past it is not taken, a join keeps the oldest',
    () => {
      const moves = {};
      for (let i = 0; i < T.MAX_MOVES; i++) moves[`m${i}`] = [[i + 2, 'A', null, 'V']];
      const full = T.normalizeTree({ k: 'tree', ts: T.MAX_MOVES + 1, moves });
      assert.ok(full !== null, 'at the bound a block is taken');
      const ts = T.MAX_MOVES + 2;
      const over = T.applyTreeMove(full, [ts, 'B'], { node: 'x', parent: null, fi: 'V' });
      assert.deepStrictEqual(over, {
        tree: full,
        changed: false,
        reason: 'bound',
        detail: 'moves',
        count: T.MAX_MOVES + 1,
        max: T.MAX_MOVES,
      });
      const held = T.applyTreeMove(full, [2, 'A'], { node: 'm0', parent: null, fi: 'V' });
      assert.deepStrictEqual([held.changed, held.reason], [false, null], 'a move it holds already is no refusal');
      // A peer's block of one move more is not taken as state.
      const past = { k: 'tree', ts, moves: { ...moves, x: [[ts, 'B', null, 'V']] } };
      assert.strictEqual(T.normalizeTree(past), null);
      // Two pictures joined past it keep the oldest MAX_MOVES moves in the
      // fold's order, whichever side holds them: the newest is what the op
      // path would have refused.
      const newer = replay([{ ts, origin: 'B', node: 'x', parent: null, fi: 'V' }]);
      assert.deepStrictEqual(T.joinTrees(full, newer), full);
      assert.deepStrictEqual(T.joinTrees(newer, full), full);
      const older = replay([{ ts: 1, origin: 'B', node: 'x', parent: null, fi: 'V' }]);
      const joined = T.joinTrees(full, older);
      assert.deepStrictEqual(joined, T.joinTrees(older, full));
      assert.deepStrictEqual(joined.moves.x, [[1, 'B', null, 'V']]);
      assert.strictEqual(joined.moves[`m${T.MAX_MOVES - 1}`], undefined, 'the newest move went');
      assert.strictEqual(joined.ts, T.MAX_MOVES);
      // A reset frees the field.
      const pruned = T.pruneTree(full, [T.MAX_MOVES, 'A']);
      assert.strictEqual(T.applyTreeMove(pruned, [ts, 'B'], { node: 'x', parent: null, fi: 'V' }).changed, true);
    },
  );

  await t.test('a place is a fractional index, or the move is malformed — from an op and from a snapshot alike', () => {
    const r = move(T.createTree(), 'A', 'r', null);
    for (const fi of ['zzz', 'V0', '', 'a'.repeat(T.MAX_FI + 1), 7, null]) {
      const bad = T.applyTreeMove(r.tree, [tick(), 'B'], { node: 'n', parent: 'r', fi });
      assert.deepStrictEqual([bad.changed, bad.reason], [false, 'malformed'], JSON.stringify(fi));
    }
    const long = T.applyTreeMove(r.tree, [tick(), 'B'], { node: 'n', parent: 'r', fi: `${'a'.repeat(T.MAX_FI - 1)}V` });
    assert.strictEqual(long.changed, true, 'a long but valid index is taken');
    const hostile = T.normalizeTree({
      moves: {
        r: [[1, 'A', null, 'V']],
        n: [
          [2, 'B', 'r', 'zzz'],
          [3, 'B@scope', 'r', 'V'],
          [4, 'B', 'r', 'UV'],
        ],
      },
    });
    assert.deepStrictEqual(hostile.moves.n, [[4, 'B', 'r', 'UV']], 'a bad index and an origin with @ are dropped');
  });
});
