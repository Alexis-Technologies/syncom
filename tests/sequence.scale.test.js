'use strict';

// What an op on a big field costs, said through the engine's counters
// (`S.stats()`) rather than the clock: a keystroke into a text of thousands
// of marks reads a few of their anchors, a list op neither reads the list
// whole nor lists its names, a run typed long is held in capped segments,
// a block read from a file is hydrated once. The readings themselves are
// held against the walk in tests/sequence.rope.test.js.

const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/text/sequence.js');
const O = require('./utils/walk-oracle.js');
const { applyOp } = require('../src/all/all.js');

const op = (type, ts, origin, value, key = 'body') => ({ origin, seq: ts, ts, type, id: 'r', key, value });

// A small LCG: the same seed gives the same places on every machine.
const rng = (seed) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

const delta = (before, after, name) => after[name] - before[name];

test('a keystroke into a text of thousands of marks reads a few anchors, never every mark: the index is made once', () => {
  const random = rng(5);
  const pick = (n) => Math.floor(random() * n);
  const LENGTH = 20_000;
  const MARKS = 3000;
  let entry = applyOp(null, op('splice', 1, 'A', { at: '^', content: 'x'.repeat(LENGTH) })).entry;
  let ts = 1;
  const keys = ['bold', 'em', 'link'];
  for (let i = 0; i < MARKS; i++) {
    const a = pick(LENGTH - 1);
    const b = Math.min(LENGTH - 1, a + 1 + pick(300));
    const payload = { start: `<${S.elemKey('1:A', a)}`, end: `<${S.elemKey('1:A', b)}`, key: keys[i % 3], value: true };
    entry = applyOp(entry, op('mark', ++ts, 'A', payload)).entry;
  }
  const type = (origin) => {
    const idx = S.indexOf(entry, 'body');
    const place = S.placeInsert(idx, 1 + pick(S.lengthOf(idx) - 1), origin);
    const result = applyOp(entry, op('splice', ++ts, origin, { ...place, content: 'q' }));
    entry = result.entry;
    return result.changes;
  };
  type('B');
  const before = S.stats();
  let last = null;
  for (let i = 0; i < 100; i++) last = type(i % 2 ? 'B' : 'C');
  const typed = S.stats();
  assert.strictEqual(delta(before, typed, 'markIndexes'), 0, 'the index is kept across the keystrokes');
  const perKeystroke = delta(before, typed, 'anchorReads') / 100;
  assert.ok(perKeystroke < 64, `a keystroke reads ${perKeystroke} anchors of ${2 * MARKS}`);
  // What the keystroke reports reads as spans() shows the character.
  const block = S.indexOf(entry, 'body');
  const { index } = last[0];
  let at = 0;
  for (const span of S.spans(block, block, null)) {
    if (index < at + span.text.length) {
      assert.deepStrictEqual(last[0].marks ?? {}, span.marks, 'the change report carries the style there');
      break;
    }
    at += span.text.length;
  }
  // A mark over it: the index takes it in, a few anchors read.
  for (let i = 0; i < 20; i++) {
    const idx = S.indexOf(entry, 'body');
    const a = pick(S.lengthOf(idx) - 10);
    const [start, end] = S.markAnchors(idx, a, a + 5, 'after');
    entry = applyOp(entry, op('mark', ++ts, 'C', { start, end, key: 'em', value: true })).entry;
  }
  const marked = S.stats();
  assert.strictEqual(delta(typed, marked, 'markIndexes'), 0, 'a mark changes the index, never makes it again');
  const perMark = delta(typed, marked, 'anchorReads') / 20;
  assert.ok(perMark < 128, `a mark reads ${perMark} anchors of ${2 * MARKS}`);
});

test('setAt, move and push on a 20 000-element list neither read it whole nor list its names', () => {
  const random = rng(9);
  const pick = (n) => Math.floor(random() * n);
  const items = [];
  for (let i = 0; i < 20_000; i++) items.push(i);
  let entry = applyOp(null, op('splice', 1, 'A', { at: '^', content: items }, 'items')).entry;
  let ts = 1;
  const before = S.stats();
  for (let i = 0; i < 50; i++) {
    const idx = S.indexOf(entry, 'items');
    const length = S.lengthOf(idx);
    entry = applyOp(entry, op('assign', ++ts, 'A', { elem: S.elemAt(idx, pick(length)), value: -ts }, 'items')).entry;
    const moving = S.indexOf(entry, 'items');
    const from = pick(length);
    const to = (from + 1 + pick(length - 1)) % length;
    const place = S.placeInsert(moving, to < from ? to : to + 1, 'A');
    const at = place.at ?? `>${S.elemKey(place.run, place.from - 1)}`;
    const value = S.valueAt(moving, from);
    const move = { elem: S.elemAt(moving, from), cut: S.slotAt(moving, from), at, value };
    entry = applyOp(entry, op('move', ++ts, 'A', move, 'items')).entry;
    const pushing = S.indexOf(entry, 'items');
    const end = S.placeInsert(pushing, S.lengthOf(pushing), 'A', 1);
    entry = applyOp(entry, op('splice', ++ts, 'A', { ...end, content: [ts] }, 'items')).entry;
  }
  const after = S.stats();
  assert.strictEqual(delta(before, after, 'listRenders'), 0, 'no list read whole');
  assert.strictEqual(delta(before, after, 'elemLists'), 0, 'no names listed');
  const json = JSON.parse(JSON.stringify(entry.meta.blocks.items));
  assert.deepStrictEqual(entry.data.items, S.render(S.hydrate(json, null)), 'and the reading is the list read whole');
});

test('a run typed past SEG_MAX grows by SEG_MAX at most, what was typed sealed in one body; its JSON is one piece and reads the same', () => {
  const MAX = S.SEG_MAX;
  let entry = applyOp(null, op('splice', 1, 'A', { at: '^', content: 'ab' })).entry;
  let ts = 1;
  const before = S.stats();
  let text = 'ab';
  for (let i = 0; i < 3 * MAX + 10; i++) {
    const idx = S.indexOf(entry, 'body');
    const place = S.placeInsert(idx, S.lengthOf(idx), 'A');
    assert.strictEqual(place.run, '1:A', 'every keystroke extends the run');
    const ch = String.fromCharCode(97 + (i % 26));
    entry = applyOp(entry, op('splice', ++ts, 'A', { ...place, content: ch })).entry;
    text += ch;
    const segments = S.segmentsIn(entry.meta.blocks.body, '1:A');
    assert.ok(segments.length <= 2, `${segments.length} segments after ${i + 1} keystrokes`);
    assert.ok(segments[segments.length - 1][1] <= MAX, 'the end being typed holds SEG_MAX slots at most');
  }
  const block = entry.meta.blocks.body;
  const segments = S.segmentsIn(block, '1:A');
  assert.deepStrictEqual(segments, [
    [0, 3 * MAX, true],
    [3 * MAX, text.length - 3 * MAX, true],
  ]);
  assert.strictEqual(delta(before, S.stats(), 'seals'), 3, 'each full segment sealed, once');
  assert.strictEqual(entry.data.body, text);
  const json = JSON.parse(JSON.stringify(block));
  assert.deepStrictEqual(json.runs['1:A'], ['^', [text]], 'the run is one piece, as before');
  const hydrated = S.hydrate(json, null);
  assert.strictEqual(S.render(hydrated), text);
  assert.deepStrictEqual(S.segmentsIn(hydrated, '1:A'), [[0, text.length, true]], 'a piece from a file is one body');
  // A cut across the sealed body's edge and an insert inside it: canonical
  // JSON, the reading the walk's.
  const idx = S.indexOf(entry, 'body');
  const cut = S.rangesOf(idx, MAX - 2, 5);
  entry = applyOp(entry, op('splice', ++ts, 'B', { cut, content: '' })).entry;
  const inside = S.indexOf(entry, 'body');
  entry = applyOp(entry, op('splice', ++ts, 'B', { ...S.placeInsert(inside, 100, 'B'), content: 'QQ' })).entry;
  const after = JSON.parse(JSON.stringify(entry.meta.blocks.body));
  assert.deepStrictEqual(after.runs['1:A'][1], [text.slice(0, MAX - 2), 5, text.slice(MAX + 3)], 'one RLE for the run');
  assert.strictEqual(entry.data.body, O.render(O.buildIndex(after, null)));
  assert.strictEqual(S.render(S.hydrate(after, null)), entry.data.body);
  // A list's run: segments of SEG_MAX at most, laid or pushed.
  let list = applyOp(null, op('splice', 1, 'A', { at: '^', content: [0] }, 'items')).entry;
  const values = [0];
  for (let i = 1; i < 2 * MAX + 5; i++) {
    const at = S.indexOf(list, 'items');
    list = applyOp(list, op('splice', i + 1, 'A', { ...S.placeInsert(at, i, 'A'), content: [i] }, 'items')).entry;
    values.push(i);
  }
  for (const [, len] of S.segmentsIn(list.meta.blocks.items, '1:A')) assert.ok(len <= MAX, `a list segment of ${len}`);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(list.meta.blocks.items)).runs['1:A'], ['^', [values]]);
  assert.deepStrictEqual(list.data.items, values);
  const laid = applyOp(null, op('splice', 1, 'A', { at: '^', content: values }, 'items')).entry;
  const pieces = S.segmentsIn(laid.meta.blocks.items, '1:A');
  assert.strictEqual(pieces.length, 3, 'a list laid at once in segments of SEG_MAX');
  for (const [, len] of pieces) assert.ok(len <= MAX);
  assert.deepStrictEqual(laid.data.items, values);
});

test('a block read from a file is hydrated once: the reading before an op and the op share it, and the entry keeps no copy', () => {
  let entry = applyOp(null, op('splice', 1, 'A', { at: '^', content: 'hello world' })).entry;
  entry = applyOp(entry, op('mark', 2, 'A', { start: '<1:0:A', end: '<1:5:A', key: 'bold', value: true })).entry;
  const loaded = JSON.parse(JSON.stringify({ data: entry.data, meta: entry.meta }));
  const before = S.stats();
  // What resolve reads inside the queue, then the op it resolved.
  const idx = S.indexOf(loaded, 'body');
  const place = S.placeInsert(idx, 5, 'B');
  const { entry: next } = applyOp(loaded, op('splice', 3, 'B', { ...place, content: '!' }));
  assert.strictEqual(next.data.body, 'hello! world');
  assert.strictEqual(delta(before, S.stats(), 'hydrations'), 1, 'one hydration for the reading and the op');
  assert.strictEqual(S.indexOf(loaded, 'body'), idx, 'read again, the same hydration');
  assert.strictEqual(delta(before, S.stats(), 'hydrations'), 1);
  assert.strictEqual(Object.hasOwn(next, 'cache'), false, 'nothing cached on the entry the op made');
  assert.strictEqual(Object.hasOwn(loaded, 'cache'), false, 'nor on the one it was read from');
});

test('a field read from a file reads under its own floor: a run anchored below an unset reads as the data does', () => {
  let entry = applyOp(null, op('splice', 1, 'A', { at: '^', content: 'abc' })).entry;
  entry = applyOp(entry, { origin: 'A', seq: 2, ts: 2, type: 'unset', id: 'r', value: ['body'] }).entry;
  // Typed after the unset by a node that still saw the old text: anchored below the field's floor.
  entry = applyOp(entry, op('splice', 3, 'B', { at: '>1:2:A', content: 'xyz' })).entry;
  assert.strictEqual(entry.data.body, 'xyz');
  const loaded = JSON.parse(JSON.stringify({ data: entry.data, meta: entry.meta }));
  assert.strictEqual(S.render(S.indexOf(loaded, 'body')), 'xyz', 'the reading is the data');
  assert.strictEqual(S.lengthOf(S.indexOf(loaded, 'body')), 3);
});

test('a splice’s markers and an assign to its slot settle by stamp, whichever arrives first', () => {
  const EMBED = '￼';
  const one = { type: 'image', parents: [], attrs: { src: 'a' }, isEmbed: true };
  const two = { type: 'image', parents: [], attrs: { src: 'b' }, isEmbed: true };
  const splice = op('splice', 1, 'A', { at: '^', content: `${EMBED}b`, vals: [[0, one]] });
  // B saw the slot and set its marker, after.
  const assign = op('assign', 2, 'B', { elem: '1:0:A', value: two, k: 't' });
  const inOrder = applyOp(applyOp(null, splice).entry, assign).entry;
  const reversed = applyOp(applyOp(null, assign).entry, splice).entry;
  for (const entry of [inOrder, reversed]) {
    assert.deepStrictEqual(S.valueAt(S.indexOf(entry, 'body'), 0), two, 'the newer marker');
  }
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(reversed.meta.blocks.body)),
    JSON.parse(JSON.stringify(inOrder.meta.blocks.body)),
  );
});

test('a move’s position run holds its element alone: typed after, the element keeps one place; grown by a peer, malformed', () => {
  let entry = applyOp(null, op('splice', 1, 'A', { at: '^', content: [1, 2, 3] }, 'items')).entry;
  // A moves the first element to the end, then pushes after it.
  const idx = S.indexOf(entry, 'items');
  const place = S.placeInsert(idx, 3, 'A');
  const at = place.at ?? `>${S.elemKey(place.run, place.from - 1)}`;
  const move = { elem: S.elemAt(idx, 0), cut: S.slotAt(idx, 0), at, value: S.valueAt(idx, 0) };
  entry = applyOp(entry, op('move', 2, 'A', move, 'items')).entry;
  assert.deepStrictEqual(entry.data.items, [2, 3, 1]);
  const moved = S.indexOf(entry, 'items');
  const push = S.placeInsert(moved, 3, 'A', 1);
  assert.strictEqual(push.run, undefined, 'a run of its own, never the position run grown');
  entry = applyOp(entry, op('splice', 3, 'A', { ...push, content: [9] }, 'items')).entry;
  assert.deepStrictEqual(entry.data.items, [2, 3, 1, 9]);
  const names = S.elems(S.indexOf(entry, 'items'));
  assert.strictEqual(new Set(names).size, names.length, 'every element once');
  // A peer that grows the position run anyway: refused, the field as it was.
  const grown = applyOp(entry, op('splice', 4, 'A', { run: '2:A', from: 1, content: [7] }, 'items'));
  assert.deepStrictEqual(grown.rejected, [{ field: 'items', reason: 'malformed' }]);
  assert.deepStrictEqual(grown.entry.data.items, [2, 3, 1, 9]);
});
