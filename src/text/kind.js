'use strict';

// The list and text kinds as the core reads them (src/text/text.js is the
// plugin): the codes and ranks, what an op of the kinds does to a block and
// reports, the resolution of an index into what travels, and the seam a
// list's members are composed through.

const S = require('./sequence.js');
const { isJsonValue, EMBED } = require('../args.js');
const { isPlainObject, asJson, deepEqual, own } = require('../shape.js');
const { floorOf } = require('../vector.js');
const { SyncomError } = require('../errors.js');

const KINDS = Object.freeze({ list: 3, text: 4 });
const CODES = Object.freeze({ l: 'list', t: 'text' });
const TAKES = Object.freeze({ splice: ['list', 'text'], assign: ['list', 'text'], move: ['list'], mark: ['text'] });
const HINTS = Object.freeze({
  list: 'a list; use splice(), push(), setAt() or move() (an array, not a string)',
  text: 'a text; use splice(), push(), updateText() or mark() (a string, not an array)',
});

const codeOf = (kind) => (kind === 'text' ? 't' : 'l');

// The sequence block under `field`, when the field is a list or a text.
const blockOf = (entry, field) => {
  const block = own(entry.meta.blocks, field);
  return block !== undefined && (block.k === 't' || block.k === 'l') ? block : undefined;
};

// ---------------------------------------------------------------------------
// The kind module: what the core calls (src/ops.js applyBlock, normalizeMeta,
// applyBase, mergeEntry; src/commit.js prepareOp; src/patch.js).

// A splice names its kind by its content — a string a text, an array a
// list — and one that only removes takes the field's.
const takes = (type, payload) =>
  type === 'splice' && payload.content !== undefined ? [Array.isArray(payload.content) ? 'list' : 'text'] : TAKES[type];

const kindOfOp = (op) => {
  if (op.type === 'splice') {
    const { content } = op.value;
    return typeof content === 'string' ? 'text' : Array.isArray(content) ? 'list' : null;
  }
  if (op.type === 'mark') return 'text';
  // An assign names its kind: `k: 't'` for a text's embed slot, a list's
  // element otherwise — read from the op alone, so the precedence commutes.
  if (op.type === 'assign') return op.value.k === 't' ? 'text' : 'list';
  return 'list';
};

const normalize = (raw, base, limits) => S.normalizeSeq(raw, base, limits.pendingMax);

// A `splice` lands on the block (src/text/sequence.js), an `assign`, a `move` or
// a `mark` on its registers; a register or a mark for a field with no block
// yet names its kind and waits, like a cut that comes before its run. The
// block is pruned at once: what fell below the base must look the same as
// if it had never landed, whichever side of the reset it arrived on.
const apply = (entry, field, held, op, stamp, limits) => {
  const base = floorOf(entry.meta, field);
  // The op's own references named in full again: the engine reads full names alone.
  const payload = fullRefs(op.type, op.value, op.origin);
  // The engine's block, hydrated once: a block read from a file is plain
  // JSON, and both the op and the change report read the engine's state —
  // the hydration the reading before the op made (resolve), not another.
  const before = held === undefined ? undefined : S.asBlock(held, base);
  const block = before ?? S.createSeq(codeOf(kindOfOp(op)));
  // A splice's cuts read from the block before it, while that block is still
  // the head of its lineage: read after the splice, the old block is a fork
  // — the rope re-hinted whole, O(n), for every delete (two thirds of an
  // editing trace's time went there). A move's index before it, the same way.
  const cuts = op.type === 'splice' && before !== undefined ? cutSpansOf(before, payload?.cut) : null;
  const from = op.type === 'move' && before !== undefined ? S.indexOfElem(before, payload?.elem) : -1;
  const { pendingMax } = limits;
  const result =
    op.type === 'splice'
      ? S.applySplice(block, stamp, payload, base, pendingMax)
      : op.type === 'assign'
        ? S.applyAssign(block, stamp, payload, base, pendingMax)
        : op.type === 'move'
          ? S.applyMove(block, stamp, payload, base, pendingMax)
          : S.applyMark(block, stamp, payload, base, pendingMax);
  const out = { block: held ?? null, changed: result.changed };
  if (result.reason !== undefined) {
    Object.assign(out, { reason: result.reason, detail: result.detail, count: result.count, max: result.max });
  }
  if (!result.changed) return out;
  out.block = S.prune(result.seq, base);
  // What the reading shows of the op, in its indices — none when the field went.
  if (out.block !== null) out.change = changeOf(op.type, payload, stamp, before, out.block, base, cuts, from);
  // A list's reading from the one before and the change, not made whole
  // again (a text's is the rope's own cache) — when it is read, and only
  // where the reading before was made: when nothing was reset.
  if (out.change !== undefined && before !== undefined && out.block === result.seq) {
    S.deriveLater(before, out.block, out.change);
  }
  return out;
};

// The stretches of the reading a splice's cut ranges cover in `held`, last
// first: a cut range of a run is as many stretches as others inserted
// inside it.
const cutSpansOf = (held, cut) => {
  if (!Array.isArray(cut)) return null;
  const cuts = [];
  for (let i = 0; i < cut.length; i++) {
    // A peer's range of another shape is the engine's to refuse (malformed), never a throw here.
    const range = cut[i];
    if (!Array.isArray(range) || typeof range[0] !== 'string') continue;
    const spans = S.spansOf(held, range[0], range[1], range[2]);
    if (spans !== null) for (let k = 0; k < spans.length; k++) cuts.push(spans[k]);
  }
  cuts.sort((x, y) => y.index - x.index);
  return cuts;
};

// The marks over the character at `index` of a block: what an insert's run
// reads as — it lands whole, inside or outside each mark, so one style.
const marksAt = (block, index, base) => S.styleAt(block, index, base) ?? {};

// An op as the reading shows it, in the write API's terms and the reading's
// indices (src/patch.js's vocabulary, a `move` and an `unmarkById` beside):
// a splice's cuts in the indices before it, last first, and its insert in
// the indices after, both read from the rope in O(log n); an assign as a
// `setAt`; a move by its index before and after; a mark over the indices
// its anchors fall at. What the reading does not show — a slot born dead,
// an element not placed here — is no change.
const changeOf = (type, payload, stamp, held, block, base = null, cuts = null, from = -1) => {
  const [ts, origin] = stamp;
  if (type === 'splice') {
    const out = [];
    // The cut stretches (read before the splice — `cutSpansOf`): one splice
    // each, in the indices before, last first.
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
      // What the op made visible: its own slots — and, where it was the
      // anchor a waiting op needed, that op's too. Those stand around and
      // between the run's slots; no splice of the run's own says them, so
      // the field reads as a reset (the caller reads it again).
      const shown = S.lengthOf(block) - ((held === undefined ? 0 : S.lengthOf(held)) - cut);
      let own = 0;
      for (const span of spans) own += span.count;
      if (own !== shown || spans.length > 1) return undefined;
      const span = spans[0];
      if (span !== undefined && span.count > 0) {
        // Every slot of a text the op inserted shows: what it reads as is the
        // content itself — never a slice of the whole reading, which a rope
        // would flatten. A list's reads its values off the rope (a value an
        // assign set before the slot arrived is the one it shows).
        const inserted =
          span.count === content.length && block.k === 't'
            ? content.slice()
            : S.valuesAt(block, span.index, span.count);
        const last = out[out.length - 1];
        // One cut at the insertion point and the insert: one splice, as the call made it.
        if (out.length === 1 && last.index === span.index) last.content = inserted;
        else out.push({ action: 'splice', index: span.index, count: 0, content: inserted });
        const change = out[out.length - 1];
        if (payload.vals !== undefined && span.count === content.length) change.vals = payload.vals;
        // The marks the inserted run reads with — a mark it landed inside, one that grew over it.
        if (block.k === 't') {
          const marks = marksAt(block, span.index, base);
          if (Object.keys(marks).length > 0) change.marks = marks;
        }
      }
    }
    return out;
  }
  if (type === 'assign') {
    // Where the element shows, O(log n): its slot's place in the rope.
    const index = S.indexOfElem(block, payload.elem);
    return index < 0 ? [] : [{ action: 'setAt', index, value: payload.value }];
  }
  if (type === 'move') {
    // Before (read from the block before the op, while it was the head) and
    // after; a move shows its element with the value its slot carries, so a
    // value that differs from the one shown before is a `setAt` too (a move
    // that came before the assign whose value it carries).
    const to = S.indexOfElem(block, payload.elem);
    if (to < 0) return from < 0 ? [] : [{ action: 'splice', index: from, count: 1 }];
    const value = S.valueAt(block, to);
    if (from < 0) return [{ action: 'splice', index: to, count: 0, content: [value] }];
    const out = from === to ? [] : [{ action: 'move', from, to }];
    if (!deepEqual(S.valueAt(held, from), value)) out.push({ action: 'setAt', index: to, value });
    return out;
  }
  // A mark: over the indices its anchors fall at; switched off by id, with
  // the range it covered when the mark is here.
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
  const piece = (from, to) => {
    const change = { action: 'mark', start: from, end: to, name: payload.key, value: payload.value, markId };
    if (many) change.many = true;
    return change;
  };
  // Where a newer mark of the key holds the text, the reading is that one's:
  // a peer's older mark arriving late changes the rest of its range alone.
  const out = [];
  let at = start;
  for (const [from, to] of S.newerRanges(block, payload.key, stamp, many, base)) {
    if (to <= at) continue;
    if (from >= end) break;
    if (from > at) out.push(piece(at, from));
    at = Math.max(at, to);
    if (at >= end) break;
  }
  if (at < end) out.push(piece(at, end));
  return out;
};

// The block the op made, as it is (src/ops.js renders it when it is read):
// never the entry's newest, which a later op may have moved past.
const render = (entry, field, block) => S.render(block ?? S.indexOf(entry, field));

// A large block as its file holds it: the runs in pieces (src/entries.js).
const pieces = (block) => S.piecesOf(block);

// What a list or text field reads as, as a token: a number per engine block,
// handed out the first time one is asked for (0 for no such field) — the
// same block, the same reading. A new block may read the same (an op that
// changed only what is not shown, a record read again from its file), so a
// token is a shortcut past comparing two readings, never a proof they differ.
const REVISIONS = new WeakMap();
let revisions = 0;
const revisionOf = (entry, field) => {
  if (!entry || entry.encrypted || blockOf(entry, field) === undefined) return 0;
  const block = S.indexOf(entry, field);
  let revision = REVISIONS.get(block);
  if (revision === undefined) REVISIONS.set(block, (revision = ++revisions));
  return revision;
};

// A list's elements may hold fields of their own — `items/<element>/body` —
// composed over the element's value for a reader (src/compose.js); a text's
// characters may not. `members` are the element names in order, `holds`
// whether one shows, `pick` the composed element the name reads as, `nest`
// the list read with each element's children laid over its value (a plain
// object spread, anything else giving way).
// Two splices of one stream on a text as one op — what a run of keystrokes
// sent without waiting is logged as (src/commit.js commitAtOnce): `a`'s
// value made to do what `a` then `b` do, under `a`'s stamp, or null. Two
// shapes only, both of which the engine reads alike as one op or two: `b`
// extends at its end the run `a` typed into (its content appended), or `a`
// and `b` only cut and every run `b` cuts is older than `a` (an honest
// cutter: `a`'s stamp must still be above them). Never an insert and a cut
// of it, never `b` with markers, never a list (its content would be copied
// whole again by every keystroke), and at most MAX_CUTS ranges. The two are
// of one stream: their own references name one origin, compact or in full.
const MAX_CUTS = 256;
const coalesce = (a, b) => {
  if (a.type !== 'splice' || b.type !== 'splice') return null;
  const x = a.value;
  const y = b.value;
  if (typeof x.content !== 'string' || typeof y.content !== 'string' || y.vals !== undefined) return null;
  if (y.content.length > 0) {
    if (y.cut !== undefined || y.run === undefined || x.content.length === 0) return null;
    const run = x.run !== undefined ? stampOf(x.run, a.origin) : x.at !== undefined ? a.ts : -1;
    if (run === -1 || run !== stampOf(y.run, b.origin)) return null;
    if ((x.run !== undefined ? x.from : 0) + x.content.length !== y.from) return null;
    return { ...x, content: x.content + y.content };
  }
  if (x.content.length > 0 || x.cut === undefined || y.cut === undefined) return null;
  if (x.cut.length + y.cut.length > MAX_CUTS) return null;
  for (let i = 0; i < y.cut.length; i++) {
    const ref = y.cut[i][0];
    const ts = typeof ref === 'number' ? ref : (S.parseRun(ref)?.ts ?? Infinity);
    if (!(ts < a.ts)) return null;
  }
  return { content: '', cut: x.cut.concat(y.cut) };
};

// A splice of a text typed right before the first element of the new run `a`
// made — the next keystroke of a word typed backward, a prepend — as `a`
// with its content grown at the start, or null. Its elements are numbered
// again (what `a` made shifts by `b`'s length), so only an op no one has
// seen can be grown so: one an editor's handle has not flushed
// (src/text/handle.js), applied again over the reading it was made over.
// `a` and `b` only insert, no markers, of one origin, at most PREPEND_MAX
// slots together (each keystroke lays the whole run again).
const PREPEND_MAX = 256;
const prepends = (a, b) => {
  if (a.type !== 'splice' || b.type !== 'splice' || a.origin !== b.origin) return null;
  const x = a.value;
  const y = b.value;
  if (typeof x.content !== 'string' || typeof y.content !== 'string' || x.at === undefined) return null;
  if (x.cut !== undefined || x.vals !== undefined || y.cut !== undefined || y.vals !== undefined) return null;
  if (y.content.length === 0 || x.content.length + y.content.length > PREPEND_MAX) return null;
  if (y.at !== `<${a.ts}:0` && y.at !== `<${a.ts}:0:${a.origin}`) return null;
  return { ...x, content: y.content + x.content };
};

// ---------------------------------------------------------------------------
// Own references. What an op names of its own origin's — the run it extends
// (only ever its own), a run it cuts, the element it sets or moves, the
// anchor of its new run, a mark it switches off — travels without the
// origin the header carries already: a run as its stamp, a number; an
// element as `ts:off` (one colon — a full name has two, whatever the origin
// holds), an anchor as `<ts:off` or `>ts:off`. `resolve` writes them so;
// `fullRefs` lays the op's origin back where an op enters the engine (`apply`)
// and hands any other value on as it is, for the engine to refuse. A compact
// reference can only ever name the op's own origin's.
const ownRun = (key, origin) => {
  if (typeof key !== 'string') return key;
  const colon = key.indexOf(':');
  const own = colon > 0 && key.length === colon + 1 + origin.length && key.endsWith(origin);
  return own ? Number(key.slice(0, colon)) : key;
};
// An element `ts:off:origin`, or an anchor `<ts:off:origin`: the first two
// colons are the stamp's and the offset's.
const ownElem = (key, origin) => {
  if (typeof key !== 'string') return key;
  const first = key.indexOf(':');
  const second = first === -1 ? -1 : key.indexOf(':', first + 1);
  const own = second > 0 && key.length === second + 1 + origin.length && key.endsWith(origin);
  return own ? key.slice(0, second) : key;
};
const ownRanges = (ranges, origin) => {
  for (let i = 0; i < ranges.length; i++) ranges[i][0] = ownRun(ranges[i][0], origin);
  return ranges;
};

// The stamp of a reference to a run of `origin`'s, -1 for another's.
const stampOf = (ref, origin) => {
  if (typeof ref === 'number') return ref;
  const run = S.parseRun(ref);
  return run !== null && run.origin === origin ? run.ts : -1;
};
const isShort = (ref) => {
  if (typeof ref !== 'string') return false;
  const first = ref.indexOf(':');
  return first !== -1 && ref.indexOf(':', first + 1) === -1;
};
const fullRun = (ref, origin) => (typeof ref === 'number' ? `${ref}:${origin}` : ref);
const fullElem = (ref, origin) => (isShort(ref) ? `${ref}:${origin}` : ref);
const fullAnchor = (token, origin) =>
  typeof token === 'string' && (token[0] === '<' || token[0] === '>') && isShort(token) ? `${token}:${origin}` : token;
// A cut range `[run, offset, length]` (anything else as it is): copied only when its run is compact.
const fullRange = (range, origin) => {
  if (!Array.isArray(range) || typeof range[0] !== 'number') return range;
  const copy = range.slice();
  copy[0] = `${range[0]}:${origin}`;
  return copy;
};
const fullRanges = (ranges, origin) => {
  if (!Array.isArray(ranges)) return ranges;
  let out = ranges;
  for (let i = 0; i < ranges.length; i++) {
    const range = fullRange(ranges[i], origin);
    if (range === ranges[i]) continue;
    if (out === ranges) out = ranges.slice();
    out[i] = range;
  }
  return out;
};

// An op's value with its own references in full: the value itself when it holds none.
const fullRefs = (type, value, origin) => {
  if (value === null || typeof value !== 'object' || typeof origin !== 'string') return value;
  let out = value;
  const put = (name, next) => {
    if (next === value[name]) return;
    if (out === value) out = { ...value };
    out[name] = next;
  };
  if (type === 'splice') {
    if (value.run !== undefined) put('run', fullRun(value.run, origin));
    if (value.at !== undefined) put('at', fullAnchor(value.at, origin));
    if (value.cut !== undefined) put('cut', fullRanges(value.cut, origin));
  } else if (type === 'assign') {
    put('elem', fullElem(value.elem, origin));
  } else if (type === 'move') {
    put('elem', fullElem(value.elem, origin));
    put('cut', fullRange(value.cut, origin));
    put('at', fullAnchor(value.at, origin));
  } else if (value.off !== undefined) {
    put('off', fullRun(value.off, origin));
  } else {
    put('start', fullAnchor(value.start, origin));
    put('end', fullAnchor(value.end, origin));
  }
  return out;
};

const NESTS = Object.freeze({ list: true, text: false });
// A list's reading is a new array of every element, made when it is read
// (src/lazy.js); a text's is the rope's cache, cheaper made at once.
const LAZY = Object.freeze({ list: true, text: false });
const members = (entry, field) => {
  const block = blockOf(entry, field);
  return block === undefined || block.k !== 'l' ? [] : S.elems(S.indexOf(entry, field));
};
const holds = (entry, field, member) => {
  const block = blockOf(entry, field);
  return block !== undefined && block.k === 'l' && S.hasElem(S.indexOf(entry, field), member);
};
const pick = (entry, field, rendered, member) => {
  const block = blockOf(entry, field);
  const index = block === undefined || block.k !== 'l' ? -1 : S.indexOfElem(S.indexOf(entry, field), member);
  return index === -1 || !Array.isArray(rendered) ? undefined : rendered[index];
};
const isPlain = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const nest = (entry, field, rendered, childrenOf) => {
  const keys = members(entry, field);
  const out = [];
  for (let i = 0; i < rendered.length; i++) {
    const value = rendered[i];
    const children = childrenOf(keys[i]);
    if (children === undefined) out.push(value);
    else out.push(isPlain(value) ? { ...value, ...children } : { ...children });
  }
  return out;
};
const prune = (block, base) => S.prune(block, base);
const join = (a, b) => S.join(a, b);

// A splice names an index and a count; what travels is the anchor of the
// new run (or the run of this origin to extend) and the ranges to cut, read
// here, inside the queue — read outside it, a concurrent apply would shift
// the indices. The content names the kind — a string for a text, an array
// for a list — and a call that only cuts takes the field's.
// An index into a text between the two halves of a surrogate pair — a
// character outside the BMP — names no place a reader could show: refused
// here, inside the queue, against the text as it is.
const isHigh = (unit) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit) => unit >= 0xdc00 && unit <= 0xdfff;
// The two units around an index read from the rope, O(log n) each — never
// from the whole reading, which a rope flattens on its first read.
const unitAt = (idx, index) => {
  const held = S.heldAt(idx, index);
  return typeof held === 'string' ? held.charCodeAt(0) : -1;
};
const wholeCharacters = (id, key, idx, ...indexes) => {
  if (idx === null || idx.k !== 't') return;
  const length = S.lengthOf(idx);
  for (const index of indexes) {
    if (index <= 0 || index >= length) continue;
    if (!isHigh(unitAt(idx, index - 1)) || !isLow(unitAt(idx, index))) continue;
    const message = `Index ${index} of field ${key} of record ${id} falls inside a surrogate pair`;
    throw new SyncomError('SURROGATE', message, { id, field: key, index });
  }
};

// While a text handle is open this node has more than one writer of a text:
// each handle over its own reading, the storage over its own. A run is
// extended by its origin alone, an offset after another — an extension at an
// offset the run holds already is a duplicate, and dropped — so every
// extension reserves the run's next offset, and a writer whose reading is
// behind it (another writer grew the run meanwhile) begins a run of its own
// after it (HANDLE-4). Without a handle the storage is the one writer: nothing
// is reserved, and the last handle closed clears what was (src/text/handle.js).
const extendsRun = (core, run, from, length) => {
  const editing = core.editing;
  if (editing === undefined || editing === null || editing.handles.size === 0) return true;
  const end = editing.extents.get(run);
  if (end !== undefined && end !== from) return false;
  editing.extents.set(run, from + length);
  return true;
};

const resolveSplice = (core, id, payload, current) => {
  const { key, index, count, content, vals, marker } = payload;
  const held = current ? blockOf(current, key) : undefined;
  const fill = content ?? (held?.k === 'l' ? [] : '');
  const idx = held === undefined ? null : S.indexOf(current, key);
  const length = idx === null ? 0 : S.lengthOf(idx);
  const at = index === null ? length : index;
  if (at > length || at + count > length) {
    const span = count > 0 ? `${at}..${at + count}` : String(at);
    const message = `Index ${span} is out of range for field ${key} of record ${id} (length ${length})`;
    throw new SyncomError('OUT_OF_RANGE', message, { id, field: key, index: at, count, length });
  }
  wholeCharacters(id, key, idx, at, at + count);
  // joinBlock(): the one slot it cuts holds a block marker, or there is none to join.
  if (marker === true && !(held?.k === 't' && S.heldAt(idx, at) === EMBED)) throw noMarker(id, key, at);
  const value = { content: fill };
  const origin = core.nodeId;
  if (count > 0) value.cut = ownRanges(S.rangesOf(idx, at, count), origin);
  if (fill.length > 0) {
    const place = idx === null ? null : S.placeInsert(idx, at, origin, fill.length);
    // The writer's own run grown (its stamp), or the anchor of a new one — after
    // the run's last element where another writer of this node grew it meanwhile.
    if (place === null) value.at = S.HEAD;
    else if (place.run === undefined) value.at = ownElem(place.at, origin);
    else if (extendsRun(core, place.run, place.from, fill.length)) {
      Object.assign(value, { run: ownRun(place.run, origin), from: place.from });
    } else value.at = ownElem(`>${S.elemKey(place.run, place.from - 1)}`, origin);
  }
  // The markers of the embed slots the content holds, each at its offset.
  if (vals !== undefined && vals.length > 0) value.vals = vals;
  return value;
};

// A text's slot that is no block marker and no embed: nothing to set or join there.
const noMarker = (id, field, index) => {
  const message = `Index ${index} of text field ${field} of record ${id} holds no block marker or embed`;
  return new SyncomError('NOT_FOUND', message, { id, field, index });
};

// A list's element, by its index: the name it keeps across moves. A field
// with no block has no elements (OUT_OF_RANGE); another kind under the field
// was refused before this is read (kindClash).
const elementAt = (core, id, key, index, current) => {
  const held = current ? blockOf(current, key) : undefined;
  const idx = held === undefined ? null : S.indexOf(current, key);
  const length = idx === null ? 0 : S.lengthOf(idx);
  if (index >= length) {
    const message = `Index ${index} is out of range for field ${key} of record ${id} (length ${length})`;
    throw new SyncomError('OUT_OF_RANGE', message, { id, field: key, index, count: 0, length });
  }
  return { idx, elem: S.elemAt(idx, index) };
};

const resolveAssign = (core, id, payload, current) => {
  const { key, index, value } = payload;
  const held = current ? blockOf(current, key) : undefined;
  const found = elementAt(core, id, key, index, current);
  const elem = ownElem(found.elem, core.nodeId);
  if (held?.k !== 't') return { elem, value };
  // A text: the slot is an embed slot, and what it takes is a marker (or none); the op names the kind.
  if (S.heldAt(found.idx, index) !== EMBED) throw noMarker(id, key, index);
  return { elem, value: value === null ? null : markerArgs('setAt', value), k: 't' };
};

// A move names two indices; what travels is the element, the slot it showed
// at and the anchor of its new position (`to` counts once it is out).
const resolveMove = (core, id, payload, current) => {
  const { key, index: from, to } = payload;
  const { idx, elem } = elementAt(core, id, key, from, current);
  const length = S.lengthOf(idx);
  if (to >= length) {
    const message = `Index ${to} is out of range for field ${key} of record ${id} (length ${length})`;
    throw new SyncomError('OUT_OF_RANGE', message, { id, field: key, index: to, count: 0, length });
  }
  const origin = core.nodeId;
  const place = S.placeInsert(idx, to < from ? to : to + 1, origin);
  const at = ownElem(place.at ?? `>${S.elemKey(place.run, place.from - 1)}`, origin);
  const cut = S.slotAt(idx, from);
  cut[0] = ownRun(cut[0], origin);
  return { elem: ownElem(elem, origin), cut, at, value: S.valueAt(idx, from) };
};

// A mark names a visible range and an expand rule; what travels is the pair
// of anchors — an element and a side — the rule picks (src/text/sequence.js
// markAnchors), or the id of the mark to switch off.
const resolveMark = (core, id, payload, current) => {
  const { key, off } = payload;
  if (off !== undefined) return { off: ownRun(off, core.nodeId) };
  const { start, end, name, value, expand, many } = payload;
  const held = current ? blockOf(current, key) : undefined;
  const idx = held === undefined ? null : S.indexOf(current, key);
  const length = idx === null ? 0 : S.lengthOf(idx);
  if (start > end || end > length) {
    const message = `Range ${start}..${end} is out of range for field ${key} of record ${id} (length ${length})`;
    throw new SyncomError('OUT_OF_RANGE', message, { id, field: key, index: start, count: end - start, length });
  }
  wholeCharacters(id, key, idx, start, end);
  const [from, to] = idx === null ? [S.HEAD, S.END] : S.markAnchors(idx, start, end, expand);
  const out = { start: ownElem(from, core.nodeId), end: ownElem(to, core.nodeId), key: name, value };
  if (many) out.many = true;
  return out;
};

const resolve = (core, id, type, payload, current) => {
  if (type === 'splice') return resolveSplice(core, id, payload, current);
  if (type === 'assign') return resolveAssign(core, id, payload, current);
  if (type === 'move') return resolveMove(core, id, payload, current);
  return resolveMark(core, id, payload, current);
};

// ---------------------------------------------------------------------------
// Markers: what a text's embed slot holds, as the API spells it.

/** The marker a value is, if any — normalized: parents the strings, attrs the object, `isEmbed` the flag. */
const markerOf = (value) => {
  if (!isPlainObject(value) || typeof value.type !== 'string') return null;
  const { type, parents, attrs, isEmbed } = value;
  const strings = [];
  if (Array.isArray(parents)) {
    for (let i = 0; i < parents.length; i++) if (typeof parents[i] === 'string') strings.push(parents[i]);
  }
  return {
    type,
    parents: strings,
    attrs: isPlainObject(attrs) ? asJson(attrs) : {},
    isEmbed: isEmbed === true,
  };
};

// A marker as a call gives it: a type, parents (block types, outermost
// first), attrs (a JSON object); `embed` forces the flag, else the value's.
const markerArgs = (method, given, embed) => {
  if (!isPlainObject(given) || typeof given.type !== 'string' || given.type.length === 0) {
    throw new TypeError(`${method}() takes a block marker: { type, parents?, attrs?, isEmbed? } with a type`);
  }
  const { type, parents = [], attrs = {}, isEmbed = false } = given;
  if (!Array.isArray(parents)) throw new TypeError(`${method}() takes parents as a list of block types`);
  // Checked and copied in one pass; a hole is no block type.
  const copy = [];
  for (let i = 0; i < parents.length; i++) {
    if (typeof parents[i] !== 'string') throw new TypeError(`${method}() takes parents as a list of block types`);
    copy.push(parents[i]);
  }
  if (!isPlainObject(attrs) || !isJsonValue(attrs)) throw new TypeError(`${method}() takes attrs as a JSON object`);
  if (typeof isEmbed !== 'boolean') throw new TypeError(`${method}() takes isEmbed as a boolean`);
  return { type, parents: copy, attrs, isEmbed: embed ?? isEmbed };
};

// The markers riding on a splice patch: `[[offset, marker | null]]`, each
// offset an embed slot of the content.
const valsArgs = (method, vals, content) => {
  if (!Array.isArray(vals)) throw new TypeError(`${method}() takes vals as [[offset, marker]]`);
  for (const pair of vals) {
    const [offset, marker] = Array.isArray(pair) && pair.length === 2 ? pair : [];
    if (!Number.isInteger(offset) || offset < 0 || offset >= content.length || content[offset] !== EMBED) {
      throw new TypeError(`${method}() takes vals at the embed slots (U+FFFC) of the content`);
    }
    if (marker !== null && !isJsonValue(marker)) throw new TypeError(`${method}() takes a JSON value per embed`);
  }
  return vals;
};

// The marker at visible index `i` of a text's block — null for a slot that
// is no embed slot, or holds none the API can read.
const markerAt = (idx, i) => (S.heldAt(idx, i) === EMBED ? markerOf(S.valueAt(idx, i)) : null);

module.exports = {
  KINDS,
  CODES,
  HINTS,
  blockOf,
  takes,
  kindOfOp,
  normalize,
  apply,
  marksAt,
  render,
  pieces,
  revisionOf,
  NESTS,
  LAZY,
  coalesce,
  prepends,
  PREPEND_MAX,
  members,
  holds,
  pick,
  nest,
  prune,
  join,
  wholeCharacters,
  resolve,
  markerArgs,
  valsArgs,
  markerAt,
};
