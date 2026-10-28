'use strict';

// A block as a snapshot carries it (src/text/sequence.js holds its design): a
// peer's block normalized under the bounds, the reset rule (prune) and the
// join of two blocks.

const { compareClock } = require('../vector.js');
const { PENDING_MAX } = require('../plugin.js');
const { rleMerge } = require('./rle.js');
const { STATE, asBlock, pendingCount, sameBase, hydrate, normalizeJson, plainOf, stampsMax } = require('./state.js');
const { isPlaceholder, keysOf, own, below } = require('./keys.js');
const { draft, finish, settleRun } = require('./splice.js');

/**
 * A peer's block, rebuilt into the trusted shape and the rope under `base`
 * (the entry's reset watermark, which decides what an orphan run is), within
 * MAX_FIELD slots and `pendingMax` pending items (the node's
 * `sync.pendingMax`, PENDING_MAX by default). Anything malformed is dropped;
 * a block with nothing left, or past a bound, is null.
 */
const normalizeSeq = (raw, base = null, pendingMax = PENDING_MAX) => {
  const seq = normalizeJson(raw);
  if (seq === null) return null;
  seq.ts = stampsMax(seq);
  const block = hydrate(seq, base);
  // The same bound the op path keeps: a block a peer could not have built
  // through ops is not taken as state either.
  if (pendingCount(block) > pendingMax) return null;
  return block;
};

// ---- resets and joins --------------------------------------------------------

// The reset rule: drops what is stamped below `base`. Null when nothing is
// left; the block itself when the base takes nothing — O(1) by the oldest
// stamp the block holds; a rebuild under the new base otherwise.
const prune = (given, base) => {
  if (base === null) return given;
  const seq = asBlock(given, STATE.has(given) ? STATE.get(given).base : base);
  const st = STATE.get(seq);
  const untouched =
    (st.oldest === null || compareClock(st.oldest, base) >= 0) &&
    (st.oldestAnchor === null || compareClock(st.oldestAnchor, base) >= 0);
  if (untouched) {
    if (!sameBase(st.base, base)) st.base = base;
    return seq;
  }
  const plain = plainOf(seq);
  const out = { k: plain.k, ts: 0, runs: {} };
  let runs = 0;
  for (const key of Object.keys(plain.runs)) {
    if (below(key, base)) continue;
    out.runs[key] = plain.runs[key];
    runs++;
  }
  for (const map of ['cuts', 'ext', 'marks']) {
    for (const key of keysOf(plain[map])) if (!below(key, base)) (out[map] ??= {})[key] = plain[map][key];
  }
  for (const map of ['pos', 'vals']) {
    for (const key of keysOf(plain[map])) {
      const [ts, origin] = plain[map][key];
      if (compareClock([ts, origin], base) >= 0) (out[map] ??= {})[key] = plain[map][key];
    }
  }
  const empty = runs === 0 && !out.cuts && !out.ext && !out.marks && !out.pos && !out.vals;
  if (empty) return null;
  out.ts = stampsMax(out);
  return hydrate(out, base);
};

// Two nodes' pictures of one field joined: the union of runs (one run's two
// pictures merged), cuts, extensions and marks, the registers by stamp.
const join = (givenA, givenB) => {
  const a = plainOf(asBlock(givenA));
  const b = plainOf(asBlock(givenB));
  const out = { k: a.k, ts: Math.max(a.ts, b.ts), runs: {} };
  for (const key of Object.keys(a.runs)) out.runs[key] = a.runs[key];
  for (const key of Object.keys(b.runs)) {
    const mine = own(out.runs, key);
    if (mine === undefined) out.runs[key] = b.runs[key];
    else {
      const theirs = b.runs[key];
      const content = rleMerge(a.k, mine[1], theirs[1]);
      out.runs[key] =
        mine.length === 3 || theirs.length === 3 ? [mine[0], content, mine[2] ?? theirs[2]] : [mine[0], content];
    }
  }
  // The union's lists are its own: per run key, the ranges and the
  // extension offsets it holds already.
  const rangesHeld = new Map();
  const fromsHeld = new Map();
  for (const side of [a, b]) {
    for (const key of keysOf(side.cuts)) {
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
    for (const key of keysOf(side.ext)) {
      let froms = fromsHeld.get(key);
      if (froms === undefined) {
        froms = new Set();
        fromsHeld.set(key, froms);
        (out.ext ??= {})[key] = [];
      }
      const list = out.ext[key];
      const items = side.ext[key];
      for (let i = 0; i < items.length; i++) {
        if (froms.has(items[i][0])) continue;
        froms.add(items[i][0]);
        list.push(items[i]);
      }
    }
    for (const map of ['pos', 'vals']) {
      for (const key of keysOf(side[map])) {
        const theirs = side[map][key];
        const mine = out[map] && own(out[map], key);
        const fresher = mine === undefined || compareClock([theirs[0], theirs[1]], [mine[0], mine[1]]) > 0;
        if (fresher) (out[map] ??= {})[key] = theirs;
      }
    }
    for (const key of keysOf(side.marks)) {
      const theirs = side.marks[key];
      const mine = out.marks && own(out.marks, key);
      if (mine === undefined) (out.marks ??= {})[key] = theirs;
      else if (theirs[4] !== mine[4] || isPlaceholder(mine) !== isPlaceholder(theirs)) {
        // The filled-in mark over its placeholder, the flags of both.
        const filled = isPlaceholder(mine) ? theirs : mine;
        out.marks[key] = [filled[0], filled[1], filled[2], filled[3], mine[4] | theirs[4]];
      }
    }
  }
  // Pending cuts and extensions that the union can take, taken: what
  // `settle` did on the plain block, on the plain union.
  const joined = hydrate(out, null);
  const d = draft(joined);
  for (const key of Object.keys(out.runs)) settleRun(d, key);
  return finish(d);
};

module.exports = {
  normalizeSeq,
  prune,
  join,
};
