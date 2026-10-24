'use strict';

// The movable tree on its own: the fold of moves in stamp order, cycles
// that never form, the reset rule and the join.

const test = require('node:test');
const assert = require('node:assert');
const T = require('../src/tree.js');

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
});
