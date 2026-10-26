'use strict';

// The differential fuzz behind the sequence engine's rope: every reading the
// live engine gives of a text field — the rendered string, each element's
// name, the position of every cursor, the ordinal of every run's anchor, the
// spans — must equal what the legacy walk (tests/utils/walk-oracle.js, the
// engine as of 358d812) computes from the SAME block JSON. Until the rope
// lands the two are one algorithm and this is the harness proving itself;
// after it the oracle reads the rope's toJSON() and the agreement is the
// proof (INVARIANTS SEQ-3). The second half replays the same ops into a
// fresh entry with the origins' streams interleaved another way: the block
// and the reading must not depend on the order of arrival.

const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/text/sequence.js');
const O = require('./utils/walk-oracle.js');
const { applyOp } = require('../src/all/all.js');

const ORIGINS = ['A', 'B', 'C'];
const SEEDS = 40;
const STEPS = 60;

// A small LCG: the same seed gives the same walk on every machine.
const rng = (seed) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const pick = (random, n) => Math.floor(random() * n);

const op = (type, ts, origin, value) => ({ origin, seq: ts, ts, type, id: 'r', key: 'body', value });

const indexOf = (entry) => (entry === null || entry.meta.blocks.body === undefined ? null : S.indexOf(entry, 'body'));

// One step over the single-node state: an insert placed as a local write
// places it (a new run, or an extension of the writer's own run), a cut, a
// mark or an unmark, or a reset through a `write` of other fields.
const step = (entry, ts, random) => {
  const origin = ORIGINS[pick(random, ORIGINS.length)];
  const idx = indexOf(entry);
  const length = idx === null ? 0 : S.lengthOf(idx);
  const roll = random();
  if (idx === null || length === 0 || roll < 0.5) {
    const at = pick(random, length + 1);
    const content = String.fromCharCode(97 + pick(random, 26)).repeat(1 + pick(random, 3));
    const place = idx === null ? { at: S.HEAD } : S.placeInsert(idx, at, origin, content.length);
    return op('splice', ts, origin, { content, ...place });
  }
  if (roll < 0.75) {
    const at = pick(random, length);
    const count = Math.min(length - at, 1 + pick(random, 4));
    return op('splice', ts, origin, { content: '', cut: S.rangesOf(idx, at, count) });
  }
  if (roll < 0.95) {
    const start = pick(random, length);
    const end = start + pick(random, length - start + 1);
    const [from, to] = S.markAnchors(idx, start, end, random() < 0.5 ? 'after' : 'none');
    const value = random() < 0.7 ? true : null;
    return op('mark', ts, origin, { start: from, end: to, key: random() < 0.5 ? 'b' : 'i', value });
  }
  return { origin, seq: ts, ts, type: 'write', id: 'r', data: { other: ts } };
};

// Every reading of the engine against the oracle's over the same JSON.
const agree = (entry, where) => {
  const seq = entry.meta.blocks.body;
  if (seq === undefined) return;
  const base = entry.meta.base;
  const json = JSON.parse(JSON.stringify(seq));
  const index = S.indexOf(entry, 'body');
  const oracle = O.buildIndex(json, base);
  assert.strictEqual(S.render(index), O.render(oracle), `${where}: render`);
  assert.strictEqual(entry.data.body, O.render(oracle), `${where}: data`);
  assert.strictEqual(S.lengthOf(index), oracle.length, `${where}: length`);
  for (let i = 0; i < S.lengthOf(index); i++) {
    assert.strictEqual(S.elemAt(index, i), O.elemAt(oracle, i), `${where}: elemAt ${i}`);
    for (const side of ['before', 'after']) {
      const token = S.cursorAt(index, i, side);
      assert.strictEqual(token, O.cursorAt(oracle, i, side), `${where}: cursorAt ${i} ${side}`);
      assert.strictEqual(S.indexOfCursor(index, token), O.indexOfCursor(oracle, token), `${where}: cursor ${token}`);
    }
  }
  for (const key of Object.keys(json.runs)) {
    const anchor = json.runs[key][0];
    assert.strictEqual(
      S.anchorOrdinal(index, anchor, base),
      O.anchorOrdinal(oracle, anchor, base),
      `${where}: ${anchor}`,
    );
  }
  assert.deepStrictEqual(S.spans(index, seq, base), O.spans(oracle, json, base), `${where}: spans`);
};

// Another order of arrival that the protocol allows: the origins' streams
// interleaved at random, each stream in its own seq order (an origin's ops
// never overtake one another — an extension always follows its run, an
// origin's cut of its own run follows both).
const interleave = (items, random) => {
  const streams = new Map();
  for (const item of items) {
    if (!streams.has(item.origin)) streams.set(item.origin, []);
    streams.get(item.origin).push(item);
  }
  const heads = [...streams.values()];
  const out = [];
  while (heads.length > 0) {
    const i = pick(random, heads.length);
    out.push(heads[i].shift());
    if (heads[i].length === 0) heads.splice(i, 1);
  }
  return out;
};

test('the engine reads a text as the legacy walk does, after every op of a seeded walk', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const random = rng(seed);
    let entry = null;
    const ops = [];
    for (let ts = 1; ts <= STEPS; ts++) {
      const next = step(entry, ts, random);
      ops.push(next);
      entry = applyOp(entry, next).entry;
      agree(entry, `seed ${seed} step ${ts}`);
    }
    // The same ops, another order of arrival: the block is a function of
    // the set of ops, and so is every reading of it.
    let other = null;
    for (const next of interleave(ops, random)) other = applyOp(other, next).entry;
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(other.meta.blocks.body ?? null)),
      JSON.parse(JSON.stringify(entry.meta.blocks.body ?? null)),
      `seed ${seed}: blocks differ by order of arrival`,
    );
    assert.strictEqual(other.data.body, entry.data.body, `seed ${seed}: readings differ by order of arrival`);
    agree(other, `seed ${seed} shuffled`);
  }
});

test('a delete reads its cut from the head: no block is forked, no rope re-hinted', () => {
  const op = (ts, value) => ({ origin: 'A', seq: ts, ts, type: 'splice', id: 'r', key: 'body', value });
  let entry = applyOp(null, op(1, { at: '^', content: 'x'.repeat(2000) })).entry;
  let ts = 1;
  // Typing and deleting across the text, as an editor does.
  for (let i = 0; i < 50; i++) {
    const idx = S.indexOf(entry, 'body');
    entry = applyOp(entry, op(++ts, { ...S.placeInsert(idx, 100 + i * 10, 'A'), content: 'y' })).entry;
  }
  const before = S.stats();
  for (let i = 0; i < 50; i++) {
    const idx = S.indexOf(entry, 'body');
    const { entry: next, changes } = applyOp(entry, op(++ts, { cut: S.rangesOf(idx, 100 + i * 5, 3), content: '' }));
    let cut = 0;
    for (const change of changes) if (change.action === 'splice') cut += change.count;
    assert.strictEqual(cut, 3, 'the three characters, in as many stretches as the runs cut');
    entry = next;
  }
  const after = S.stats();
  assert.strictEqual(after.rebuilds - before.rebuilds, 0, 'no fork of the block before the delete');
  assert.strictEqual(after.rehints - before.rehints, 0, 'no rope re-hinted');
});
