'use strict';

// A block as a snapshot carries it, in the v2 engine (./sequence.js holds its design): a peer's block
// normalized under the bounds, the reset rule (prune) and the join of two blocks — through plain JSON
// and a hydration, as v1.

const { compareClock } = require('../vector.js');
const { PENDING_MAX } = require('../plugin.js');
const { rleMerge } = require('./rle.js');
const {
  STATE,
  asBlock,
  counters,
  pendingCount,
  sameBase,
  hydrate,
  normalizeJson,
  plainOf,
  stampsMax,
  draft,
  finish,
} = require('./state.js');
const { isPlaceholder, keysOf, own, below } = require('./keys.js');
const { settleRun } = require('./splice.js');

/**
 * A peer's block, rebuilt into the trusted shape and the rope under `base`, within MAX_FIELD slots and
 * `pendingMax` pending items. Anything malformed is dropped; a block with nothing left, or past a bound,
 * is null.
 */
const normalizeSeq = (raw, base = null, pendingMax = PENDING_MAX) => {
  const seq = normalizeJson(raw);
  if (seq === null) return null;
  seq.ts = stampsMax(seq);
  const block = hydrate(seq, base);
  if (pendingCount(block) > pendingMax) return null;
  return block;
};

// The reset rule: drops what is stamped below `base`. Null when nothing is left; the block itself when
// the base takes nothing — O(1) by the oldest stamp the block holds and the oldest anchor a surviving
// run still hangs from (one below the base already is a root's, folded into neither); a rebuild under
// the new base otherwise, counted (`stats().rebuilds`).
const prune = (given, base) => {
  if (base === null) return given;
  const seq = asBlock(given, STATE.has(given) ? STATE.get(given).base : base);
  const st = STATE.get(seq);
  const untouched =
    (st.oldest === null || compareClock(st.oldest, base) >= 0) &&
    (st.oldestAnchor === null || compareClock(st.oldestAnchor, base) >= 0);
  if (untouched) {
    if (sameBase(st.base, base)) return seq;
    // The floor moved and takes nothing: a version of its own under it, every node shared (O(1)) — never
    // the base written on a version another holder still reads under its own floor (it would rebuild).
    const d = draft(seq);
    d.base = base;
    return finish(d);
  }
  counters.rebuilds++;
  const plain = plainOf(seq);
  const out = { k: plain.k, ts: 0, runs: {} };
  let runs = 0;
  const runKeys = Object.keys(plain.runs);
  for (let i = 0; i < runKeys.length; i++) {
    if (below(runKeys[i], base)) continue;
    out.runs[runKeys[i]] = plain.runs[runKeys[i]];
    runs++;
  }
  for (const map of ['cuts', 'ext', 'marks']) {
    const keys = keysOf(plain[map]);
    for (let i = 0; i < keys.length; i++) if (!below(keys[i], base)) (out[map] ??= {})[keys[i]] = plain[map][keys[i]];
  }
  for (const map of ['pos', 'vals']) {
    const keys = keysOf(plain[map]);
    for (let i = 0; i < keys.length; i++) {
      const [ts, origin] = plain[map][keys[i]];
      if (compareClock([ts, origin], base) >= 0) (out[map] ??= {})[keys[i]] = plain[map][keys[i]];
    }
  }
  const empty = runs === 0 && !out.cuts && !out.ext && !out.marks && !out.pos && !out.vals;
  if (empty) return null;
  out.ts = stampsMax(out);
  return hydrate(out, base);
};

// Two nodes' pictures of one field joined: the union of runs (one run's two pictures merged), cuts,
// extensions and marks, the registers by stamp. Two honest pictures never differ under one key but by
// what each has seen; where a forged one does — a run's anchor, a mark's range, a register at one
// stamp, an extension at one offset — the lesser text wins, so the join is the same on every node and
// a snapshot cannot part two nodes for good.
const lesser = (x, y) => (x === undefined ? y : y === undefined ? x : x <= y ? x : y);
const lesserJson = (x, y) => JSON.stringify(x) < JSON.stringify(y);
// A picture as canonical plain JSON: a block of this engine serialized, plain JSON (a snapshot's)
// normalized — never hydrated into a rope only to be serialized again.
const plainOfAny = (given) => {
  if (STATE.has(given)) return plainOf(given);
  const plain = normalizeJson(given);
  if (plain === null) {
    const kind = given !== null && typeof given === 'object' && given.k === 'l' ? 'l' : 't';
    return { k: kind, ts: 0, runs: {} };
  }
  plain.ts = Number.isSafeInteger(given.ts) ? given.ts : stampsMax(plain);
  return plain;
};
const join = (givenA, givenB) => {
  const a = plainOfAny(givenA);
  const b = plainOfAny(givenB);
  const out = { k: a.k, ts: Math.max(a.ts, b.ts), runs: {} };
  const aKeys = Object.keys(a.runs);
  for (let i = 0; i < aKeys.length; i++) out.runs[aKeys[i]] = a.runs[aKeys[i]];
  const bKeys = Object.keys(b.runs);
  for (let i = 0; i < bKeys.length; i++) {
    const key = bKeys[i];
    const mine = own(out.runs, key);
    if (mine === undefined) out.runs[key] = b.runs[key];
    else {
      const theirs = b.runs[key];
      const content = rleMerge(a.k, mine[1], theirs[1]);
      const anchor = lesser(mine[0], theirs[0]);
      const elem = mine.length === 3 || theirs.length === 3 ? lesser(mine[2], theirs[2]) : undefined;
      out.runs[key] = elem === undefined ? [anchor, content] : [anchor, content, elem];
    }
  }
  const rangesHeld = new Map();
  const fromsHeld = new Map();
  for (const side of [a, b]) {
    const cutKeys = keysOf(side.cuts);
    for (let c = 0; c < cutKeys.length; c++) {
      const key = cutKeys[c];
      let held = rangesHeld.get(key);
      if (held === undefined) {
        held = new Set();
        rangesHeld.set(key, held);
      }
      const ranges = side.cuts[key];
      for (let i = 0; i < ranges.length; i++) {
        const [o, n] = ranges[i];
        const range = `${o},${n}`;
        if (held.has(range)) continue;
        held.add(range);
        if (held.size === 1) (out.cuts ??= {})[key] = [[o, n]];
        else out.cuts[key].push([o, n]);
      }
    }
    const extKeys = keysOf(side.ext);
    for (let e = 0; e < extKeys.length; e++) {
      const key = extKeys[e];
      // Where an extension sits at an offset already held: by offset, the lesser content.
      let froms = fromsHeld.get(key);
      if (froms === undefined) {
        froms = new Map();
        fromsHeld.set(key, froms);
        (out.ext ??= {})[key] = [];
      }
      const list = out.ext[key];
      const items = side.ext[key];
      for (let i = 0; i < items.length; i++) {
        const at = froms.get(items[i][0]);
        if (at === undefined) {
          froms.set(items[i][0], list.length);
          list.push(items[i]);
        } else if (lesserJson(items[i][1], list[at][1])) list[at] = items[i];
      }
    }
    for (const map of ['pos', 'vals']) {
      const keys = keysOf(side[map]);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const theirs = side[map][key];
        const mine = out[map] && own(out[map], key);
        // By stamp; two values at one stamp (forged): the lesser.
        const order = mine === undefined ? 1 : compareClock([theirs[0], theirs[1]], [mine[0], mine[1]]);
        const fresher = order > 0 || (order === 0 && lesserJson(theirs[2], mine[2]));
        if (fresher) (out[map] ??= {})[key] = theirs;
      }
    }
    const markKeys = keysOf(side.marks);
    for (let i = 0; i < markKeys.length; i++) {
      const key = markKeys[i];
      const theirs = side.marks[key];
      const mine = out.marks && own(out.marks, key);
      if (mine === undefined) {
        (out.marks ??= {})[key] = theirs;
        continue;
      }
      // A placeholder yields to the mark it stands for; two marks under one key (forged): the lesser.
      const minePlaceholder = isPlaceholder(mine);
      let filled = minePlaceholder ? theirs : mine;
      if (!minePlaceholder && !isPlaceholder(theirs) && lesserJson(theirs.slice(0, 4), mine.slice(0, 4))) {
        filled = theirs;
      }
      const flags = mine[4] | theirs[4];
      if (filled !== mine || flags !== mine[4]) out.marks[key] = [filled[0], filled[1], filled[2], filled[3], flags];
    }
  }
  // Pending cuts and extensions that the union can take, taken.
  const joined = hydrate(out, null);
  const d = draft(joined);
  const runKeys = Object.keys(out.runs);
  for (let i = 0; i < runKeys.length; i++) settleRun(d, d.doc.byKey.get(runKeys[i]));
  return finish(d);
};

module.exports = {
  normalizeSeq,
  prune,
  join,
};
