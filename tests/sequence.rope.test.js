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

// ---- the index of the marks, against the walk ---------------------------------

const { compareClock } = require('../src/vector.js');

const below = (elem, base) => base !== null && compareClock([elem.ts, elem.origin], base) < 0;

// The style at every visible index, as the walk's spans read it.
const stylesOf = (oracle, json, base) => {
  const out = [];
  for (const span of O.spans(oracle, json, base)) for (let k = 0; k < span.text.length; k++) out.push(span.marks);
  return out;
};

// `newerRanges` as the walk reads it: every mark of the key in force, newer
// than the stamp, over the visible indices its anchors fall at.
const newerOf = (oracle, json, base, key, stamp, stacked) => {
  const at = (token) => {
    if (token === O.HEAD) return 0;
    if (token === O.END) return oracle.length;
    return below(O.parseAnchor(token).elem, base) ? 0 : O.indexOfCursor(oracle, token);
  };
  const out = [];
  for (const id of Object.keys(json.marks ?? {})) {
    const [from, to, k, , flags] = json.marks[id];
    if (k !== key || (flags & S.OFF) !== 0 || (stacked && (flags & S.MANY) !== 0)) continue;
    const { ts, origin } = O.parseRun(id);
    if (compareClock([ts, origin], stamp) <= 0) continue;
    const start = at(from);
    const end = at(to);
    if (start !== null && end !== null && start < end) out.push([start, end]);
  }
  return out;
};
const byRange = (x, y) => x[0] - y[0] || x[1] - y[1];

// A step that marks more than it types: inserts, cuts, marks of three keys
// (one stacking), marks switched off by id — some never made, which leave a
// placeholder — and resets.
const markStep = (entry, ts, random, made) => {
  const origin = ORIGINS[pick(random, ORIGINS.length)];
  const idx = indexOf(entry);
  const length = idx === null ? 0 : S.lengthOf(idx);
  const roll = random();
  if (idx === null || length === 0 || roll < 0.4) {
    const at = pick(random, length + 1);
    const content = String.fromCharCode(97 + pick(random, 26)).repeat(1 + pick(random, 3));
    const place = idx === null ? { at: S.HEAD } : S.placeInsert(idx, at, origin, content.length);
    return op('splice', ts, origin, { content, ...place });
  }
  if (roll < 0.5) {
    const at = pick(random, length);
    const count = Math.min(length - at, 1 + pick(random, 3));
    return op('splice', ts, origin, { content: '', cut: S.rangesOf(idx, at, count) });
  }
  if (roll < 0.85) {
    const start = pick(random, length);
    const end = start + pick(random, length - start + 1);
    const expand = ['none', 'after', 'before', 'both'][pick(random, 4)];
    const [from, to] = S.markAnchors(idx, start, end, expand);
    const key = ['b', 'i', 'c'][pick(random, 3)];
    const value = key === 'c' ? { n: ts } : random() < 0.75 ? true : null;
    const payload = { start: from, end: to, key, value };
    if (key === 'c') payload.many = true;
    made.push(`${ts}:${origin}`);
    return op('mark', ts, origin, payload);
  }
  if (roll < 0.96) {
    const off = made.length > 0 && random() < 0.8 ? made[pick(random, made.length)] : `${ts - 1}:Z`;
    return op('mark', ts, origin, { off });
  }
  return { origin, seq: ts, ts, type: 'write', id: 'r', data: { other: ts } };
};

// The style at every index and the newer marks of every key, as the engine
// reads them over its index and as the walk reads them over the JSON.
const agreeMarks = (entry, where, random) => {
  const seq = entry.meta.blocks.body;
  if (seq === undefined) return;
  const base = entry.meta.base;
  const json = JSON.parse(JSON.stringify(seq));
  const block = S.indexOf(entry, 'body');
  const oracle = O.buildIndex(json, base);
  const styles = stylesOf(oracle, json, base);
  for (let i = 0; i < styles.length; i++) {
    assert.deepStrictEqual(S.styleAt(block, i, base) ?? {}, styles[i], `${where}: style at ${i}`);
  }
  assert.strictEqual(S.styleAt(block, styles.length, base), null, `${where}: past the end`);
  for (const key of ['b', 'i', 'c']) {
    for (const stacked of [false, true]) {
      const stamp = [pick(random, 80), ORIGINS[pick(random, ORIGINS.length)]];
      const got = S.newerRanges(block, key, stamp, stacked, base).sort(byRange);
      const want = newerOf(oracle, json, base, key, stamp, stacked).sort(byRange);
      assert.deepStrictEqual(got, want, `${where}: newer ${key} than ${stamp}`);
    }
  }
};

test('the index of the marks reads every style as the walk does, kept across the ops of a seeded walk', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const random = rng(1000 + seed);
    let entry = null;
    const ops = [];
    const made = [];
    for (let ts = 1; ts <= 70; ts++) {
      const next = markStep(entry, ts, random, made);
      ops.push(next);
      entry = applyOp(entry, next).entry;
      agreeMarks(entry, `seed ${seed} step ${ts}`, random);
    }
    // Another order of arrival: marks before the runs their anchors name,
    // offs before their marks — the index waits, and is made again.
    let other = null;
    let step = 0;
    for (const next of interleave(ops, random)) {
      other = applyOp(other, next).entry;
      agreeMarks(other, `seed ${seed} shuffled ${++step}`, random);
    }
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(other.meta.blocks.body ?? null)),
      JSON.parse(JSON.stringify(entry.meta.blocks.body ?? null)),
      `seed ${seed}: blocks differ by order of arrival`,
    );
  }
});

// ---- a list's reading, against the list read whole ----------------------------

const listOp = (type, ts, origin, value) => ({ origin, seq: ts, ts, type, id: 'r', key: 'items', value });
const listOf = (entry) => (entry === null || entry.meta.blocks.items === undefined ? null : S.indexOf(entry, 'items'));

// One step over a list: inserts, cuts, assigns and moves as the local calls
// resolve them (src/text/text.js), and resets.
const listStep = (entry, ts, random) => {
  const origin = ORIGINS[pick(random, ORIGINS.length)];
  const idx = listOf(entry);
  const length = idx === null ? 0 : S.lengthOf(idx);
  const roll = random();
  if (idx === null || length === 0 || roll < 0.35) {
    const content = [];
    for (let i = 1 + pick(random, 3); i > 0; i--) content.push(ts * 10 + i);
    const place = idx === null ? { at: S.HEAD } : S.placeInsert(idx, pick(random, length + 1), origin, content.length);
    return listOp('splice', ts, origin, { content, ...place });
  }
  if (roll < 0.5) {
    const at = pick(random, length);
    return listOp('splice', ts, origin, { content: [], cut: S.rangesOf(idx, at, Math.min(length - at, 2)) });
  }
  if (roll < 0.72) return listOp('assign', ts, origin, { elem: S.elemAt(idx, pick(random, length)), value: -ts });
  if (roll < 0.96 && length > 1) {
    const from = pick(random, length);
    const to = (from + 1 + pick(random, length - 1)) % length;
    const place = S.placeInsert(idx, to < from ? to : to + 1, origin);
    const at = place.at ?? `>${S.elemKey(place.run, place.from - 1)}`;
    const payload = { elem: S.elemAt(idx, from), cut: S.slotAt(idx, from), at, value: S.valueAt(idx, from) };
    return listOp('move', ts, origin, payload);
  }
  return { origin, seq: ts, ts, type: 'write', id: 'r', data: { other: ts } };
};

// What the entry holds as the reading — derived op by op — against the same
// block's JSON read whole by the engine and by the walk, and where each
// element stands.
const agreeList = (entry, where) => {
  const seq = entry.meta.blocks.items;
  if (seq === undefined) return assert.strictEqual(entry.data.items, undefined, `${where}: no field`);
  const base = entry.meta.base;
  const json = JSON.parse(JSON.stringify(seq));
  const whole = S.hydrate(json, base);
  assert.deepStrictEqual(entry.data.items, S.render(whole), `${where}: the reading is the list read whole`);
  assert.deepStrictEqual(entry.data.items, O.render(O.buildIndex(json, base)), `${where}: and the walk's`);
  const block = S.indexOf(entry, 'items');
  const names = S.elems(whole);
  for (let i = 0; i < names.length; i++) assert.strictEqual(S.indexOfElem(block, names[i]), i, `${where}: ${i}`);
  return undefined;
};

test('a list reads after every op of a seeded walk as the list read whole: each reading derived from the one before', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const random = rng(2000 + seed);
    let entry = null;
    const ops = [];
    for (let ts = 1; ts <= 60; ts++) {
      const next = listStep(entry, ts, random);
      ops.push(next);
      entry = applyOp(entry, next).entry;
      agreeList(entry, `seed ${seed} step ${ts}`);
    }
    let other = null;
    let step = 0;
    for (const next of interleave(ops, random)) {
      other = applyOp(other, next).entry;
      agreeList(other, `seed ${seed} shuffled ${++step}`);
    }
    assert.deepStrictEqual(other.data.items, entry.data.items, `seed ${seed}: readings differ by order of arrival`);
  }
});
