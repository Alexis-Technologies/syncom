'use strict';

// The sequence engine on its own: keys, run-length content, the Fugue tree
// and its walk, local resolution, pending ops, resets and the join — with
// convergence checked over every arrival order storage can produce.

const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/sequence.js');

// A few nodes over one field, each holding its own block; ops are
// `{ ts, origin, payload }` and stamps come from one monotonic clock.
let clock = 0;
const tick = () => ++clock;
const node = (origin, kind = 't') => ({ origin, seq: S.createSeq(kind) });
const index = (n) => S.buildIndex(n.seq);
const read = (n) => S.render(index(n));
const apply = (n, op, options = {}) => {
  const result = S.applySplice(n.seq, [op.ts, op.origin], op.payload, options.base ?? null, options.pendingMax);
  n.seq = result.seq;
  return result;
};
const insert = (n, i, content) => {
  const place = S.placeInsert(index(n), i, n.origin);
  assert.ok(place !== null, `index ${i} in range`);
  const op = { ts: tick(), origin: n.origin, payload: { ...place, content } };
  apply(n, op);
  return op;
};
const remove = (n, i, count) => {
  const cut = S.rangesOf(index(n), i, count);
  assert.ok(cut !== null);
  const op = { ts: tick(), origin: n.origin, payload: { cut, content: n.seq.k === 't' ? '' : [] } };
  apply(n, op);
  return op;
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
// Every arrival order storage can produce (one origin's ops in order) gives
// the same reading AND the same block.
const assertCommutes = (ops, kind = 't') => {
  const results = permutations(ops)
    .filter(orderedPerOrigin)
    .map((order) => {
      const n = node('fresh', kind);
      for (const op of order) apply(n, op);
      return n;
    });
  for (const n of results) {
    assert.deepStrictEqual(read(n), read(results[0]));
    assert.deepStrictEqual(n.seq, results[0].seq);
  }
  return read(results[0]);
};

test('sequence engine', async (t) => {
  await t.test('keys and anchors parse canonically, whatever the origin holds', () => {
    const run = S.runKey(17, 'a:b:c');
    assert.strictEqual(run, '17:a:b:c');
    assert.deepStrictEqual(S.parseRun(run), { ts: 17, origin: 'a:b:c' });
    const elem = S.elemKey(run, 3);
    assert.strictEqual(elem, '17:3:a:b:c');
    assert.deepStrictEqual(S.parseElem(elem), { ts: 17, offset: 3, origin: 'a:b:c', run });
    for (const bad of ['017:a', '17:', ':a', '17:a@b', '1:00:a', 'x:1:a', 17, null, '17:1:a\u0001']) {
      assert.strictEqual(S.isRunKey(bad) && S.isElemKey(bad), false, String(bad));
    }
    assert.strictEqual(S.isElemKey('017:1:a'), false);
    assert.deepStrictEqual(S.parseAnchor('^'), { side: 'R', elem: null });
    assert.deepStrictEqual(S.parseAnchor('$'), { side: 'L', elem: null });
    assert.strictEqual(S.parseAnchor('<17:3:a').side, 'L');
    assert.strictEqual(S.parseAnchor('>17:3:a').side, 'R');
    for (const bad of ['x', '<bad', '>17:a', '', undefined]) assert.strictEqual(S.isAnchor(bad), false);
  });

  await t.test('run-length content: append joins, cut is a canonical idempotent union, merge takes the longer', () => {
    assert.deepStrictEqual(S.rleAppend('t', ['ab'], 'cd'), ['abcd']);
    assert.deepStrictEqual(S.rleAppend('t', ['ab', 2], 'cd'), ['ab', 2, 'cd']);
    assert.deepStrictEqual(S.rleAppend('l', [[1]], [2, 3]), [[1, 2, 3]]);
    const cut = S.rleCut('t', ['abcdef'], 2, 2);
    assert.deepStrictEqual(cut, ['ab', 2, 'ef']);
    assert.deepStrictEqual(S.rleCut('t', cut, 2, 2), cut, 'a cut seen twice changes nothing');
    assert.deepStrictEqual(S.rleCut('t', cut, 1, 4), ['a', 4, 'f'], 'gaps join');
    assert.deepStrictEqual(S.rleCut('t', ['abc'], 0, 3), [3], 'a run can be all gap — the places stay');
    assert.deepStrictEqual(S.rleCut('t', ['abc'], 2, 10), ['ab', 1], 'past the end is not here');
    assert.strictEqual(S.rleLength(['ab', 4, 'c']), 7);
    const a = ['ab', 1, 'd'];
    const b = ['a', 1, 'cde'];
    const merged = S.rleMerge('t', a, b);
    assert.deepStrictEqual(merged, ['a', 2, 'de']);
    assert.deepStrictEqual(S.rleMerge('t', b, a), merged, 'commutative');
    assert.deepStrictEqual(S.rleMerge('l', [[1, 2]], [[1], 1, [3]]), [[1], 1, [3]]);
    assert.deepStrictEqual(S.normalizeRle('t', ['a', 'b', 1, 2, 'c']), ['ab', 3, 'c'], 'canonicalized');
    assert.strictEqual(S.normalizeRle('t', [['a']]), null, 'a list segment in a text');
    assert.strictEqual(S.normalizeRle('l', ['a']), null);
    assert.strictEqual(S.normalizeRle('t', ['a', 0]), null);
    assert.strictEqual(S.normalizeRle('t', ['']), null);
    assert.strictEqual(S.normalizeRle('t', 'ab'), null);
  });

  await t.test('one node: typing extends its run, a prepend anchors a new one, deletes keep the places', () => {
    const a = node('A');
    for (const ch of 'hello') insert(a, read(a).length, ch);
    assert.strictEqual(read(a), 'hello');
    assert.strictEqual(Object.keys(a.seq.runs).length, 1, 'five keystrokes, one run');
    insert(a, 0, 'x');
    assert.strictEqual(read(a), 'xhello');
    assert.strictEqual(Object.keys(a.seq.runs).length, 2);
    insert(a, 3, 'YZ');
    assert.strictEqual(read(a), 'xheYZllo');
    remove(a, 1, 4);
    assert.strictEqual(read(a), 'xllo');
    const idx = index(a);
    assert.strictEqual(idx.total, 8, 'tombstones stay in the walk');
    assert.strictEqual(idx.length, 4);
    insert(a, 4, '!');
    assert.strictEqual(read(a), 'xllo!');
    assert.strictEqual(S.elemAt(idx, 0), S.elemAt(index(a), 0));
    assert.strictEqual(S.placeInsert(idx, 9, 'A'), null);
    assert.strictEqual(S.rangesOf(idx, 3, 2), null);
    assert.strictEqual(S.elemAt(idx, 4), null);
    assert.strictEqual(S.pendingCount(a.seq, index(a)), 0);
  });

  await t.test('lists hold JSON values and extend like text', () => {
    const a = node('A', 'l');
    insert(a, 0, [{ id: 1 }, 'two']);
    insert(a, 2, [3]);
    assert.deepStrictEqual(read(a), [{ id: 1 }, 'two', 3]);
    assert.strictEqual(Object.keys(a.seq.runs).length, 1);
    remove(a, 1, 1);
    assert.deepStrictEqual(read(a), [{ id: 1 }, 3]);
    insert(a, 0, [0]);
    assert.deepStrictEqual(read(a), [0, { id: 1 }, 3]);
  });

  await t.test('a list moves and assigns: a position and a value register per element', () => {
    const a = node('A', 'l');
    const first = insert(a, 0, ['a', 'b', 'c']);
    const R = S.runKey(first.ts, 'A');
    const idx = index(a);
    const bKey = S.elemAt(idx, 1);
    assert.strictEqual(bKey, S.elemKey(R, 1));
    assert.deepStrictEqual(S.slotAt(idx, 1), [R, 1, 1]);
    // assign: last writer wins by stamp; the same stamp changes nothing.
    const ts1 = tick();
    const assigned = S.applyAssign(a.seq, [ts1, 'A'], { elem: bKey, value: 'B' });
    assert.strictEqual(assigned.changed, true);
    a.seq = assigned.seq;
    assert.deepStrictEqual(read(a), ['a', 'B', 'c']);
    assert.strictEqual(S.applyAssign(a.seq, [ts1 - 1, 'Z'], { elem: bKey, value: 'old' }).changed, false);
    assert.strictEqual(S.applyAssign(a.seq, [ts1, 'A'], { elem: bKey, value: 'B' }).changed, false);
    // move a to the end: cut its slot, add a position run after c, point the register at it.
    const aKey = S.elemAt(idx, 0);
    const mv = {
      ts: tick(),
      origin: 'A',
      payload: { elem: aKey, cut: S.slotAt(idx, 0), at: `>${S.elemKey(R, 2)}`, value: 'a' },
    };
    const moved = S.applyMove(a.seq, [mv.ts, mv.origin], mv.payload);
    assert.strictEqual(moved.changed, true);
    a.seq = moved.seq;
    assert.deepStrictEqual(read(a), ['B', 'c', 'a']);
    assert.strictEqual(S.elemAt(index(a), 2), aKey, 'the element keeps its name across the move');
    assert.deepStrictEqual(a.seq.pos[aKey], [mv.ts, 'A', S.runKey(mv.ts, 'A')]);
    assert.strictEqual(S.applyMove(a.seq, [mv.ts, mv.origin], mv.payload).changed, false, 'idempotent');
    // A concurrent move of the same element by B, stamped newer, wins: the
    // element shows once, at B's place; A's position stays as a dead slot.
    const b = node('B', 'l');
    apply(b, first);
    const mvB = {
      ts: tick(),
      origin: 'B',
      payload: { elem: aKey, cut: S.slotAt(index(b), 0), at: `<${S.elemKey(R, 1)}`, value: 'a' },
    };
    const seqs = [
      [
        first,
        { ts: ts1, origin: 'A', payload: { elem: bKey, value: 'B' }, kind: 'assign' },
        { ...mv, kind: 'move' },
        { ...mvB, kind: 'move' },
      ],
    ];
    for (const ops of seqs) {
      const results = permutations(ops)
        .filter(orderedPerOrigin)
        .map((order) => {
          const n = node('fresh', 'l');
          for (const op of order) {
            const stamp = [op.ts, op.origin];
            const r =
              op.kind === 'assign'
                ? S.applyAssign(n.seq, stamp, op.payload)
                : op.kind === 'move'
                  ? S.applyMove(n.seq, stamp, op.payload)
                  : S.applySplice(n.seq, stamp, op.payload);
            n.seq = r.seq;
          }
          return n;
        });
      for (const n of results) {
        assert.deepStrictEqual(read(n), ['a', 'B', 'c']);
        assert.deepStrictEqual(n.seq, results[0].seq);
      }
    }
    // A cut of the slot an element shows at hides it; a concurrent move brings it back at the new place.
    const c = node('C', 'l');
    apply(c, first);
    const cutA = { ts: tick(), origin: 'C', payload: { cut: [S.slotAt(index(c), 0)], content: [] } };
    apply(c, cutA);
    assert.deepStrictEqual(read(c), ['b', 'c']);
    c.seq = S.applyMove(c.seq, [mvB.ts, 'B'], mvB.payload).seq;
    assert.deepStrictEqual(read(c), ['a', 'b', 'c'], 'resurrected at the moved-to place');
    // Cutting the winning position removes the element for good.
    const gone = S.rangesOf(index(c), 0, 1);
    c.seq = S.applySplice(c.seq, [tick(), 'C'], { cut: gone, content: [] }).seq;
    assert.deepStrictEqual(read(c), ['b', 'c']);
    // join equals replay with registers in it.
    const joined = S.join(a.seq, c.seq);
    const replayed = node('R', 'l');
    for (const op of [first, cutA]) apply(replayed, op);
    replayed.seq = S.applyAssign(replayed.seq, [ts1, 'A'], { elem: bKey, value: 'B' }).seq;
    replayed.seq = S.applyMove(replayed.seq, [mv.ts, 'A'], mv.payload).seq;
    replayed.seq = S.applyMove(replayed.seq, [mvB.ts, 'B'], mvB.payload).seq;
    replayed.seq = S.applySplice(replayed.seq, [gone === null ? 1 : tick(), 'C'], { cut: gone, content: [] }).seq;
    assert.deepStrictEqual(S.render(S.buildIndex(joined)), S.render(S.buildIndex(replayed.seq)));
    // Malformed, and a text refuses both.
    for (const bad of [null, { elem: 'nope', value: 1 }, { elem: aKey }, { elem: aKey, value: () => 1 }]) {
      assert.strictEqual(S.applyAssign(a.seq, [tick(), 'A'], bad).reason, 'malformed', JSON.stringify(bad));
    }
    for (const bad of [
      { elem: aKey, cut: [R, 0, 2], at: '^', value: 1 },
      { elem: aKey, cut: [R, 0, 1], at: '$', value: 1 },
      { elem: aKey, cut: [R, 0, 1], at: `<${S.elemKey(S.runKey(9e15, 'Z'), 0)}`, value: 1 },
      { elem: aKey, cut: [S.runKey(9e15, 'Z'), 0, 1], at: '^', value: 1 },
      { elem: aKey, cut: [R, 0, 1], at: '^' },
    ]) {
      assert.strictEqual(S.applyMove(a.seq, [tick(), 'A'], bad).reason, 'malformed', JSON.stringify(bad));
    }
    const text = node('T');
    const t0 = insert(text, 0, 'ab');
    assert.strictEqual(
      S.applyAssign(text.seq, [tick(), 'T'], { elem: S.elemKey(S.runKey(t0.ts, 'T'), 0), value: 'x' }).reason,
      'malformed',
    );
    // prune drops registers below the base with their runs.
    const pruned = S.prune(a.seq, [mv.ts + 1, 'R']);
    assert.strictEqual(pruned, null, 'everything was stamped below the reset');
  });

  await t.test('marks: anchors take the side the expand rule says, the newest wins, many stack', () => {
    const a = node('A');
    const first = insert(a, 0, 'hello world');
    const R = S.runKey(first.ts, 'A');
    const idx = index(a);
    assert.deepStrictEqual(S.markAnchors(idx, 0, 5, 'after'), [`<${S.elemKey(R, 0)}`, `<${S.elemKey(R, 5)}`]);
    assert.deepStrictEqual(S.markAnchors(idx, 0, 5, 'before'), ['^', `>${S.elemKey(R, 4)}`]);
    assert.deepStrictEqual(S.markAnchors(idx, 6, 11, 'none'), [`<${S.elemKey(R, 6)}`, `>${S.elemKey(R, 10)}`]);
    assert.deepStrictEqual(S.markAnchors(idx, 6, 11, 'both'), [`>${S.elemKey(R, 5)}`, '$']);
    const mark = (n, start, end, key, value, expand = 'after', extra = {}) => {
      const [from, to] = S.markAnchors(index(n), start, end, expand);
      const op = { ts: tick(), origin: n.origin, payload: { start: from, end: to, key, value, ...extra } };
      const r = S.applyMark(n.seq, [op.ts, op.origin], op.payload);
      n.seq = r.seq;
      return op;
    };
    const spansOf = (n) => S.spans(index(n), n.seq);
    const bold = mark(a, 0, 5, 'bold', true);
    assert.deepStrictEqual(spansOf(a), [
      { text: 'hello', marks: { bold: true } },
      { text: ' world', marks: {} },
    ]);
    assert.strictEqual(S.applyMark(a.seq, [bold.ts, 'A'], bold.payload).changed, false, 'first wins on a key');
    // Typing at the end of a bold range grows it; typing before it does not.
    insert(a, 5, '!');
    insert(a, 0, '>');
    assert.deepStrictEqual(spansOf(a), [
      { text: '>', marks: {} },
      { text: 'hello!', marks: { bold: true } },
      { text: ' world', marks: {} },
    ]);
    // A link does not grow at either edge.
    mark(a, 8, 13, 'link', 'https://x', 'none');
    insert(a, 13, '?');
    insert(a, 8, '[');
    assert.deepStrictEqual(spansOf(a).slice(2), [
      { text: ' [', marks: {} },
      { text: 'world', marks: { link: 'https://x' } },
      { text: '?', marks: {} },
    ]);
    // A null mark removes a style over its range — reversed expand — and the newest wins.
    mark(a, 0, 7, 'bold', null, S.REVERSED.after);
    assert.deepStrictEqual(spansOf(a)[0], { text: '>hello! [', marks: {} });
    // Many: comments stack, go only by id.
    const c1 = mark(a, 0, 3, 'comment', { by: 'ada' }, 'none', { many: true });
    const c2 = mark(a, 2, 5, 'comment', { by: 'bob' }, 'none', { many: true });
    const id1 = S.runKey(c1.ts, 'A');
    const id2 = S.runKey(c2.ts, 'A');
    assert.deepStrictEqual(spansOf(a).slice(0, 3), [
      { text: '>h', marks: { comment: [{ id: id1, value: { by: 'ada' } }] } },
      {
        text: 'e',
        marks: {
          comment: [
            { id: id1, value: { by: 'ada' } },
            { id: id2, value: { by: 'bob' } },
          ],
        },
      },
      { text: 'll', marks: { comment: [{ id: id2, value: { by: 'bob' } }] } },
    ]);
    const off = S.applyMark(a.seq, [tick(), 'A'], { off: id1 });
    a.seq = off.seq;
    assert.deepStrictEqual(spansOf(a)[0], { text: '>h', marks: {} });
    assert.strictEqual(S.applyMark(a.seq, [tick(), 'A'], { off: id1 }).changed, false);
    // An off for a mark not here yet waits; the mark then arrives switched off.
    const b = node('B');
    apply(b, first);
    b.seq = S.applyMark(b.seq, [tick(), 'B'], { off: id2 }).seq;
    b.seq = S.applyMark(b.seq, [c2.ts, 'A'], c2.payload).seq;
    assert.deepStrictEqual(spansOf(b), [{ text: 'hello world', marks: {} }]);
    assert.strictEqual(b.seq.marks[id2][4] & S.OFF, S.OFF);
    // Anchors on deleted elements still resolve; below the base they read as the head.
    const c = node('C');
    apply(c, first);
    const em = mark(c, 2, 8, 'em', true);
    c.seq = S.applySplice(c.seq, [tick(), 'C'], { cut: S.rangesOf(index(c), 1, 4), content: '' }).seq;
    assert.deepStrictEqual(spansOf(c), [
      { text: 'h', marks: {} },
      { text: ' wo', marks: { em: true } },
      { text: 'rld', marks: {} },
    ]);
    const pruned = S.prune(c.seq, [em.ts - 1, 'R']);
    assert.deepStrictEqual(Object.keys(pruned.runs), [], 'the run fell; the mark, stamped above, stays');
    assert.deepStrictEqual(S.spans(S.buildIndex(pruned, [em.ts - 1, 'R']), pruned, [em.ts - 1, 'R']), []);
    // Order of arrival changes nothing: marks and inserts from two origins.
    const d = node('D');
    const e = node('E');
    const base = insert(d, 0, 'abc');
    apply(e, base);
    const mD = mark(d, 0, 2, 'bold', true);
    const iE = insert(e, 2, 'X');
    const mE = mark(e, 1, 3, 'bold', null, S.REVERSED.after);
    const ops = [base, { ...mD, kind: 'mark' }, iE, { ...mE, kind: 'mark' }];
    const results = permutations(ops)
      .filter(orderedPerOrigin)
      .map((order) => {
        const n = node('fresh');
        for (const op of order) {
          const r =
            op.kind === 'mark'
              ? S.applyMark(n.seq, [op.ts, op.origin], op.payload)
              : S.applySplice(n.seq, [op.ts, op.origin], op.payload);
          n.seq = r.seq;
        }
        return n;
      });
    for (const n of results) {
      assert.deepStrictEqual(n.seq, results[0].seq);
      assert.deepStrictEqual(spansOf(n), spansOf(results[0]));
    }
    assert.deepStrictEqual(spansOf(results[0]), [
      { text: 'a', marks: { bold: true } },
      { text: 'bXc', marks: {} },
    ]);
    // Malformed, and a list refuses marks.
    for (const bad of [
      null,
      { start: 'x', end: '$', key: 'k', value: 1 },
      { start: '^', end: '$', key: 7, value: 1 },
      { start: '^', end: '$', key: 'k' },
      { start: '^', end: '$', key: 'k', value: 1, many: false },
      { off: 'bad' },
    ]) {
      assert.strictEqual(S.applyMark(a.seq, [tick(), 'A'], bad).reason, 'malformed', JSON.stringify(bad));
    }
    const list = node('L', 'l');
    insert(list, 0, [1]);
    assert.strictEqual(
      S.applyMark(list.seq, [tick(), 'L'], { start: '^', end: '$', key: 'k', value: 1 }).reason,
      'malformed',
    );
  });

  await t.test('concurrent inserts at one spot keep both, in origin order, whatever arrives first', () => {
    const a = node('A');
    const b = node('B');
    const base = insert(a, 0, 'base');
    apply(b, base);
    const fromA = insert(a, 4, 'A');
    const fromB = insert(b, 4, 'B');
    assert.strictEqual(assertCommutes([base, fromA, fromB]), 'baseAB');
    const atStartA = insert(a, 0, 'x');
    const atStartB = insert(b, 0, 'y');
    assert.strictEqual(assertCommutes([base, fromA, fromB, atStartA, atStartB]), 'xybaseAB');
  });

  await t.test('the yjs-interleave case: a backward run stays whole (xab, never axb)', () => {
    // The paper's Appendix A.1.9 (fugue/yjs-interleave): C inserts b; A, who
    // has b, inserts a before it; B, who has seen nothing, inserts x. Yjs
    // reads axb — x inside the backward run ab.
    const c = node('C');
    const bOp = insert(c, 0, 'b');
    const a = node('A');
    apply(a, bOp);
    const aOp = insert(a, 0, 'a');
    const b = node('B');
    const xOp = insert(b, 0, 'x');
    const text = assertCommutes([bOp, aOp, xOp]);
    assert.ok(text === 'xab' || text === 'abx', text);
    assert.notStrictEqual(text, 'axb');
  });

  await t.test('forward and backward runs by two origins never interleave', () => {
    const a = node('A');
    const b = node('B');
    const base = insert(a, 0, '|');
    apply(b, base);
    const ops = [base];
    for (const ch of 'AAAA') ops.push(insert(a, read(a).length, ch));
    for (const ch of 'BBBB') ops.push(insert(b, read(b).length, ch));
    for (const ch of 'aaa') ops.push(insert(a, 0, ch));
    for (const ch of 'bbb') ops.push(insert(b, 0, ch));
    // Too many ops to permute; two arrival orders and a cross-check instead.
    const x = node('X');
    const y = node('Y');
    for (const op of ops) apply(x, op);
    const byOrigin = (origin) => ops.filter((op) => op.origin === origin);
    for (const op of [...byOrigin('B'), ...byOrigin('A')]) apply(y, op);
    assert.strictEqual(read(x), read(y));
    assert.deepStrictEqual(x.seq, y.seq);
    const text = read(x);
    assert.match(text, /^(aaa|bbb)(aaa|bbb)\|(AAAA|BBBB)(AAAA|BBBB)$/, text);
  });

  await t.test('a continuation and a concurrent right child of the same element order by origin', () => {
    const a = node('A');
    const b = node('B');
    const ab = insert(a, 0, 'ab');
    apply(b, ab);
    const xOp = insert(b, 2, 'X'); // B: a right child of b
    const cOp = insert(a, 2, 'c'); // A, unaware of X: extends its run
    assert.deepStrictEqual(cOp.payload, { run: S.runKey(ab.ts, 'A'), from: 2, content: 'c' });
    assert.strictEqual(assertCommutes([ab, xOp, cOp]), 'abcX', 'A < B, so the continuation comes first');
  });

  await t.test('a run, a cut or an extension arriving before what it needs waits, then lands', () => {
    const a = node('A');
    const b = node('B');
    const first = insert(a, 0, 'hello');
    apply(b, first);
    const second = insert(b, 5, ' world');
    const cut = remove(b, 0, 1); // deletes h
    const third = insert(a, 5, '!'); // extension of A's run, concurrent with B
    // A fresh node sees B's ops before A's run exists.
    const c = node('C');
    apply(c, second);
    assert.strictEqual(read(c), '', 'anchored on a run not here yet');
    apply(c, cut);
    assert.strictEqual(c.seq.cuts[first.payload.run ?? S.runKey(first.ts, 'A')].length, 1);
    assert.strictEqual(S.pendingCount(c.seq, index(c)), 2);
    apply(c, first);
    assert.strictEqual(read(c), 'ello world');
    assert.strictEqual(S.pendingCount(c.seq, index(c)), 0);
    apply(c, third);
    assert.strictEqual(read(c), 'ello! world');
    assert.strictEqual(assertCommutes([first, second, cut, third]), 'ello! world');
    // An extension ahead of its run's length waits in `ext`.
    const d = node('D');
    apply(d, first);
    const far = { ts: tick(), origin: 'A', payload: { run: S.runKey(first.ts, 'A'), from: 9, content: '?' } };
    const r = apply(d, far);
    assert.strictEqual(r.changed, true);
    assert.deepStrictEqual(d.seq.ext[S.runKey(first.ts, 'A')], [[9, '?']]);
    apply(d, third); // length 6
    assert.strictEqual(read(d), 'hello!');
    const fill = { ts: tick(), origin: 'A', payload: { run: S.runKey(first.ts, 'A'), from: 6, content: 'abc' } };
    apply(d, fill);
    assert.strictEqual(read(d), 'hello!abc?', 'the extension landed once the gap filled');
    assert.strictEqual(d.seq.ext, undefined);
  });

  await t.test('duplicates, holes and malformed payloads change nothing', () => {
    const a = node('A');
    const op = insert(a, 0, 'ab');
    const again = apply(a, op);
    assert.strictEqual(again.changed, false);
    assert.strictEqual(again.reason, null);
    const b = node('B');
    const hole = apply(b, { ts: tick(), origin: 'A', payload: { run: S.runKey(op.ts, 'A'), from: 2, content: 'c' } });
    assert.strictEqual(hole.changed, false, 'an extension of a run not here is a hole');
    const malformed = [
      undefined,
      {},
      { content: '' },
      { content: ['x'] },
      { cut: [], content: '' },
      { cut: [[S.runKey(op.ts, 'A'), 0, 1]], content: '', at: '^' },
      { cut: [['9999999999999:A', 0, 1]], content: '' },
      { at: '^', run: '1:A', from: 0, content: 'x' },
      { at: `<${S.elemKey(S.runKey(op.ts, 'A'), 0)}`, content: 'x', ts: 0 },
      { at: '$', content: 'x' },
      { cut: 'nope', content: '' },
      { cut: [['1:A', -1, 1]], content: '' },
      { cut: [['1:A', 0, 0]], content: '' },
      { run: 'bad key', from: 0, content: 'x' },
    ];
    for (const payload of malformed) {
      const r = S.applySplice(a.seq, [op.ts, 'A'], payload); // anchor ts >= op ts for the 6th
      assert.strictEqual(r.reason, 'malformed', JSON.stringify(payload));
      assert.strictEqual(r.seq, a.seq);
    }
    const later = S.applySplice(a.seq, [tick(), 'B'], { at: `<${S.elemKey(S.runKey(op.ts, 'A'), 0)}`, content: 'x' });
    assert.strictEqual(later.changed, true, 'the same anchor with a later stamp is fine');
  });

  await t.test('pending work is bounded', () => {
    const a = node('A');
    const options = { pendingMax: 2 };
    const r1 = apply(a, { ts: tick(), origin: 'B', payload: { at: '<5:0:Z', content: 'a' } }, options);
    const r2 = apply(a, { ts: tick(), origin: 'B', payload: { cut: [['5:Z', 0, 1]], content: '' } }, options);
    assert.strictEqual(r1.changed && r2.changed, true);
    const r3 = apply(a, { ts: tick(), origin: 'B', payload: { at: '<6:0:Z', content: 'b' } }, options);
    assert.deepStrictEqual([r3.changed, r3.reason], [false, 'bound']);
    const r4 = apply(a, { ts: tick(), origin: 'B', payload: { run: '5:Z', from: 3, content: 'c' } }, options);
    assert.strictEqual(r4.changed, false, 'an extension of an absent run is a hole, not pending');
    const r5 = apply(a, { ts: tick(), origin: 'B', payload: { at: '^', content: 'ok' } }, options);
    assert.strictEqual(r5.changed, true, 'a resolved run is never bounded');
  });

  await t.test('a reset drops runs below it; a survivor whose anchor fell reads from the head', () => {
    const a = node('A');
    const b = node('B');
    const old = insert(a, 0, 'old');
    apply(b, old);
    const base = [tick(), 'R'];
    const fresh = insert(b, 3, 'new'); // anchored on old's last element, stamped above base
    const pruned = S.prune(b.seq, base);
    assert.deepStrictEqual(Object.keys(pruned.runs), [S.runKey(fresh.ts, 'B')]);
    assert.strictEqual(S.render(S.buildIndex(pruned, base)), 'new', 'the orphan reads as a child of the head');
    assert.strictEqual(S.render(S.buildIndex(pruned)), '', 'without the base it is pending');
    assert.strictEqual(S.prune(a.seq, base), null, 'nothing left');
    assert.strictEqual(S.prune(a.seq, null), a.seq);
    // Applying with a base in force: an op stamped below it is kept out by the caller; here the anchor rule.
    const c = node('C');
    const r = apply(c, fresh, { base });
    assert.strictEqual(r.changed, true);
    assert.strictEqual(S.render(S.buildIndex(c.seq, base)), 'new');
  });

  await t.test('join equals replay: the union of runs, cuts and pending work', () => {
    const a = node('A');
    const b = node('B');
    const first = insert(a, 0, 'abc');
    apply(b, first);
    const cutA = remove(a, 0, 1);
    const moreA = insert(a, 2, 'd');
    const insB = insert(b, 1, 'X');
    const cutB = remove(b, 2, 1); // deletes b
    const pendingOnB = { ts: tick(), origin: 'Z', payload: { at: '<99:0:Q', content: 'q' } };
    apply(b, pendingOnB);
    const joined = S.join(a.seq, b.seq);
    const replayed = node('R');
    for (const op of [first, cutA, moreA, insB, cutB, pendingOnB]) apply(replayed, op);
    assert.deepStrictEqual(joined, replayed.seq);
    assert.deepStrictEqual(S.join(b.seq, a.seq), joined, 'commutative');
    assert.strictEqual(S.render(S.buildIndex(joined)), read(replayed));
  });

  await t.test('normalizeSeq rebuilds a peer’s block and drops what is not well-formed', () => {
    const a = node('A');
    const op = insert(a, 0, 'ab');
    const run = S.runKey(op.ts, 'A');
    const hostile = JSON.parse(
      JSON.stringify({
        k: 't',
        ts: op.ts,
        runs: {
          [run]: ['^', ['a', 'b']],
          ['__proto__']: ['^', ['x']],
          '01:A': ['^', ['x']],
          [S.runKey(op.ts + 1, 'B')]: ['$', ['x']],
          [S.runKey(op.ts + 2, 'B')]: ['^', [['x']]],
          [S.runKey(op.ts + 3, 'B')]: ['^', ['x'], 'elem-not-allowed-in-text'],
        },
        cuts: {
          [run]: [
            [0, 1],
            [1, 0],
            ['x', 1],
          ],
          'bad key': [[0, 1]],
        },
        ext: { [run]: [[2, 'c'], [3, ''], 'nope'] },
        marks: { [run]: ['^', '$', 'bold', true, 1], bad: [] },
        pos: { x: 1 },
      }),
    );
    const seq = S.normalizeSeq(hostile);
    assert.deepStrictEqual(seq, {
      k: 't',
      ts: op.ts,
      runs: { [run]: ['^', ['ab']] },
      cuts: { [run]: [[0, 1]] },
      ext: { [run]: [[2, 'c']] },
      marks: { [run]: ['^', '$', 'bold', true, 1] },
    });
    assert.strictEqual(S.normalizeSeq({ k: 'x', ts: 1, runs: {} }), null);
    assert.strictEqual(S.normalizeSeq({ k: 't', ts: -1, runs: {} }), null);
    assert.strictEqual(S.normalizeSeq(null), null);
    const list = S.normalizeSeq({
      k: 'l',
      ts: 5,
      runs: { '1:A': ['^', [[1]], '1:0:A'] },
      pos: { '1:0:A': [2, 'B', '2:B'] },
      vals: { '1:0:A': [3, 'B', { v: 1 }] },
    });
    assert.deepStrictEqual(list.pos, { '1:0:A': [2, 'B', '2:B'] });
    assert.deepStrictEqual(list.vals, { '1:0:A': [3, 'B', { v: 1 }] });
  });

  await t.test('a 10 000-deep chain walks without recursion; typing forward is one run', () => {
    // Each prepend is a left child of the previous one: a chain as deep as
    // the text is long. Built directly, so the test is about the walk.
    const a = node('A');
    let prev = null;
    for (let i = 0; i < 10_000; i++) {
      const ts = tick();
      const at = prev === null ? S.HEAD : `<${S.elemKey(prev, 0)}`;
      apply(a, { ts, origin: 'A', payload: { at, content: String(i % 10) } });
      prev = S.runKey(ts, 'A');
    }
    const text = read(a);
    assert.strictEqual(text.length, 10_000);
    assert.strictEqual(text[0], '9');
    assert.strictEqual(text.at(-1), '0');
    assert.strictEqual(Object.keys(a.seq.runs).length, 10_000);
    const b = node('B');
    const first = insert(b, 0, 'x');
    const run = S.runKey(first.ts, 'B');
    for (let i = 1; i < 10_000; i++) apply(b, { ts: tick(), origin: 'B', payload: { run, from: i, content: 'x' } });
    assert.strictEqual(Object.keys(b.seq.runs).length, 1);
    assert.strictEqual(read(b).length, 10_000);
    assert.deepStrictEqual(
      S.placeInsert(index(b), 10_000, 'B'),
      { run, from: 10_000 },
      'and the next keystroke extends it',
    );
  });

  await t.test(
    'a run is extended by its origin alone: a stranger’s extension is malformed, whichever arrives first',
    () => {
      // A types abc and types on; a validly signed stranger extends A's run at
      // the same place. Without the rule the result would be whoever came first.
      const a = node('A');
      const first = insert(a, 0, 'abc');
      const run = S.runKey(first.ts, 'A');
      const own = { ts: tick(), origin: 'A', payload: { run, from: 3, content: 'de' } };
      const stranger = { ts: tick(), origin: 'EVIL', payload: { run, from: 3, content: 'XY' } };
      const nodes = [
        [own, stranger],
        [stranger, own],
      ].map((order) => {
        const n = node('N');
        apply(n, first);
        for (const op of order) assert.strictEqual(apply(n, op).reason, op === stranger ? 'malformed' : null);
        return n;
      });
      for (const n of nodes) assert.strictEqual(read(n), 'abcde');
      assert.deepStrictEqual(nodes[1].seq, nodes[0].seq);
      assert.deepStrictEqual(S.join(nodes[0].seq, nodes[1].seq), S.join(nodes[1].seq, nodes[0].seq));
    },
  );

  await t.test(
    'a run and a field are bounded in slots: a gap bomb is dropped at the door, typing past the cap starts a new run',
    () => {
      // A snapshot block with a 300-million-slot gap would be expanded element by element.
      assert.strictEqual(S.normalizeRle('t', [3e8]), null);
      assert.strictEqual(S.normalizeRle('t', ['ab', S.MAX_RUN - 1]), null, 'present items and gaps add up');
      assert.deepStrictEqual(S.normalizeRle('t', ['ab', S.MAX_RUN - 2]), ['ab', S.MAX_RUN - 2]);
      assert.strictEqual(S.normalizeSeq({ k: 't', ts: 1, runs: { '1:A': ['^', [3e8]] } }), null);
      // Four full runs fill a field; a block holding one slot more is not taken as state.
      const runs = Object.fromEntries([1, 2, 3, 4].map((i) => [`${i}:A`, ['^', [S.MAX_RUN]]]));
      const full = S.normalizeSeq({ k: 't', ts: 4, runs });
      assert.strictEqual(S.rleLength(full.runs['4:A'][1]), S.MAX_RUN);
      assert.strictEqual(S.normalizeSeq({ k: 't', ts: 5, runs: { ...runs, '5:A': ['^', ['x']] } }), null);
      // The op path refuses the same: no extension of a full run, no insert into a full field.
      const a = node('A');
      a.seq = { k: 't', ts: 1, runs: { '1:A': ['^', [S.MAX_RUN]] } };
      const ext = apply(a, { ts: tick(), origin: 'A', payload: { run: '1:A', from: S.MAX_RUN, content: 'x' } });
      assert.deepStrictEqual([ext.changed, ext.reason, ext.detail, ext.max], [false, 'bound', 'run', S.MAX_RUN]);
      const big = apply(a, { ts: tick(), origin: 'A', payload: { at: '^', content: 'x'.repeat(S.MAX_RUN + 1) } });
      assert.deepStrictEqual([big.reason, big.detail, big.count], ['bound', 'run', S.MAX_RUN + 1]);
      a.seq = full;
      const over = apply(a, { ts: tick(), origin: 'A', payload: { at: '^', content: 'x' } });
      const expected = ['bound', 'field', S.MAX_FIELD + 1, S.MAX_FIELD];
      assert.deepStrictEqual([over.reason, over.detail, over.count, over.max], expected);
      // Typing at the end of a full run of one's own anchors a new run after its
      // last element — the same reading, one key more.
      const atCap = S.buildIndex({ k: 't', ts: 1, runs: { '1:A': ['^', [S.MAX_RUN - 1, 'x']] } });
      assert.deepStrictEqual(S.placeInsert(atCap, 1, 'A'), { at: `>${S.elemKey('1:A', S.MAX_RUN - 1)}` });
      const short = S.buildIndex({ k: 't', ts: 1, runs: { '1:A': ['^', [S.MAX_RUN - 2, 'x']] } });
      assert.deepStrictEqual(S.placeInsert(short, 1, 'A'), { run: '1:A', from: S.MAX_RUN - 1 });
    },
  );

  await t.test(
    'the snapshot path is bounded like the op path: pending work past it, self-anchored runs, typed-off origins',
    () => {
      // 4 097 pending cuts of runs not here: a block no peer could have built through ops.
      const cuts = {};
      for (let i = 1; i <= S.PENDING_MAX + 1; i++) cuts[`${i}:Z`] = [[0, 1]];
      const flood = { k: 't', ts: 1, runs: { '1:A': ['^', ['a']] }, cuts };
      assert.strictEqual(S.normalizeSeq(flood), null);
      delete cuts[`${S.PENDING_MAX + 1}:Z`];
      assert.ok(S.normalizeSeq(flood) !== null, 'at the bound it is taken');
      // A run anchored at an element as new as itself or newer is nobody's; a mark spanning one, the same.
      const loops = { '5:X': ['>5:0:X', ['x']], '6:X': ['<7:0:X', ['y']], '8:X': ['>7:0:X', ['z']] };
      assert.deepStrictEqual(Object.keys(S.normalizeSeq({ k: 't', ts: 8, runs: loops }).runs), ['8:X']);
      const marks = { '5:B': ['>1:0:A', '<5:0:B', 'b', true, 0], '6:B': ['^', '$', 'b', true, 0] };
      const marked = S.normalizeSeq({ k: 't', ts: 6, runs: { '1:A': ['^', ['ab']] }, marks });
      assert.deepStrictEqual(Object.keys(marked.marks), ['6:B']);
      // A register's origin is a string: a number or null is not one, whatever String() would say.
      const vals = { '1:0:A': [5, 7, 'x'], '1:1:A': [5, null, 'y'] };
      const pos = { '1:0:A': [5, 'B', '2:B'] };
      const typed = S.normalizeSeq({ k: 'l', ts: 5, runs: { '1:A': ['^', [[1, 2]]] }, vals, pos });
      assert.strictEqual(typed.vals, undefined);
      assert.deepStrictEqual(typed.pos, pos);
      // Orphans are read under the entry's base: a run anchored below it is a root, not pending.
      const orphans = {};
      for (let i = 0; i <= S.PENDING_MAX; i++) orphans[`${20 + i}:A`] = ['>5:0:Q', ['x']];
      assert.strictEqual(S.normalizeSeq({ k: 't', ts: 20, runs: orphans }), null, 'without the base they all wait');
      assert.ok(
        S.normalizeSeq({ k: 't', ts: 20, runs: orphans }, [10, 'R']) !== null,
        'under it they read from the head',
      );
    },
  );

  await t.test(
    'registers of elements not here and marks switched off before they arrive count against the bound',
    () => {
      const step = (n, result) => {
        if (result.changed) n.seq = result.seq;
        return result;
      };
      const a = node('A', 'l');
      insert(a, 0, [1, 2]);
      const run = Object.keys(a.seq.runs)[0];
      const assign = (elem, max) => step(a, S.applyAssign(a.seq, [tick(), 'B'], { elem, value: 'v' }, null, max));
      assert.strictEqual(assign(S.elemKey(run, 0), 1).changed, true, 'a held element is never pending');
      assert.strictEqual(assign('9:0:Z', 1).changed, true, 'the first orphan fits a bound of one');
      const stop = assign('9:1:Z', 1);
      assert.deepStrictEqual(
        [stop.changed, stop.reason, stop.detail, stop.count, stop.max],
        [false, 'bound', 'pending', 1, 1],
      );
      assert.strictEqual(
        assign('9:0:Z', 1).changed,
        true,
        'a newer value for an orphan already counted is no more pending',
      );
      const payload = { elem: '9:2:Z', cut: [run, 0, 1], at: '^', value: 1 };
      const moved = step(a, S.applyMove(a.seq, [tick(), 'B'], payload, null, 1));
      assert.deepStrictEqual([moved.changed, moved.reason], [false, 'bound'], 'a move names its element: pending too');
      assert.strictEqual(S.pendingCount(a.seq, index(a)), 1);
      const text = node('T');
      insert(text, 0, 'ab');
      const off = (id, max) => step(text, S.applyMark(text.seq, [tick(), 'B'], { off: id }, null, max));
      assert.strictEqual(off('50:B', 1).changed, true);
      const second = off('51:B', 1);
      assert.deepStrictEqual([second.changed, second.reason], [false, 'bound']);
      assert.strictEqual(off('50:B', 1).changed, false, 'off twice is nothing, not a refusal');
      assert.strictEqual(S.pendingCount(text.seq, index(text)), 1);
    },
  );

  await t.test('join and a repeated cut are idempotent: a pending cut is waited for once', () => {
    const a = node('A');
    const waiting = { ts: tick(), origin: 'B', payload: { cut: [['2:Z', 0, 1]], content: '' } };
    assert.strictEqual(apply(a, waiting).changed, true);
    assert.strictEqual(apply(a, waiting).changed, false, 'the same op again changes nothing');
    const joined = S.join(a.seq, a.seq);
    assert.deepStrictEqual(joined, a.seq);
    assert.deepStrictEqual(S.join(joined, joined), a.seq);
    assert.strictEqual(S.pendingCount(a.seq, index(a)), 1);
    // A cut running past a run's end: what overflows waits once too.
    const b = node('B');
    const first = insert(b, 0, 'abc');
    const over = { ts: tick(), origin: 'C', payload: { cut: [[S.runKey(first.ts, 'B'), 2, 5]], content: '' } };
    assert.strictEqual(apply(b, over).changed, true);
    assert.strictEqual(apply(b, over).changed, false);
    assert.deepStrictEqual(b.seq.cuts, { [S.runKey(first.ts, 'B')]: [[3, 4]] });
    assert.strictEqual(read(b), 'ab');
  });

  await t.test('a mark switched off before it arrives leaves one block, whichever came first', () => {
    const text = node('T');
    const first = insert(text, 0, 'abc');
    const m = tick();
    const o = tick();
    const mark = { ts: m, origin: 'B', payload: { start: '^', end: '$', key: 'bold', value: true } };
    const off = { ts: o, origin: 'B', payload: { off: S.runKey(m, 'B') } };
    const run = (ops) => {
      const n = node('N');
      apply(n, first);
      for (const op of ops) {
        const r = S.applyMark(n.seq, [op.ts, op.origin], op.payload);
        if (r.changed) n.seq = r.seq;
      }
      return n.seq;
    };
    const ab = run([mark, off]);
    const ba = run([off, mark]);
    assert.deepStrictEqual(ba, ab);
    assert.deepStrictEqual(ab.marks[S.runKey(m, 'B')], ['^', '$', 'bold', true, S.OFF]);
    assert.strictEqual(ab.ts, m, 'a placeholder counts by the id it names, as stampsMax does');
    assert.deepStrictEqual(S.normalizeSeq(JSON.parse(JSON.stringify(ba))), ba);
    assert.deepStrictEqual(S.join(ab, run([off])), ab, 'the filled mark wins the join over its placeholder');
    assert.deepStrictEqual(S.join(run([off]), ab), ab);
    assert.deepStrictEqual(S.spans(S.buildIndex(ab), ab), [{ text: 'abc', marks: {} }], 'and off is off');
  });
});
