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
});
