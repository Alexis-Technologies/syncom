'use strict';

// The sequence engine against the v1 oracle (tests/utils/engine-v1/, a frozen copy of the engine as it was
// before v2): seeded workloads over three or four origins — random interleavings of their streams,
// duplicate deliveries, a stream's ops now and then out of their order (runs, cuts and extensions that
// wait), embeds with their `vals`, a text's assign, a list's moves and assigns, marks (stacked ones too),
// resets through prune, joins of two pictures, `normalizeSeq` of mutated JSON, a block read back from its
// JSON, ops on an older version (a fork), a small `pendingMax` — and after EVERY op the result
// (`{ changed, reason, detail, count, max }`), the change report the kind would make, the block's JSON
// (key order counts) and every reading the engine offers, read alike on both sides. Removed with the
// oracle at the end of E2: the equivalence is a check of the move to v2, not a guarantee of the engine.
//
// DIFF_SEEDS=<n> runs more seeds, DIFF_OPS=<n> more ops per seed.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { deepEqual } = require('../src/shape.js');

// An engine as a fresh instance: its module state (WeakMaps, counters) its own.
const load = (dir) => {
  for (const key of Object.keys(require.cache)) if (key.startsWith(dir + path.sep)) delete require.cache[key];
  return require(path.join(dir, 'sequence.js'));
};
const ORACLE = load(path.join(__dirname, 'utils', 'engine-v1'));
const ENGINE = load(path.join(__dirname, 'utils', 'engine-v1'));

const SEEDS = Number(process.env.DIFF_SEEDS ?? 200);
const OPS = Number(process.env.DIFF_OPS ?? 240);
const EMBED = '￼';

const rng = (seed) => {
  let state = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const x = Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) >>> 0;
    return ((x ^ (x >>> 12)) >>> 0) / 2 ** 32;
  };
};

// ---- the kind's apply and change report, over an engine (src/text/kind.js as it was) ---------------

const codeOfOp = (op) => {
  if (op.type === 'splice') return typeof op.value?.content === 'string' ? 't' : 'l';
  if (op.type === 'mark') return 't';
  if (op.type === 'assign') return op.value?.k === 't' ? 't' : 'l';
  return 'l';
};

const cutSpansOf = (S, held, cut) => {
  if (!Array.isArray(cut)) return null;
  const cuts = [];
  for (let i = 0; i < cut.length; i++) {
    if (!Array.isArray(cut[i])) continue;
    const spans = S.spansOf(held, cut[i][0], cut[i][1], cut[i][2]);
    if (spans !== null) for (let k = 0; k < spans.length; k++) cuts.push(spans[k]);
  }
  cuts.sort((x, y) => y.index - x.index);
  return cuts;
};

const changeOf = (S, op, stamp, held, block, base, cuts, from) => {
  const payload = op.value;
  const [ts, origin] = stamp;
  if (op.type === 'splice') {
    const out = [];
    let cut = 0;
    if (held !== undefined && cuts !== null) {
      for (let i = 0; i < cuts.length; i++) {
        out.push({ action: 'splice', index: cuts[i].index, count: cuts[i].count });
        cut += cuts[i].count;
      }
    }
    const { content } = payload;
    if (content !== undefined && content.length > 0) {
      const run = payload.at !== undefined ? S.runKey(ts, origin) : payload.run;
      const spans = S.spansOf(block, run, payload.at !== undefined ? 0 : payload.from, content.length) ?? [];
      const shown = S.lengthOf(block) - ((held === undefined ? 0 : S.lengthOf(held)) - cut);
      let own = 0;
      for (const span of spans) own += span.count;
      if (own !== shown || spans.length > 1) return undefined;
      const span = spans[0];
      if (span !== undefined && span.count > 0) {
        const inserted =
          span.count === content.length && block.k === 't'
            ? content.slice()
            : S.valuesAt(block, span.index, span.count);
        const last = out[out.length - 1];
        if (out.length === 1 && last.index === span.index) last.content = inserted;
        else out.push({ action: 'splice', index: span.index, count: 0, content: inserted });
        const change = out[out.length - 1];
        if (payload.vals !== undefined && span.count === content.length) change.vals = payload.vals;
        if (block.k === 't') {
          const marks = S.styleAt(block, span.index, base) ?? {};
          if (Object.keys(marks).length > 0) change.marks = marks;
        }
      }
    }
    return out;
  }
  if (op.type === 'assign') {
    const index = S.indexOfElem(block, payload.elem);
    return index < 0 ? [] : [{ action: 'setAt', index, value: payload.value }];
  }
  if (op.type === 'move') {
    const to = S.indexOfElem(block, payload.elem);
    if (to < 0) return from < 0 ? [] : [{ action: 'splice', index: from, count: 1 }];
    const value = S.valueAt(block, to);
    if (from < 0) return [{ action: 'splice', index: to, count: 0, content: [value] }];
    const out = from === to ? [] : [{ action: 'move', from, to }];
    if (!deepEqual(S.valueAt(held, from), value)) out.push({ action: 'setAt', index: to, value });
    return out;
  }
  if (payload.off !== undefined) {
    const mark = S.markOf(block, payload.off);
    if (mark === undefined || S.isPlaceholder(mark)) return [];
    const start = S.indexOfCursor(block, mark[0]);
    const end = S.indexOfCursor(block, mark[1]);
    if (start === null || end === null) return [];
    return [{ action: 'unmarkById', markId: payload.off, start, end, name: mark[2] }];
  }
  const start = S.indexOfCursor(block, payload.start);
  const end = S.indexOfCursor(block, payload.end);
  if (start === null || end === null || start >= end) return [];
  const markId = S.runKey(ts, origin);
  const many = payload.many === true;
  const piece = (a, b) => {
    const change = { action: 'mark', start: a, end: b, name: payload.key, value: payload.value, markId };
    if (many) change.many = true;
    return change;
  };
  const out = [];
  let at = start;
  for (const [a, b] of S.newerRanges(block, payload.key, stamp, many, base)) {
    if (b <= at) continue;
    if (a >= end) break;
    if (a > at) out.push(piece(at, a));
    at = Math.max(at, b);
    if (at >= end) break;
  }
  if (at < end) out.push(piece(at, end));
  return out;
};

// What the kind does with an op: the block before hydrated under the field's floor, the op applied, the
// result pruned, the change read before and after, a list's reading derived.
const applyKind = (S, held, op, base, pendingMax) => {
  const stamp = [op.ts, op.origin];
  const payload = op.value;
  const before = held === undefined ? undefined : S.asBlock(held, base);
  const block = before ?? S.createSeq(codeOfOp(op));
  const cuts = op.type === 'splice' && before !== undefined ? cutSpansOf(S, before, payload?.cut) : null;
  const from = op.type === 'move' && before !== undefined ? S.indexOfElem(before, payload?.elem) : -1;
  const result =
    op.type === 'splice'
      ? S.applySplice(block, stamp, payload, base, pendingMax)
      : op.type === 'assign'
        ? S.applyAssign(block, stamp, payload, base, pendingMax)
        : op.type === 'move'
          ? S.applyMove(block, stamp, payload, base, pendingMax)
          : S.applyMark(block, stamp, payload, base, pendingMax);
  const summary = { changed: result.changed, reason: result.reason, detail: result.detail };
  summary.count = result.count;
  summary.max = result.max;
  summary.same = result.seq === block;
  if (!result.changed) return { held, summary, change: undefined };
  const pruned = S.prune(result.seq, base);
  summary.pruned = pruned === null ? 'gone' : pruned === result.seq ? 'kept' : 'rebuilt';
  if (pruned === null) return { held: undefined, summary, change: undefined };
  const change = changeOf(S, op, stamp, before, pruned, base, cuts, from);
  if (change !== undefined && before !== undefined && pruned === result.seq) S.deriveLater(before, pruned, change);
  return { held: pruned, summary, change };
};

// ---- readings ---------------------------------------------------------------------------------------

// What to ask a block, chosen off the oracle's block: plain data, so both engines are asked alike.
const probeOf = (S, block, rnd, origins, base) => {
  const length = S.lengthOf(block);
  const pick = (n) => Math.floor(rnd() * n);
  const indices = [0, length, pick(length + 1), pick(length + 1), length > 0 ? length - 1 : 0, -1];
  const keys = Object.keys(block.runs);
  const runs = [];
  for (let i = 0; i < 3 && keys.length > 0; i++) runs.push(keys[pick(keys.length)]);
  runs.push('1:nobody');
  const tokens = [S.HEAD, S.END, '<1:0:nobody', '>bad', 7];
  for (let i = 0; i < (length > 0 ? 3 : 0); i++) {
    const at = pick(length + 1);
    tokens.push(S.cursorAt(block, at, rnd() < 0.5 ? 'after' : 'before'));
  }
  for (const run of runs.slice(0, 2)) {
    const tuple = block.runs[run];
    if (tuple === undefined) continue;
    const len = S.rleLength(tuple[1]);
    tokens.push(`<${S.elemKey(run, pick(len))}`, `>${S.elemKey(run, pick(len + 2))}`);
  }
  const elems = [];
  for (let i = 0; i < (length > 0 ? 3 : 0); i++) elems.push(S.elemAt(block, pick(length)));
  elems.push('1:0:nobody', 'bad');
  for (const key of Object.keys(block.vals ?? {}).slice(0, 2)) elems.push(key);
  for (const key of Object.keys(block.pos ?? {}).slice(0, 2)) elems.push(key);
  const marks = Object.keys(block.marks ?? {});
  const stamps = [
    [0, ''],
    [Number.MAX_SAFE_INTEGER, 'z'],
  ];
  for (const id of marks.slice(0, 2)) {
    const made = S.parseRun(id);
    stamps.push([made.ts, made.origin], [made.ts - 1, 'z']);
  }
  const ranges = [];
  for (let i = 0; i < 3; i++) {
    const a = pick(length + 1);
    ranges.push([a, a + pick(length - a + 2)]);
  }
  return { length, indices, runs, tokens, elems, marks, stamps, ranges, origins, base, roll: rnd() };
};

const readAll = (S, block, probe) => {
  const out = [];
  const put = (name, fn) => {
    try {
      out.push([name, fn()]);
    } catch (error) {
      out.push([name, `throws ${error.constructor.name}`]);
    }
  };
  const { base } = probe;
  put('json', () => JSON.stringify(block));
  put('render', () => S.render(block));
  put('lengthOf', () => S.lengthOf(block));
  put('totalOf', () => S.totalOf(block));
  put('pendingCount', () => S.pendingCount(block));
  const text = block.k === 't';
  for (const i of probe.indices) {
    put(`elemAt ${i}`, () => S.elemAt(block, i));
    put(`heldAt ${i}`, () => S.heldAt(block, i));
    put(`valueAt ${i}`, () => S.valueAt(block, i));
    put(`slotAt ${i}`, () => S.slotAt(block, i));
    put(`valuesAt ${i}`, () => S.valuesAt(block, i, 1 + (i % 3)));
    put(`cursorAt ${i} after`, () => S.cursorAt(block, i, 'after'));
    put(`cursorAt ${i} before`, () => S.cursorAt(block, i, 'before'));
    put(`rangesOf ${i}`, () => S.rangesOf(block, i, Math.min(2, Math.max(0, probe.length - i))));
    put(`rangesOf ${i} over`, () => S.rangesOf(block, i, probe.length + 1));
    for (const origin of probe.origins) put(`placeInsert ${i} ${origin}`, () => S.placeInsert(block, i, origin, 2));
    put(`placeInsert ${i} long`, () => S.placeInsert(block, i, probe.origins[0], S.MAX_RUN));
    if (text) put(`styleAt ${i}`, () => S.styleAt(block, i, base));
  }
  for (const token of probe.tokens) {
    put(`indexOfCursor ${token}`, () => S.indexOfCursor(block, token));
    if (S.isAnchor(token)) put(`anchorOrdinal ${token}`, () => S.anchorOrdinal(block, token, base));
  }
  for (const run of probe.runs) {
    put(`segmentsIn ${run}`, () => S.segmentsIn(block, run));
    for (const [off, len] of [
      [0, 1],
      [0, 1 << 20],
      [1, 2],
      [3, 5],
      [-1, 1],
      [0, 0],
    ]) {
      put(`spansOf ${run} ${off} ${len}`, () => S.spansOf(block, run, off, len));
      put(`spanOf ${run} ${off} ${len}`, () => S.spanOf(block, run, off, len));
    }
  }
  for (const elem of probe.elems) {
    put(`indexOfElem ${elem}`, () => S.indexOfElem(block, elem));
    put(`hasElem ${elem}`, () => S.hasElem(block, elem));
  }
  if (!text) put('elems', () => S.elems(block));
  for (const id of probe.marks) put(`markOf ${id}`, () => S.markOf(block, id));
  if (text) {
    put('spans', () => S.spans(block, block, base));
    put('marksIn', () => S.marksIn(block, block, base));
    for (const key of ['b', 'c', 'i']) {
      for (const stamp of probe.stamps) {
        put(`newerRanges ${key} ${stamp}`, () => S.newerRanges(block, key, stamp, false, base));
        put(`newerRanges ${key} ${stamp} stacked`, () => S.newerRanges(block, key, stamp, true, base));
      }
    }
    for (const [a, b] of probe.ranges) {
      if (b > probe.length) continue;
      for (const expand of ['before', 'after', 'both', 'none']) {
        put(`markAnchors ${a} ${b} ${expand}`, () => S.markAnchors(block, a, b, expand));
      }
    }
  }
  return out;
};

const sameReadings = (a, b, where) => {
  assert.strictEqual(b.length, a.length, `${where}: readings`);
  for (let i = 0; i < a.length; i++) {
    assert.strictEqual(b[i][0], a[i][0], `${where}: reading ${i}`);
    assert.deepStrictEqual(b[i][1], a[i][1], `${where}: ${a[i][0]}`);
  }
};

// ---- the workload -----------------------------------------------------------------------------------

const ORIGINS = ['A', 'B', 'C', 'D'];

const valueOf = (rnd) => {
  const roll = rnd();
  if (roll < 0.3) return Math.floor(rnd() * 100);
  if (roll < 0.55) return `v${Math.floor(rnd() * 20)}`;
  if (roll < 0.7) return { n: Math.floor(rnd() * 9) };
  if (roll < 0.8) return [1, Math.floor(rnd() * 5)];
  if (roll < 0.9) return null;
  return rnd() < 0.5;
};
const markerOf = (rnd) => (rnd() < 0.2 ? null : { type: rnd() < 0.5 ? 'image' : 'paragraph', attrs: { n: 1 } });

const textOf = (rnd, embeds) => {
  const n = 1 + Math.floor(rnd() * (rnd() < 0.1 ? 12 : 4));
  let out = '';
  const vals = [];
  for (let i = 0; i < n; i++) {
    if (embeds && rnd() < 0.15) {
      if (rnd() < 0.85) vals.push([out.length, markerOf(rnd)]);
      out += EMBED;
    } else out += 'abcdefghijklmnopqrstuvwxyz'[Math.floor(rnd() * 26)];
  }
  return { content: out, vals };
};
const listOf = (rnd) => {
  const n = 1 + Math.floor(rnd() * (rnd() < 0.1 ? 10 : 3));
  const out = [];
  for (let i = 0; i < n; i++) out.push(valueOf(rnd));
  return out;
};

// A run key older than `ts` that nobody holds — what a hostile or a far peer's op names.
const phantomRun = (rnd, ts) => `${1 + Math.floor(rnd() * Math.max(1, ts - 1))}:Q${Math.floor(rnd() * 2)}`;

// A local op of `origin` over the oracle's block of a replica (null when there is nothing to do).
const localOp = (S, kind, held, base, origin, ts, rnd, known) => {
  const idx = held === undefined ? null : S.asBlock(held, base);
  const length = idx === null ? 0 : S.lengthOf(idx);
  const pick = (n) => Math.floor(rnd() * n);
  const roll = rnd();
  const empty = kind === 't' ? '' : [];
  const insert = (at, count) => {
    const made = kind === 't' ? textOf(rnd, true) : { content: listOf(rnd), vals: [] };
    const value = { content: made.content };
    if (count > 0) value.cut = S.rangesOf(idx, at, count);
    Object.assign(value, idx === null ? { at: S.HEAD } : S.placeInsert(idx, at, origin, made.content.length));
    if (made.vals.length > 0) value.vals = made.vals;
    return { type: 'splice', value };
  };
  if (length === 0 || roll < 0.32) return insert(length === 0 ? 0 : pick(length + 1), 0);
  if (roll < 0.42) {
    // Typing on at the end of what this origin typed last: its run grown.
    return insert(rnd() < 0.5 ? length : pick(length + 1), 0);
  }
  if (roll < 0.58) {
    const at = pick(length);
    const count = 1 + pick(Math.min(4, length - at));
    if (rnd() < 0.35) return insert(at, count);
    return { type: 'splice', value: { cut: S.rangesOf(idx, at, count), content: empty } };
  }
  if (kind === 'l' && roll < 0.72) {
    const i = pick(length);
    return { type: 'assign', value: { elem: S.elemAt(idx, i), value: valueOf(rnd) } };
  }
  if (kind === 'l' && roll < 0.88) {
    const from = pick(length);
    const to = pick(length);
    const place = S.placeInsert(idx, to < from ? to : to + 1, origin);
    const at = place.at ?? `>${S.elemKey(place.run, place.from - 1)}`;
    return {
      type: 'move',
      value: { elem: S.elemAt(idx, from), cut: S.slotAt(idx, from), at, value: S.valueAt(idx, from) },
    };
  }
  if (kind === 't' && roll < 0.66) {
    // An assign on an embed slot.
    const slots = [];
    for (let i = 0; i < length; i++) if (S.heldAt(idx, i) === EMBED) slots.push(i);
    if (slots.length > 0) {
      const i = slots[pick(slots.length)];
      return { type: 'assign', value: { elem: S.elemAt(idx, i), value: markerOf(rnd), k: 't' } };
    }
  }
  if (kind === 't' && roll < 0.86) {
    const start = pick(length);
    const end = start + 1 + pick(length - start);
    const expand = ['before', 'after', 'both', 'none'][pick(4)];
    const key = ['b', 'i', 'c'][pick(3)];
    const [from, to] = S.markAnchors(idx, start, end, expand);
    const value = { start: from, end: to, key, value: rnd() < 0.2 ? null : rnd() < 0.5 ? true : `x${pick(3)}` };
    if (key === 'c' && rnd() < 0.7) value.many = true;
    return { type: 'mark', value };
  }
  if (kind === 't' && roll < 0.92) {
    const ids = Object.keys(idx.marks ?? {});
    if (ids.length > 0 && rnd() < 0.8) return { type: 'mark', value: { off: ids[pick(ids.length)] } };
    return { type: 'mark', value: { off: rnd() < 0.5 ? phantomRun(rnd, ts) : `${ts}:nobody` } };
  }
  return hostileOp(S, kind, idx, origin, ts, rnd, known);
};

// Well-formed ops about what is not here, and malformed ones: what a far or a hostile peer sends.
const hostileOp = (S, kind, idx, origin, ts, rnd, known) => {
  const pick = (n) => Math.floor(rnd() * n);
  const empty = kind === 't' ? '' : [];
  const content = kind === 't' ? 'qz' : [1, 2];
  const elem = `${1 + pick(Math.max(1, ts - 1))}:${pick(4)}:Q${pick(2)}`;
  const own = known.length > 0 ? known[pick(known.length)] : null;
  const roll = rnd();
  if (roll < 0.15) {
    return { type: 'splice', value: { cut: [[phantomRun(rnd, ts), pick(4), 1 + pick(3)]], content: empty } };
  }
  if (roll < 0.25) return { type: 'splice', value: { at: `${rnd() < 0.5 ? '<' : '>'}${elem}`, content } };
  if (roll < 0.33 && own !== null) {
    // A cut past the end of a run, and an extension ahead of it.
    const tuple = idx?.runs[own];
    const len = tuple === undefined ? 1 : S.rleLength(tuple[1]);
    if (rnd() < 0.5) return { type: 'splice', value: { cut: [[own, len - 1 + pick(2), 2 + pick(3)]], content: empty } };
    if (S.parseRun(own).origin === origin) {
      return { type: 'splice', value: { run: own, from: len + 1 + pick(2), content } };
    }
  }
  if (roll < 0.4) return { type: 'assign', value: { elem, value: 1, ...(kind === 't' ? { k: 't' } : {}) } };
  if (roll < 0.45 && kind === 'l') {
    return { type: 'move', value: { elem, cut: [elem.replace(/:\d+:/, ':'), 0, 1], at: S.HEAD, value: 3 } };
  }
  if (roll < 0.5 && kind === 't') {
    return { type: 'mark', value: { start: `>${elem}`, end: S.END, key: 'b', value: true } };
  }
  const bad = [
    { type: 'splice', value: null },
    { type: 'splice', value: { content: 5 } },
    { type: 'splice', value: { content: empty, cut: [] } },
    { type: 'splice', value: { content } },
    { type: 'splice', value: { content, at: S.END } },
    { type: 'splice', value: { content, at: `<${ts}:0:${origin}` } },
    { type: 'splice', value: { content, run: 'bad', from: 0 } },
    { type: 'splice', value: { content, run: `${Math.max(1, ts - 1)}:${origin}x`, from: 0 } },
    { type: 'splice', value: { content: empty, cut: [['bad', 0, 1]] } },
    { type: 'splice', value: { content: empty, cut: [[`${ts}:${origin}`, 0, 1]] } },
    { type: 'splice', value: { content: empty, cut: [[phantomRun(rnd, ts), -1, 1]] } },
    { type: 'splice', value: { content: empty, cut: [[phantomRun(rnd, ts), 0, 0]] } },
    { type: 'splice', value: { content: empty, cut: 'x' } },
    { type: 'splice', value: { content: kind === 't' ? 'ab' : [1], at: S.HEAD, vals: [[5, {}]] } },
    { type: 'splice', value: { content: kind === 't' ? 'ab' : [1], at: S.HEAD, vals: 'x' } },
    { type: 'splice', value: { content: empty, cut: [[phantomRun(rnd, ts), 0, 1]], vals: [] } },
    { type: 'splice', value: { content, at: S.HEAD, run: own ?? '1:A', from: 0 } },
    { type: 'assign', value: { elem: 'bad', value: 1 } },
    { type: 'assign', value: { elem, value: undefined } },
    { type: 'assign', value: 3 },
    { type: 'move', value: { elem, cut: ['bad', 0, 1], at: S.HEAD, value: 1 } },
    { type: 'move', value: { elem, cut: [elem, 0, 2], at: S.HEAD, value: 1 } },
    { type: 'move', value: { elem: 'x', cut: [phantomRun(rnd, ts), 0, 1], at: S.HEAD, value: 1 } },
    { type: 'move', value: { elem, cut: [phantomRun(rnd, ts), 0, 1], at: S.END, value: 1 } },
    { type: 'mark', value: { start: S.HEAD, end: S.END, key: 5, value: 1 } },
    { type: 'mark', value: { start: 'x', end: S.END, key: 'b', value: 1 } },
    { type: 'mark', value: { start: S.HEAD, end: S.END, key: 'b', value: 1, many: 'yes' } },
    { type: 'mark', value: { off: 'bad' } },
    { type: 'mark', value: null },
  ];
  return bad[pick(bad.length)];
};

// A peer's block as JSON, damaged here and there: what normalizeSeq must take apart alike.
const mutate = (raw, rnd, ts) => {
  const pick = (n) => Math.floor(rnd() * n);
  const roll = rnd();
  const keys = Object.keys(raw.runs ?? {});
  if (roll < 0.15 && keys.length > 0) delete raw.runs[keys[pick(keys.length)]];
  else if (roll < 0.25 && keys.length > 0) raw.runs[keys[pick(keys.length)]] = [raw.k === 't' ? ['x'] : 'x', 5];
  else if (roll < 0.32 && keys.length > 0) raw.runs[keys[pick(keys.length)]][1] = [0];
  else if (roll < 0.4) raw.runs[`${ts + 5}:Z`] = [`<${ts + 9}:0:Z`, raw.k === 't' ? ['x'] : [[1]]];
  else if (roll < 0.48) (raw.cuts ??= {})[phantomRun(rnd, ts)] = [[0, 2], ['x'], [1, 0]];
  else if (roll < 0.55) {
    const ext = (raw.ext ??= {});
    ext[phantomRun(rnd, ts)] = [
      [3, raw.k === 't' ? 'yy' : [1]],
      [1, ''],
    ];
  } else if (roll < 0.62) (raw.vals ??= {})[`${pick(ts)}:1:Q0`] = [pick(ts) + 1, 'Q0', 7];
  else if (roll < 0.68) (raw.pos ??= {})[`${pick(ts)}:0:Q1`] = [pick(ts) + 1, 'Q1', phantomRun(rnd, ts)];
  else if (roll < 0.74) (raw.marks ??= {})[phantomRun(rnd, ts)] = [S0.HEAD, S0.END, 'b', true, pick(5)];
  else if (roll < 0.78) raw.k = 'x';
  else if (roll < 0.82) raw.runs = 7;
  else if (roll < 0.86) raw.ts = 'later';
  return raw;
};
const S0 = ORACLE;

const summaryOf = (S, block) => (block === undefined ? 'none' : block === null ? 'null' : JSON.stringify(block));

// What the workloads reached, counted: the test says each was reached at all.
const reached = new Map();
const reach = (what) => reached.set(what, (reached.get(what) ?? 0) + 1);

const runSeed = (seed, ops) => {
  const rnd = rng(seed);
  const pick = (n) => Math.floor(rnd() * n);
  const kind = rnd() < 0.5 ? 't' : 'l';
  const count = 3 + pick(2);
  const origins = ORIGINS.slice(0, count);
  const pendingMax = [2, 4, 8, 4096][pick(4)];
  let clock = 0;
  // Each origin's stream, in the order it made its ops.
  const streams = new Map(origins.map((o) => [o, []]));
  const replicas = origins.map((origin) => ({
    origin,
    a: undefined,
    b: undefined,
    base: null,
    history: [],
    delivered: new Map(origins.map((o) => [o, new Set()])),
  }));
  const known = [];
  let step = 0;
  const where = () => `seed ${seed} (${kind}, pendingMax ${pendingMax}) step ${step}`;
  const compareHeld = (r, label) => {
    assert.strictEqual(summaryOf(ENGINE, r.b), summaryOf(ORACLE, r.a), `${where()}: ${label}: the block`);
    if (r.a === undefined) return;
    const probe = probeOf(ORACLE, ORACLE.asBlock(r.a, r.base), rnd, origins, r.base);
    const ia = ORACLE.asBlock(r.a, r.base);
    const ib = ENGINE.asBlock(r.b, r.base);
    sameReadings(readAll(ORACLE, ia, probe), readAll(ENGINE, ib, probe), `${where()}: ${label}`);
  };
  const remember = (r) => {
    r.history.push({ a: r.a, b: r.b, base: r.base });
    if (r.history.length > 6) r.history.shift();
  };
  const applyBoth = (r, op, label, from = r) => {
    const x = applyKind(ORACLE, from.a, op, r.base, pendingMax);
    const y = applyKind(ENGINE, from.b, op, r.base, pendingMax);
    assert.deepStrictEqual(y.summary, x.summary, `${where()}: ${label}: the result of ${JSON.stringify(op)}`);
    assert.deepStrictEqual(y.change, x.change, `${where()}: ${label}: the change of ${JSON.stringify(op)}`);
    const { summary } = x;
    reach(
      `${kind} ${op.type} ${summary.changed ? 'changed' : (summary.reason ?? 'unchanged')}${summary.detail ? ` ${summary.detail}` : ''}`,
    );
    if (summary.pruned !== undefined && summary.pruned !== 'kept') reach(`pruned ${summary.pruned}`);
    if (x.change === undefined && summary.changed) reach('a change read as a reset');
    return [x.held, y.held];
  };
  for (step = 0; step < ops; step++) {
    const r = replicas[pick(replicas.length)];
    const roll = rnd();
    if (roll < 0.39) {
      // A local op, logged in its origin's stream.
      const ts = ++clock;
      const value = localOp(ORACLE, kind, r.a, r.base, r.origin, ts, rnd, known);
      const op = { ...value, ts, origin: r.origin };
      remember(r);
      [r.a, r.b] = applyBoth(r, op, 'local');
      streams.get(r.origin).push(op);
      r.delivered.get(r.origin).add(streams.get(r.origin).length - 1);
      if (op.type === 'splice' && op.value?.at !== undefined) known.push(`${ts}:${r.origin}`);
      compareHeld(r, 'local');
    } else if (roll < 0.77) {
      // A peer's op: the next of its stream, now and then one ahead of it, or one seen already.
      const others = origins.filter((o) => o !== r.origin);
      const o = others[pick(others.length)];
      const stream = streams.get(o);
      const seen = r.delivered.get(o);
      let i = 0;
      while (seen.has(i)) i++;
      const late = rnd();
      if (late < 0.08 && seen.size > 0) i = [...seen][pick(seen.size)];
      else if (late < 0.16 && !seen.has(i + 1) && i + 1 < stream.length) i++;
      if (i >= stream.length) continue;
      seen.add(i);
      remember(r);
      [r.a, r.b] = applyBoth(r, stream[i], `remote ${o}#${i}`);
      compareHeld(r, 'remote');
    } else if (roll < 0.8) {
      // A reset: the field's floor raised, the block pruned at once.
      const ts = Math.max(1, clock - pick(Math.max(1, clock >> 1)));
      const stamp = [ts, rnd() < 0.5 ? origins[pick(origins.length)] : 'M'];
      if (r.base !== null && (stamp[0] < r.base[0] || (stamp[0] === r.base[0] && stamp[1] <= r.base[1]))) continue;
      r.base = stamp;
      remember(r);
      const pa = r.a === undefined ? undefined : ORACLE.prune(r.a, r.base);
      const pb = r.b === undefined ? undefined : ENGINE.prune(r.b, r.base);
      r.a = pa ?? undefined;
      r.b = pb ?? undefined;
      compareHeld(r, `reset ${stamp}`);
    } else if (roll < 0.86) {
      // A snapshot from another replica: its block as JSON (damaged now and then), normalized, joined.
      const other = replicas[pick(replicas.length)];
      if (other === r || other.a === undefined) continue;
      const text = JSON.stringify(other.a);
      assert.strictEqual(JSON.stringify(other.b), text, `${where()}: the snapshot`);
      const damage = rnd() < 0.3;
      const rawA = damage ? mutate(JSON.parse(text), rng(seed * 31 + step), clock) : JSON.parse(text);
      const rawB = damage ? mutate(JSON.parse(text), rng(seed * 31 + step), clock) : JSON.parse(text);
      const ta = ORACLE.normalizeSeq(rawA, r.base, pendingMax);
      const tb = ENGINE.normalizeSeq(rawB, r.base, pendingMax);
      assert.strictEqual(summaryOf(ENGINE, tb), summaryOf(ORACLE, ta), `${where()}: normalizeSeq`);
      reach(ta === null ? 'normalized to nothing' : damage ? 'normalized after damage' : 'normalized');
      if (ta === null) continue;
      remember(r);
      if (r.a === undefined) {
        r.a = ta;
        r.b = tb;
      } else {
        const ja = ORACLE.prune(ORACLE.join(ORACLE.asBlock(r.a, r.base), ta), r.base);
        const jb = ENGINE.prune(ENGINE.join(ENGINE.asBlock(r.b, r.base), tb), r.base);
        r.a = ja ?? undefined;
        r.b = jb ?? undefined;
      }
      reach('joined');
      compareHeld(r, `join from ${other.origin}`);
    } else if (roll < 0.9) {
      // The block read back from its JSON: plain, hydrated by the next reading or op.
      if (r.a === undefined) continue;
      const text = JSON.stringify(r.a);
      r.a = JSON.parse(text);
      r.b = JSON.parse(text);
      compareHeld(r, 'from JSON');
    } else if (roll < 0.96) {
      // An older version: read, or forked by an op (a group that failed, a rehearsal).
      if (r.history.length === 0) continue;
      const old = r.history[pick(r.history.length)];
      if (old.a !== undefined) {
        const ia = ORACLE.asBlock(old.a, old.base);
        const ib = ENGINE.asBlock(old.b, old.base);
        const probe = probeOf(ORACLE, ia, rnd, origins, old.base);
        sameReadings(readAll(ORACLE, ia, probe), readAll(ENGINE, ib, probe), `${where()}: an older version`);
      }
      if (rnd() < 0.5 || old.base !== r.base) continue;
      const ts = ++clock;
      const value = localOp(ORACLE, kind, old.a, old.base, r.origin, ts, rnd, known);
      const op = { ...value, ts, origin: r.origin };
      const [fa, fb] = applyBoth(r, op, 'fork', old);
      reach('forked');
      if (rnd() < 0.5) {
        // The fork read, then dropped: the head goes on.
        if (fa !== undefined) {
          const probe = probeOf(ORACLE, ORACLE.asBlock(fa, r.base), rnd, origins, r.base);
          sameReadings(readAll(ORACLE, fa, probe), readAll(ENGINE, fb, probe), `${where()}: a fork`);
        }
        clock--;
      } else {
        // The fork goes on, logged: the versions after `old` never were.
        remember(r);
        r.a = fa;
        r.b = fb;
        streams.get(r.origin).push(op);
        r.delivered.get(r.origin).add(streams.get(r.origin).length - 1);
        compareHeld(r, 'fork');
      }
    } else {
      // A replica's current block read again, after others moved on.
      compareHeld(r, 'again');
    }
  }
  return { kind, steps: ops };
};

// Long typing: sessions of one origin typing at a cursor, a keystroke an op, past SEG_MAX in one run, with
// deletes behind the cursor and another origin's sessions between — a deep rope, sealed segments.
const runLong = (seed, kind, ops) => {
  const rnd = rng(seed);
  const pick = (n) => Math.floor(rnd() * n);
  const origins = ['A', 'B', 'C'];
  let a;
  let b;
  let clock = 0;
  let origin = 'A';
  let cursor = 0;
  let left = 0;
  let deletes = 0;
  for (let step = 0; step < ops; step++) {
    const where = `long seed ${seed} (${kind}) step ${step}`;
    const idx = a === undefined ? null : ORACLE.asBlock(a, null);
    const length = idx === null ? 0 : ORACLE.lengthOf(idx);
    if (left === 0) {
      origin = origins[pick(origins.length)];
      cursor = pick(length + 1);
      const long = rnd() < 0.3;
      left = long ? 2200 + pick(1200) : 1 + pick(60);
      deletes = long ? 0.001 : 0.1;
    }
    left--;
    cursor = Math.min(cursor, length);
    let value;
    if (cursor > 0 && rnd() < deletes) {
      const count = 1 + pick(Math.min(cursor, rnd() < 0.2 ? 30 : 2));
      cursor -= count;
      value = { cut: ORACLE.rangesOf(idx, cursor, count), content: kind === 't' ? '' : [] };
    } else {
      const content = kind === 't' ? 'abcdefgh'[pick(8)] : [pick(1000)];
      const place = idx === null ? { at: ORACLE.HEAD } : ORACLE.placeInsert(idx, cursor, origin, 1);
      value = { ...place, content };
      cursor++;
    }
    const op = { type: 'splice', ts: ++clock, origin, value };
    const x = applyKind(ORACLE, a, op, null, 4096);
    const y = applyKind(ENGINE, b, op, null, 4096);
    assert.deepStrictEqual(y.summary, x.summary, `${where}: the result`);
    assert.deepStrictEqual(y.change, x.change, `${where}: the change`);
    a = x.held;
    b = y.held;
    if (step % 97 === 0 || step === ops - 1) {
      const probe = probeOf(ORACLE, a, rnd, origins, null);
      sameReadings(readAll(ORACLE, a, probe), readAll(ENGINE, b, probe), where);
      for (const run of Object.keys(a.runs)) {
        assert.deepStrictEqual(
          ENGINE.segmentsIn(b, run),
          ORACLE.segmentsIn(a, run),
          `${where}: the segments of ${run}`,
        );
      }
    }
  }
  return ORACLE.lengthOf(a);
};

test('the sequence engine reads and writes as the v1 oracle', async (t) => {
  await t.test('seeded workloads over three or four origins: every op, every reading', () => {
    let steps = 0;
    for (let seed = 1; seed <= SEEDS; seed++) steps += runSeed(seed, OPS).steps;
    assert.ok(steps >= SEEDS * OPS);
    if (process.env.DIFF_TALLY) {
      const lines = [];
      for (const [what, n] of [...reached].sort()) lines.push(`${what}: ${n}`);
      console.log(lines.join('\n'));
    }
    // Each path the workloads are meant to reach, reached.
    const wanted = [
      't splice changed',
      'l splice changed',
      't splice malformed',
      'l splice malformed',
      't splice bound pending',
      'l splice bound pending',
      't splice unchanged',
      'l assign changed',
      'l move changed',
      'l move bound pending',
      't assign changed',
      't mark changed',
      't mark unchanged',
      't mark bound pending',
      'l assign bound pending',
      'pruned gone',
      'pruned rebuilt',
      'joined',
      'forked',
      'normalized to nothing',
      'normalized after damage',
      'a change read as a reset',
    ];
    if (SEEDS >= 100) for (const what of wanted) assert.ok(reached.has(what), `the workloads reach "${what}"`);
  });

  await t.test('long typing: runs past SEG_MAX, sealed, cut inside, typed into by others', () => {
    for (const [seed, kind] of [
      [1, 't'],
      [2, 'l'],
      [3, 't'],
    ]) {
      assert.ok(runLong(seed, kind, 9000) > 3000);
    }
    assert.ok(ORACLE.stats().seals > 0, 'a text segment sealed');
  });

  await t.test('the bounds: a run, a field and what waits, refused after the cuts before them', () => {
    for (const S of [ORACLE, ENGINE]) assert.strictEqual(S.MAX_RUN, 1 << 20);
    const gap = 1 << 20;
    const big = 'x'.repeat(gap + 1);
    // A field one slot short of MAX_FIELD, a run at MAX_RUN, a small text.
    const field = { k: 't', ts: 5, runs: { '1:A': ['^', [gap - 2, 'ab']], '2:A': ['^', [gap]], '3:A': ['^', [gap]] } };
    field.runs['4:A'] = ['^', [gap - 1]];
    const run = { k: 't', ts: 5, runs: { '1:A': ['^', [gap - 2, 'ab']] } };
    const small = { k: 't', ts: 5, runs: { '1:A': ['^', ['abc']], '2:A': ['>1:2:A', ['de']] } };
    const cut = (key, off, len) => [[key, off, len]];
    const cases = [
      // The cut lands in the draft, the insert is past the field: refused, the block as it was.
      ['field', [10, 'A'], { cut: cut('1:A', gap - 1, 1), at: '^', content: 'yz' }, null, 4],
      ['field', [11, 'A'], { cut: cut('9:Q', 0, 1), at: '^', content: 'y' }, null, 4],
      ['run', [12, 'B'], { cut: cut('9:Q', 0, 1), at: '^', content: big }, null, 4],
      ['run', [13, 'A'], { cut: cut('1:A', gap - 1, 1), run: '1:A', from: gap, content: 'z' }, null, 4],
      ['run', [14, 'A'], { cut: cut('1:A', gap - 1, 1), run: '1:A', from: gap + 1, content: 'z' }, null, 4],
      [
        'small',
        [15, 'A'],
        {
          cut: [
            ['9:Q', 0, 1],
            ['8:Q', 0, 1],
          ],
          content: '',
        },
        null,
        1,
      ],
      ['pend', [16, 'A'], { cut: cut('7:Q', 0, 1), at: '>8:0:Q', content: 'w' }, null, 2],
      ['pend', [17, 'A'], { cut: cut('1:A', 0, 1), at: '>8:0:Q', content: 'w￼', vals: [[1, { t: 1 }]] }, null, 3],
      ['pend', [18, 'A'], { cut: cut('1:A', 0, 1), at: '>8:0:Q', content: 'w￼', vals: [[1, 7]] }, null, 2],
      ['pend', [19, 'A'], { cut: cut('1:A', 1, 9), run: '1:A', from: 7, content: 'w' }, null, 2],
      ['pend', [20, 'A'], { cut: cut('1:A', 1, 9), run: '1:A', from: 3, content: 'w' }, null, 3],
      // An extension ahead of a run the floor dropped: nothing, the cut before it dropped too.
      ['small', [21, 'A'], { cut: cut('1:A', 0, 1), run: '2:A', from: 5, content: 'w' }, [5, 'A'], 4],
      ['small', [22, 'A'], { cut: cut('1:A', 0, 1), run: '2:A', from: 1, content: 'w' }, [5, 'A'], 4],
      ['small', [23, 'A'], { cut: cut('2:A', 0, 1), run: '2:A', from: 2, content: 'w' }, [2, 'A'], 4],
    ];
    const outcomes = [];
    for (const S of [ORACLE, ENGINE]) {
      const blocks = {
        field: S.normalizeSeq(JSON.parse(JSON.stringify(field)), null, 4),
        run: S.normalizeSeq(JSON.parse(JSON.stringify(run)), null, 4),
        small: S.normalizeSeq(JSON.parse(JSON.stringify(small)), null, 4),
      };
      blocks.pend = S.applySplice(blocks.small, [9, 'A'], { cut: cut('9:Q', 0, 1), content: '' }, null, 4).seq;
      const out = [];
      for (const [name, stamp, payload, base, pendingMax] of cases) {
        const block = blocks[name];
        const r = S.applySplice(block, stamp, payload, base, pendingMax);
        const { changed, reason, detail, count, max } = r;
        out.push({ changed, reason, detail, count, max, same: r.seq === block, json: JSON.stringify(r.seq) });
        out.push({ json: JSON.stringify(block), pending: S.pendingCount(block) });
      }
      outcomes.push(out);
    }
    assert.deepStrictEqual(outcomes[1], outcomes[0]);
  });
});
