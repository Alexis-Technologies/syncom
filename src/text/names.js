'use strict';

// The names of the v2 sequence engine (./sequence.js holds its design): a run's name parsed once where
// it enters and shared by every version of its lineage (RunId, interned in a Doc), its record (Run) and
// the children hung at one of its offsets (Child), the owners that write copy-on-write nodes, and the
// room a run takes in the id index (SPAN). No requires.
// A run's name, parsed once where it enters and shared by every version of the lineage: its number
// within the lineage (`n`), its stamp, its origin, its key as the JSON spells it.
class RunId {
  constructor(n, ts, origin, key) {
    this.n = n;
    this.ts = ts;
    this.origin = origin;
    this.key = key;
  }
}
// The names a lineage of versions interned — a hydration, a join, a prune that rebuilds start one;
// every op and fork after shares it. Only grows.
class Doc {
  constructor() {
    this.byKey = new Map();
    this.count = 0;
  }
}
const intern = (doc, key, ts, origin) => {
  let id = doc.byKey.get(key);
  if (id === undefined) {
    id = new RunId(doc.count++, ts, origin, key);
    doc.byKey.set(key, id);
  }
  return id;
};

// A run's record and its spans in the id index (./ids.js): the record at offset -1, a span at its own.
// SPAN is the room a run takes there: a run holds MAX_RUN slots at most (./rle.js; `applySplice`,
// `settleRun` and `normalizeJson` hold every path to it), so SPAN must stay above MAX_RUN — it is twice
// it, and tests/sequence.test.js holds the two apart. A run past SPAN would write over the next run's
// keys.
const SPAN = 2097152;
const keyOf = (n, off) => n * SPAN + off + 1;

// The owners: one per op, one per hydration (./cow.js).
let owners = 0;
const nextOwner = () => ++owners;

// A run's record, one per version that changed it: where it hangs (`side` of slot `aOff` of run `aId`,
// none for the head), the element a position run names (`elem`), its length, its content while it
// waits out of the walk (`rle`), its fences once placed, its children by offset on each side (`L`, `R`:
// ./cow.js lists of `Child`), how many right children sort after its continuation (`tails`), its JSON
// tuple once made (`tuple`), and the spans a walk is laying (`segs`, the walk's own).
class Run {
  constructor(id, at, side, aId, aOff, elem, len, owner) {
    this.id = id;
    this.at = at;
    this.side = side;
    this.aId = aId;
    this.aOff = aOff;
    this.elem = elem;
    this.len = len;
    this.placed = false;
    this.rle = null;
    this.open = null;
    this.close = null;
    this.L = null;
    this.R = null;
    this.tails = 0;
    this.owner = owner;
    this.tuple = null;
    this.segs = null;
  }
}
const copyRun = (run, owner) => {
  const r = new Run(run.id, run.at, run.side, run.aId, run.aOff, run.elem, run.len, owner);
  r.placed = run.placed;
  r.rle = run.rle;
  r.open = run.open;
  r.close = run.close;
  r.L = run.L;
  r.R = run.R;
  r.tails = run.tails;
  return r;
};
// The runs hung at one offset of a run, sorted by origin then stamp.
class Child {
  constructor(off, ids) {
    this.off = off;
    this.ids = ids;
  }
}

module.exports = { RunId, Doc, intern, SPAN, keyOf, nextOwner, Run, copyRun, Child };
