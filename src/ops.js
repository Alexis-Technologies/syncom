'use strict';

// The record-level replication model: how ONE operation changes ONE record's
// entry, in a way that gives the same result whatever order the operations
// arrive in, and a no-op when the same operation arrives twice. The version
// vector in the log is an optimization on top of this — it decides what to
// send, never what is correct.
//
// An entry is `{ data, meta }`. `data` is what the application reads; `meta`
// is the bookkeeping that makes merges commute:
//   clock[f]    — [ts, origin] of the write that set register field f
//   base        — the record-reset watermark: a field is visible only if its
//                 clock is not below base. A `write` (whole-record write) and
//                 a `delete` both raise it, which is what stops an older
//                 concurrent `set` from resurrecting a field they removed.
//   deleted     — the tombstone stamp; the record is alive again as soon as
//                 something newer than it lands (see isAlive)
//   counters[f] — { [origin]: [seq, sum, ts] }: a PN-counter, one running sum
//                 per origin, so re-applying an `inc` (seq already seen) is a
//                 no-op and two snapshots join by taking the higher seq
//   sets[f]     — { [elementKey]: { [origin]: [added, removed] } }: an
//                 observed-remove set. elementKey is the element's JSON text;
//                 per (element, origin) the ts of that origin's newest `add`
//                 and the newest add ts a `remove` had observed (0 = none).
//                 The element is live for that origin iff added > removed.
//   seqs[f]     — a list or a text: the sequence engine's block
//                 (src/sequence.js) — runs anchored in a Fugue tree,
//                 tombstones as lengths, pending work, a movable list's
//                 registers, a text's marks. data[f] is its walk; why it
//                 converges is argued there.
//   trees[f]    — a tree: per node the moves made of it, stamped
//                 (src/tree.js). data[f] is the fold of every move in stamp
//                 order, a move that would put a node under itself skipped;
//                 why it converges is argued there.
//   v           — the schema version of the last whole-record write (the op's
//                 `v`, absent on a node without a schema): what a reader on
//                 a newer schema lenses the record through. A `set` that
//                 creates the entry takes its op's `v`; a later `set`, `inc`
//                 or `delete` leaves it; a merge takes the higher one.
//   purged      — the stamp of a `purge`: the record is gone for good. It
//                 wins over every other op at any stamp (a purge is a right
//                 to be forgotten, not a race), the entry holds no data, and
//                 nothing but another purge or a merge touches it again.
//
// Precondition, enforced by Storage: ops from ONE origin are applied in seq
// order. Counters rely on it (a skipped seq would be lost, not reordered);
// registers do not, but the vector-based dedup does.
//
// A field is a REGISTER, a COUNTER, a SET, a LIST, a TEXT or a TREE, never
// two of them: `set`/`write` on a counter, set, sequence or tree field, `inc`
// on a register, set, sequence or tree field, `add`/`remove` on a register,
// counter, sequence or tree field, `splice` on a register, counter, set or
// tree field, `tree` on any other kind are refused (reported in `rejected`)
// — the kinds cannot be made to commute, and refusing is honest where
// guessing would silently diverge. On a snapshot merge the register wins,
// then the counter, the set, the list, the text, the tree.
//
// Why a set converges (what the tests check): one origin's adds of an element
// are stamped in seq order, so a node that observed the add at `r` observed
// every earlier one, and "remove what I observed" is exactly
// `removed := max(removed, r)`; `add` is `added := max(added, ts)`. Both are
// joins on the pair, hence order-free and idempotent, and `data[f]` is a pure
// function of the meta. A reset (`write`/`delete`) drops a slot whose newest
// stamp is below `base` and clamps a surviving component below `base` to 0,
// and the same predicate guards each tag as it is applied — so meta, not only
// data, agrees whatever the order of adds, removes and resets.

const { compareClock, maxClock } = require('./vector.js');
const { deepEqual } = require('./shape.js');
const S = require('./sequence.js');
const T = require('./tree.js');

const createEntry = () => ({
  data: {},
  meta: { clock: {}, base: null, deleted: null, counters: {}, sets: {}, seqs: {}, trees: {} },
});

// An entry written before sets existed has no `sets` key; reading it as
// empty is the whole compatibility story.
const EMPTY = Object.freeze({});
const setsOf = (meta) => meta.sets ?? EMPTY;
const seqsOf = (meta) => meta.seqs ?? EMPTY;
const treesOf = (meta) => meta.trees ?? EMPTY;

const cloneSets = (sets) => {
  const copy = {};
  for (const field of Object.keys(sets)) {
    const elements = {};
    const from = sets[field];
    for (const key of Object.keys(from)) {
      const slots = {};
      const theirs = from[key];
      for (const origin of Object.keys(theirs)) slots[origin] = [theirs[origin][0], theirs[origin][1]];
      elements[key] = slots;
    }
    copy[field] = elements;
  }
  return copy;
};

const cloneEntry = (entry) => {
  const counters = {};
  for (const field of Object.keys(entry.meta.counters)) counters[field] = { ...entry.meta.counters[field] };
  const meta = {
    clock: { ...entry.meta.clock },
    base: entry.meta.base,
    deleted: entry.meta.deleted,
    counters,
    sets: cloneSets(setsOf(entry.meta)),
    // A sequence block is never mutated in place (src/sequence.js hands back
    // a new one), so the map is copied and the blocks are shared.
    seqs: { ...seqsOf(entry.meta) },
    trees: { ...treesOf(entry.meta) },
  };
  if (entry.meta.v !== undefined) meta.v = entry.meta.v;
  if (entry.meta.purged !== undefined) meta.purged = entry.meta.purged;
  const out = { data: { ...entry.data }, meta };
  // The built indexes come along: an unchanged block reads through its own.
  if (entry.seqIndex !== undefined) out.seqIndex = { ...entry.seqIndex };
  return out;
};

const counterValue = (perOrigin) => {
  let sum = 0;
  for (const origin of Object.keys(perOrigin)) sum += perOrigin[origin][1];
  return sum;
};

const isCounter = (meta, field) => {
  const perOrigin = own(meta.counters, field);
  return Boolean(perOrigin) && Object.keys(perOrigin).length > 0;
};

const isSet = (meta, field) => {
  const elements = own(setsOf(meta), field);
  return Boolean(elements) && Object.keys(elements).length > 0;
};

// A list or a text: the sequence engine's block under the field.
const isSeq = (meta, field) => own(seqsOf(meta), field) !== undefined;

// The index of a sequence field (src/sequence.js buildIndex), kept on the
// entry under `seqIndex` — never persisted, never copied by value — and
// reused while the block object and the base it was built against are the
// ones the entry holds; a block replaced by an op is a new object. When the
// op only appended to a run (`extended`: the held block, the run, where and
// what), the held block's index is carried over instead of walked anew.
const seqIndexOf = (entry, field, extended = null) => {
  const seq = own(seqsOf(entry.meta), field);
  if (seq === undefined) return null;
  const base = entry.meta.base;
  const cache = (entry.seqIndex ??= {});
  const hit = own(cache, field);
  if (hit !== undefined && hit.seq === seq && hit.base === base) return hit.index;
  let index = null;
  if (extended !== null && hit !== undefined && hit.seq === extended.held && hit.base === base) {
    index = S.extendIndex(hit.index, seq, extended);
  }
  if (index === null) index = S.buildIndex(seq, base);
  cache[field] = { seq, base, index };
  return index;
};
const seqKind = (meta, field) => (own(seqsOf(meta), field).k === 't' ? 'text' : 'list');
// A tree: the move log under the field (src/tree.js).
const isTree = (meta, field) => own(treesOf(meta), field) !== undefined;

// An element is identified by its JSON text — `1` and `'1'` are two elements,
// `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` are two too. A key from a peer must
// be that text exactly, or two peers would hold one element under two keys.
const elementKey = (element) => JSON.stringify(element);
const isElementKey = (key) => {
  try {
    return JSON.stringify(JSON.parse(key)) === key;
  } catch {
    return false;
  }
};

// The live elements of a set, sorted by key: a set has no order of its own
// (an add by the same origin moves the element's stamp, so "insertion order"
// would shift under the reader), and equal metas on two nodes must read as
// equal arrays.
const liveElements = (elements) => {
  const keys = [];
  for (const key of Object.keys(elements)) {
    const slots = elements[key];
    for (const origin of Object.keys(slots)) {
      if (slots[origin][0] > slots[origin][1]) {
        keys.push(key);
        break;
      }
    }
  }
  keys.sort();
  const values = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) values[i] = JSON.parse(keys[i]);
  return values;
};

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// A key a JSON payload may carry that must never become a property name
// here: assigning under it would replace the object's prototype. Every
// other name — `constructor`, `toString` — is a field like any other, which
// is why lookups below go through `own` rather than the prototype chain.
const isKey = (key) => key !== '__proto__';
const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);

const isStamp = (value) =>
  Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'string';
const stampOf = (value) => (isStamp(value) ? [value[0], value[1]] : null);
const isCount = (value) =>
  Array.isArray(value) && Number.isInteger(value[0]) && Number.isFinite(value[1]) && typeof value[2] === 'number';
const isSlot = (value) =>
  Array.isArray(value) &&
  value.length === 2 &&
  Number.isSafeInteger(value[0]) &&
  value[0] >= 0 &&
  Number.isSafeInteger(value[1]) &&
  value[1] >= 0 &&
  value[0] + value[1] > 0;

// Structural equality over JSON-shaped values, key order ignored — what a
// `merge` op needs to tell "already have this" from "news".

// A peer-supplied meta, rebuilt into the shape the rest of this module
// trusts: own keys only, stamps as `[ts, origin]`, counters as `[seq, sum,
// ts]` per origin, set slots as `[added, removed]` per element and origin
// under a canonical JSON key, anything else dropped. A copy, so nothing of
// the peer's object is kept by reference and a `__proto__` key in it reaches
// nothing.
const normalizeMeta = (meta) => {
  const clock = {};
  if (isPlainObject(meta.clock)) {
    for (const field of Object.keys(meta.clock)) {
      const stamp = stampOf(meta.clock[field]);
      if (isKey(field) && stamp) clock[field] = stamp;
    }
  }
  const counters = {};
  if (isPlainObject(meta.counters)) {
    for (const field of Object.keys(meta.counters)) {
      const source = meta.counters[field];
      if (!isKey(field) || !isPlainObject(source)) continue;
      const perOrigin = {};
      for (const origin of Object.keys(source)) {
        const count = source[origin];
        if (isKey(origin) && isCount(count)) perOrigin[origin] = [count[0], count[1], count[2]];
      }
      if (Object.keys(perOrigin).length > 0) counters[field] = perOrigin;
    }
  }
  const sets = {};
  if (isPlainObject(meta.sets)) {
    for (const field of Object.keys(meta.sets)) {
      const source = meta.sets[field];
      if (!isKey(field) || !isPlainObject(source)) continue;
      const elements = {};
      for (const key of Object.keys(source)) {
        const slotsFrom = source[key];
        if (!isKey(key) || !isPlainObject(slotsFrom) || !isElementKey(key)) continue;
        const slots = {};
        for (const origin of Object.keys(slotsFrom)) {
          const slot = slotsFrom[origin];
          if (isKey(origin) && isSlot(slot)) slots[origin] = [slot[0], slot[1]];
        }
        if (Object.keys(slots).length > 0) elements[key] = slots;
      }
      if (Object.keys(elements).length > 0) sets[field] = elements;
    }
  }
  // The reset watermark first: it decides which of a block's runs are
  // orphans (read from the head) and which wait for an anchor (bounded).
  const base = stampOf(meta.base);
  const seqs = {};
  if (isPlainObject(meta.seqs)) {
    for (const field of Object.keys(meta.seqs)) {
      if (!isKey(field)) continue;
      const seq = S.normalizeSeq(meta.seqs[field], base);
      if (seq !== null) seqs[field] = seq;
    }
  }
  const trees = {};
  if (isPlainObject(meta.trees)) {
    for (const field of Object.keys(meta.trees)) {
      if (!isKey(field)) continue;
      const tree = T.normalizeTree(meta.trees[field]);
      if (tree !== null) trees[field] = tree;
    }
  }
  const normalized = { clock, base, deleted: stampOf(meta.deleted), counters, sets, seqs, trees };
  if (Number.isInteger(meta.v)) normalized.v = meta.v;
  const purged = stampOf(meta.purged);
  if (purged) normalized.purged = purged;
  return normalized;
};

// The newest stamp an entry's metadata holds, over registers, the reset
// watermark, the tombstone, the counters and the sets — what a node must have
// observed before it stamps a write to that record, or the write sorts below
// state the node already has and is dropped as stale. Takes raw peer-shaped
// meta too.
// The newest stamp an entry's metadata holds, over registers, the reset
// watermark, the tombstone, the counters, the sets, the sequences and the
// trees — what a node must have observed before it stamps a write to that
// record, or the write sorts below state the node already has and is
// dropped as stale. `trusted` says the meta is this module's own shape (an
// entry this node holds); a peer's raw meta is rebuilt first.
const latestClock = (meta, trusted = false) => {
  if (!isPlainObject(meta)) return null;
  const { clock, base, deleted, counters, sets, seqs, trees, purged } = trusted
    ? { ...meta, sets: setsOf(meta), seqs: seqsOf(meta), trees: treesOf(meta) }
    : normalizeMeta(meta);
  let latest = maxClock(maxClock(base, deleted), purged ?? null);
  for (const field of Object.keys(seqs)) latest = maxClock(latest, [seqs[field].ts, '']);
  for (const field of Object.keys(trees)) latest = maxClock(latest, [trees[field].ts, '']);
  for (const field of Object.keys(clock)) latest = maxClock(latest, clock[field]);
  for (const field of Object.keys(counters)) {
    const perOrigin = counters[field];
    for (const origin of Object.keys(perOrigin)) latest = maxClock(latest, [perOrigin[origin][2], origin]);
  }
  for (const field of Object.keys(sets)) {
    const elements = sets[field];
    for (const key of Object.keys(elements)) {
      const slots = elements[key];
      for (const origin of Object.keys(slots)) {
        const slot = slots[origin];
        if (slot[0] > 0) latest = maxClock(latest, [slot[0], origin]);
        if (slot[1] > 0) latest = maxClock(latest, [slot[1], origin]);
      }
    }
  }
  return latest;
};

// Drops every register, counter and set entry that fell below the (new) base.
const applyBase = (entry, delta) => {
  const { meta, data } = entry;
  for (const field of Object.keys(meta.clock)) {
    if (compareClock(meta.clock[field], meta.base) < 0) {
      delete meta.clock[field];
      delete data[field];
      delta[field] = undefined;
    }
  }
  for (const field of Object.keys(meta.counters)) {
    const perOrigin = meta.counters[field];
    for (const origin of Object.keys(perOrigin)) {
      if (compareClock([perOrigin[origin][2], origin], meta.base) < 0) delete perOrigin[origin];
    }
    if (isCounter(meta, field)) {
      const value = counterValue(perOrigin);
      if (data[field] !== value) delta[field] = value;
      data[field] = value;
    } else {
      delete meta.counters[field];
      delete data[field];
      delta[field] = undefined;
    }
  }
  for (const field of Object.keys(meta.sets)) {
    const elements = meta.sets[field];
    for (const key of Object.keys(elements)) {
      const slots = elements[key];
      for (const origin of Object.keys(slots)) {
        const slot = slots[origin];
        const newest = slot[0] > slot[1] ? slot[0] : slot[1];
        if (compareClock([newest, origin], meta.base) < 0) {
          delete slots[origin];
          continue;
        }
        // A component below the base is clamped, not kept: a tag the reset
        // made moot must read the same whether it landed before or after.
        if (slot[0] > 0 && compareClock([slot[0], origin], meta.base) < 0) slot[0] = 0;
        if (slot[1] > 0 && compareClock([slot[1], origin], meta.base) < 0) slot[1] = 0;
      }
      if (Object.keys(slots).length === 0) delete elements[key];
    }
    if (Object.keys(elements).length === 0) {
      delete meta.sets[field];
      delete data[field];
      delta[field] = undefined;
      continue;
    }
    const value = liveElements(elements);
    if (!deepEqual(data[field], value)) delta[field] = value;
    data[field] = value;
  }
  for (const field of Object.keys(meta.seqs)) {
    const next = S.prune(meta.seqs[field], meta.base);
    if (next === null) {
      delete meta.seqs[field];
      delete data[field];
      delta[field] = undefined;
      continue;
    }
    meta.seqs[field] = next;
    // Read again whatever was dropped: a new base can bring an orphan run
    // back to the head.
    const value = S.render(seqIndexOf(entry, field));
    if (!deepEqual(data[field], value)) delta[field] = value;
    data[field] = value;
  }
  for (const field of Object.keys(meta.trees)) {
    const next = T.pruneTree(meta.trees[field], meta.base);
    if (next === null) {
      delete meta.trees[field];
      delete data[field];
      delta[field] = undefined;
      continue;
    }
    meta.trees[field] = next;
    const value = T.renderTree(next);
    if (!deepEqual(data[field], value)) delta[field] = value;
    data[field] = value;
  }
};

// The kinds in order of precedence. When two meet on one field — two nodes
// made it concurrently as different kinds — the lower rank wins, on the op
// path as in a merge: where the winner's op arrives, the loser's state is
// dropped; where the winner is held, the loser's op is refused (`rejected`,
// the `OP_REFUSED` event). Every node ends with the same kind whatever the
// order, since the rule reads the kinds alone. Locally a write of another
// kind is refused before it is stamped (src/commit.js kindClash), so a
// refusal here is a peer's op, a stale one, or a bug.
const RANK = { register: 0, counter: 1, set: 2, list: 3, text: 4, tree: 5 };

// Drops what the kind `held` keeps of `field`; a register is never dropped
// (nothing outranks it).
const dropKind = (entry, field, held, delta) => {
  const { meta } = entry;
  if (held === 'counter') delete meta.counters[field];
  else if (held === 'set') delete meta.sets[field];
  else if (held === 'tree') delete meta.trees[field];
  else {
    delete meta.seqs[field];
    if (entry.seqIndex !== undefined) delete entry.seqIndex[field];
  }
  delete entry.data[field];
  delta[field] = undefined;
};

// Makes room for an op of `kind` on `field`: null when it may land — the
// field was free, its own kind, or held by a kind it outranks, dropped now —
// else the kind that holds the field and keeps it: the holder outranks the
// op, or the op is stamped below the reset that would have taken it anyway.
const yieldTo = (entry, field, kind, stamp, delta) => {
  const held = kindOf(entry, field);
  if (held === undefined || held === kind) return null;
  if (RANK[held] < RANK[kind] || compareClock(stamp, entry.meta.base) < 0) return held;
  dropKind(entry, field, held, delta);
  return null;
};

// Sets register fields at `stamp`, honouring last-writer-wins per field. A
// register outranks every other kind: whatever held the field goes.
const applyFields = (entry, fields, stamp, delta, rejected) => {
  const { meta, data } = entry;
  // Own keys only: `fields` may be a JSON-parsed peer payload, where
  // "__proto__" is an ordinary own key, or an in-process object with a
  // prototype chain nothing here should walk. The clock is read the same
  // way, or a field called `constructor` would meet Object's.
  for (const field of Object.keys(fields)) {
    if (!isKey(field)) continue;
    const holder = yieldTo(entry, field, 'register', stamp, delta);
    if (holder !== null) {
      rejected.push({ field, reason: holder });
      continue;
    }
    if (compareClock(own(meta.clock, field), stamp) >= 0) continue;
    if (compareClock(stamp, meta.base) < 0) continue;
    meta.clock[field] = stamp;
    data[field] = fields[field];
    delta[field] = fields[field];
  }
};

// A set's `add`: the origin's newest add of each element moves up to the
// op's stamp. Maps are created only when a slot is written — an empty map
// left behind by a malformed payload would make two nodes' metas differ.
const addElements = (meta, field, op, stamp) => {
  if (compareClock(stamp, meta.base) < 0) return false;
  let moved = false;
  const { value } = op;
  for (let i = 0; i < value.length; i++) {
    const key = elementKey(value[i]);
    if (key === undefined || !isKey(key)) continue;
    const elements = own(meta.sets, field) ?? (meta.sets[field] = {});
    const slots = own(elements, key) ?? (elements[key] = {});
    const slot = own(slots, op.origin);
    if (!slot) {
      slots[op.origin] = [op.ts, 0];
      moved = true;
    } else if (slot[0] < op.ts) {
      slot[0] = op.ts;
      moved = true;
    }
  }
  return moved;
};

// A set's `remove`: for each element, the tags the remover observed — the
// newest add ts per origin — become that origin's `removed` watermark, so the
// add dies whether it has landed here yet or not. A tag below the base is
// moot (the reset already dropped that add); a tag above the op's own stamp
// is not one an honest remover could have observed.
const removeElements = (meta, field, op) => {
  let moved = false;
  const { value } = op;
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!Array.isArray(item) || item.length !== 2 || !isPlainObject(item[1])) continue;
    const key = elementKey(item[0]);
    if (key === undefined || !isKey(key)) continue;
    const tags = item[1];
    for (const origin of Object.keys(tags)) {
      const ts = tags[origin];
      if (!isKey(origin) || !Number.isSafeInteger(ts) || ts <= 0 || ts > op.ts) continue;
      if (compareClock([ts, origin], meta.base) < 0) continue;
      const elements = own(meta.sets, field) ?? (meta.sets[field] = {});
      const slots = own(elements, key) ?? (elements[key] = {});
      const slot = own(slots, origin);
      if (!slot) {
        slots[origin] = [0, ts];
        moved = true;
      } else if (slot[1] < ts) {
        slot[1] = ts;
        moved = true;
      }
    }
  }
  return moved;
};

const applySet = (entry, op, stamp, delta, rejected) => {
  const { meta } = entry;
  const { key: field } = op;
  if (typeof field !== 'string' || !isKey(field) || !isKey(op.origin) || !Array.isArray(op.value)) return;
  const holder = yieldTo(entry, field, 'set', stamp, delta);
  if (holder !== null) {
    rejected.push({ field, reason: holder });
    return;
  }
  const moved = op.type === 'add' ? addElements(meta, field, op, stamp) : removeElements(meta, field, op);
  if (!moved) return;
  // A tag that moved is news to persist even when the array reads the same.
  entry.data[field] = liveElements(meta.sets[field]);
  delta[field] = entry.data[field];
};

/**
 * Applies one op to an entry (null for a record this node has never seen).
 * Returns `{ entry, changed, delta, rejected }` — a NEW entry, whether it
 * differs, the fields that changed (undefined = removed) and the fields the
 * field-kind rule refused. Idempotent: applying an op twice, or an op older
 * than what the entry already reflects, changes nothing.
 */
// A payload the engine does not admit: reported, so a local caller hears of
// it (a bug) and a peer's is counted (`sync.op.rejected`), never silent.
const malformed = (field, rejected) => {
  rejected.push({ field: typeof field === 'string' ? field : null, reason: 'malformed' });
};

// A `splice` on a list or a text: the block takes the op (src/sequence.js),
// the field reads as its walk. The first op of a field decides its kind by
// what `content` is — a string or an array — and every later one carries
// the same, so a cut that arrives before any run of the field still knows
// what it belongs to. `pendingMax` bounds what the field may hold waiting.
const applySeq = (entry, op, stamp, delta, rejected, pendingMax) => {
  const { meta } = entry;
  const { key: field, value: payload } = op;
  if (typeof field !== 'string' || !isKey(field) || !isKey(op.origin) || !isPlainObject(payload)) {
    return void malformed(field, rejected);
  }
  const kind = typeof payload.content === 'string' ? 't' : Array.isArray(payload.content) ? 'l' : null;
  if (kind === null) return void malformed(field, rejected);
  const holder = yieldTo(entry, field, kind === 't' ? 'text' : 'list', stamp, delta);
  if (holder !== null) {
    rejected.push({ field, reason: holder });
    return;
  }
  if (compareClock(stamp, meta.base) < 0) return;
  const held = own(meta.seqs, field);
  const result = S.applySplice(held ?? S.createSeq(kind), stamp, payload, meta.base, pendingMax);
  settleSeq(entry, field, held, result, delta, rejected);
};

// What a sequence op leaves: the block pruned at once (what fell below the
// base must look the same as if it had never landed, whichever side of the
// reset it arrived on), the field read again, a refusal reported — `bound`
// with which bound, the count and the limit; `malformed` as such.
const settleSeq = (entry, field, held, result, delta, rejected) => {
  const { meta } = entry;
  if (result.reason === 'bound') {
    rejected.push({ field, reason: 'bound', detail: result.detail, count: result.count, max: result.max });
  } else if (result.reason === 'malformed') malformed(field, rejected);
  if (!result.changed) return;
  const seq = S.prune(result.seq, meta.base);
  if (seq === null) {
    if (held !== undefined) {
      delete meta.seqs[field];
      delete entry.data[field];
      delta[field] = undefined;
    }
    return;
  }
  meta.seqs[field] = seq;
  // The new block's index: the held block's extended when the op only
  // appended to a run and the prune left the block as the op made it,
  // walked otherwise. Pending work is news to persist even when the field
  // reads the same.
  const extended = result.extended && seq === result.seq ? { ...result.extended, held } : null;
  entry.data[field] = S.render(seqIndexOf(entry, field, extended));
  delta[field] = entry.data[field];
};

// An `assign` or a `move` on a list, a `mark` on a text: the block's
// registers (src/sequence.js); the kinds' precedence decides on another
// kind. A register or a mark for a field with no block yet names its kind
// and waits, like a cut that comes before its run.
const applyListOp = (entry, op, stamp, delta, rejected, pendingMax) => {
  const kind = op.type === 'mark' ? 't' : 'l';
  const { meta } = entry;
  const { key: field, value: payload } = op;
  if (typeof field !== 'string' || !isKey(field) || !isKey(op.origin) || !isPlainObject(payload)) {
    return void malformed(field, rejected);
  }
  const holder = yieldTo(entry, field, kind === 't' ? 'text' : 'list', stamp, delta);
  if (holder !== null) {
    rejected.push({ field, reason: holder });
    return;
  }
  if (compareClock(stamp, meta.base) < 0) return;
  const held = own(meta.seqs, field);
  const block = held ?? S.createSeq(kind);
  const result =
    op.type === 'assign'
      ? S.applyAssign(block, stamp, payload, meta.base, pendingMax)
      : op.type === 'move'
        ? S.applyMove(block, stamp, payload, meta.base, pendingMax)
        : S.applyMark(block, stamp, payload, meta.base, pendingMax);
  settleSeq(entry, field, held, result, delta, rejected);
};

// A `tree` op: one more move in the field's log (src/tree.js); the field
// reads as the fold. Every other kind outranks a tree; a move below the
// base is moot, like a run.
const applyTree = (entry, op, stamp, delta, rejected) => {
  const { meta } = entry;
  const { key: field, value: payload } = op;
  if (typeof field !== 'string' || !isKey(field) || !isKey(op.origin) || !isPlainObject(payload)) {
    return void malformed(field, rejected);
  }
  const holder = yieldTo(entry, field, 'tree', stamp, delta);
  if (holder !== null) {
    rejected.push({ field, reason: holder });
    return;
  }
  if (compareClock(stamp, meta.base) < 0) return;
  const held = own(meta.trees, field);
  const result = T.applyTreeMove(held ?? T.createTree(), stamp, payload);
  if (result.reason === 'malformed') return void malformed(field, rejected);
  if (!result.changed) return;
  meta.trees[field] = result.tree;
  // A move that did not take is news to persist: a later move can make it count.
  entry.data[field] = T.renderTree(result.tree);
  delta[field] = entry.data[field];
};

// Everything the entry held, gone: the purge, and a merge that meets one.
const erase = (entry, stamp, delta) => {
  const { meta, data } = entry;
  for (const field of Object.keys(data)) delta[field] = undefined;
  entry.data = {};
  meta.clock = {};
  meta.counters = {};
  meta.sets = {};
  meta.seqs = {};
  meta.trees = {};
  // Canonical: whatever came before, a purged entry looks the same, so two
  // nodes that saw the purge and a write in either order hold one meta.
  meta.purged = maxClock(meta.purged ?? null, stamp);
  meta.base = meta.purged;
  meta.deleted = meta.purged;
};

const applyOp = (previous, op, limits = null) => {
  const entry = previous ? cloneEntry(previous) : createEntry();
  const { meta } = entry;
  const stamp = [op.ts, op.origin];
  const delta = {};
  const rejected = [];
  // The node's bound on a sequence field's pending work (`sync.pendingMax`).
  const pendingMax = limits?.pendingMax ?? S.PENDING_MAX;

  // A purged record takes nothing more — not a newer write, not a revival.
  if (meta.purged && op.type !== 'purge' && op.type !== 'merge') {
    return { entry, changed: false, delta, rejected };
  }
  if (op.type === 'purge') {
    erase(entry, stamp, delta);
    const before = previous ? previous.meta.purged : undefined;
    const changed = before === undefined || compareClock(meta.purged, before) > 0;
    return { entry, changed, delta, rejected };
  }

  if (op.type === 'set') {
    if (isPlainObject(op.data)) {
      if (!previous && Number.isInteger(op.v)) meta.v = op.v;
      applyFields(entry, op.data, stamp, delta, rejected);
    }
  } else if (op.type === 'write') {
    if (isPlainObject(op.data) && compareClock(stamp, meta.base) > 0) {
      meta.base = stamp;
      // A write above the tombstone is a revival; dropping the stale stamp
      // keeps the metadata identical whichever order the two arrived in.
      if (compareClock(meta.deleted, meta.base) < 0) meta.deleted = null;
      if (Number.isInteger(op.v)) meta.v = op.v;
      applyBase(entry, delta);
      applyFields(entry, op.data, stamp, delta, rejected);
    }
  } else if (op.type === 'delete') {
    if (compareClock(stamp, meta.base) > 0) {
      meta.base = stamp;
      meta.deleted = stamp;
      applyBase(entry, delta);
    }
  } else if (op.type === 'merge') {
    // A whole entry joined in — how a snapshot page becomes log entries a
    // downstream peer can receive. Idempotent and commutative by
    // construction (see mergeEntry).
    if (isPlainObject(op.data) && isPlainObject(op.meta)) {
      const joined = mergeEntry(previous, { data: op.data, meta: normalizeMeta(op.meta) });
      // Only the replicated halves count: a cached entry also carries its
      // block hash and the encrypted flag.
      const same = previous && deepEqual(joined.data, previous.data) && deepEqual(joined.meta, previous.meta);
      if (!same) {
        for (const field of Object.keys(joined.data)) {
          if (!previous || previous.data[field] !== joined.data[field]) delta[field] = joined.data[field];
        }
        if (previous) {
          for (const field of Object.keys(previous.data)) if (!(field in joined.data)) delta[field] = undefined;
        }
        const before = previous ? previous.meta : null;
        const moved =
          joined.meta.base !== (before ? before.base : null) ||
          joined.meta.deleted !== (before ? before.deleted : null);
        return { entry: joined, changed: true, delta, rejected, moved };
      }
    }
    return { entry, changed: false, delta, rejected };
  } else if (op.type === 'inc') {
    const { key: field, value } = op;
    if (typeof field === 'string' && isKey(field) && isKey(op.origin) && Number.isFinite(value)) {
      const holder = yieldTo(entry, field, 'counter', stamp, delta);
      if (holder !== null) {
        rejected.push({ field, reason: holder });
      } else if (compareClock(stamp, meta.base) >= 0) {
        const perOrigin = own(meta.counters, field) ?? (meta.counters[field] = {});
        const known = own(perOrigin, op.origin);
        if (!known || known[0] < op.seq) {
          perOrigin[op.origin] = [op.seq, (known ? known[1] : 0) + value, op.ts];
          entry.data[field] = counterValue(perOrigin);
          delta[field] = entry.data[field];
        }
      }
    }
  } else if (op.type === 'add' || op.type === 'remove') {
    applySet(entry, op, stamp, delta, rejected);
  } else if (op.type === 'splice') {
    applySeq(entry, op, stamp, delta, rejected, pendingMax);
  } else if (op.type === 'assign' || op.type === 'move' || op.type === 'mark') {
    applyListOp(entry, op, stamp, delta, rejected, pendingMax);
  } else if (op.type === 'tree') {
    applyTree(entry, op, stamp, delta, rejected);
  }

  const before = previous ? previous.meta : null;
  const changed =
    Object.keys(delta).length > 0 ||
    meta.base !== (before ? before.base : null) ||
    meta.deleted !== (before ? before.deleted : null);
  return { entry, changed, delta, rejected };
};

// Alive unless purged, or a tombstone stands and nothing newer has landed.
const isAlive = (entry) => {
  if (!entry) return false;
  const { meta } = entry;
  if (meta.purged) return false;
  if (!meta.deleted) return true;
  for (const field of Object.keys(meta.clock)) {
    if (compareClock(meta.clock[field], meta.deleted) > 0) return true;
  }
  for (const field of Object.keys(meta.counters)) {
    const perOrigin = meta.counters[field];
    for (const origin of Object.keys(perOrigin)) {
      if (compareClock([perOrigin[origin][2], origin], meta.deleted) > 0) return true;
    }
  }
  // An add newer than the tombstone revives, live or since removed — like a
  // counter whose sum is back to zero; a remove alone never does.
  const sets = setsOf(meta);
  for (const field of Object.keys(sets)) {
    const elements = sets[field];
    for (const key of Object.keys(elements)) {
      const slots = elements[key];
      for (const origin of Object.keys(slots)) {
        if (slots[origin][0] > 0 && compareClock([slots[origin][0], origin], meta.deleted) > 0) return true;
      }
    }
  }
  // A list or a text touched after the tombstone revives the record too.
  const seqs = seqsOf(meta);
  for (const field of Object.keys(seqs)) if (compareClock([seqs[field].ts, ''], meta.deleted) > 0) return true;
  const trees = treesOf(meta);
  for (const field of Object.keys(trees)) if (compareClock([trees[field].ts, ''], meta.deleted) > 0) return true;
  return false;
};

/**
 * Joins two entries for the same record — the snapshot merge. Commutative,
 * associative and idempotent, and equal to applying both histories in any
 * interleaving (up to the documented counter/reset straddle). Both entries
 * are expected in this module's shape: a peer's goes through normalizeMeta
 * first (applyOp does that for a `merge` op).
 */
const mergeEntry = (a, b) => {
  if (!a) return b ? cloneEntry(b) : null;
  if (!b) return cloneEntry(a);
  const entry = createEntry();
  const { meta, data } = entry;
  meta.base = maxClock(a.meta.base, b.meta.base);
  meta.deleted = maxClock(a.meta.deleted, b.meta.deleted);
  if (compareClock(meta.deleted, meta.base) < 0) meta.deleted = null;
  if (a.meta.v !== undefined || b.meta.v !== undefined) meta.v = Math.max(a.meta.v ?? 0, b.meta.v ?? 0);
  // A purge on either side is the whole result: nothing to join.
  const purged = maxClock(a.meta.purged ?? null, b.meta.purged ?? null);
  if (purged) {
    erase(entry, purged, {});
    return entry;
  }
  for (const source of [a, b]) {
    for (const field of Object.keys(source.meta.clock)) {
      if (!isKey(field)) continue;
      if (compareClock(source.meta.clock[field], own(meta.clock, field)) > 0) {
        meta.clock[field] = source.meta.clock[field];
        data[field] = source.data[field];
      }
    }
    for (const field of Object.keys(source.meta.counters)) {
      if (!isKey(field)) continue;
      const perOrigin = own(meta.counters, field) ?? (meta.counters[field] = {});
      const from = source.meta.counters[field];
      for (const origin of Object.keys(from)) {
        const held = own(perOrigin, origin);
        if (isKey(origin) && (!held || held[0] < from[origin][0])) perOrigin[origin] = from[origin];
      }
    }
    const sets = setsOf(source.meta);
    for (const field of Object.keys(sets)) {
      if (!isKey(field)) continue;
      const elements = own(meta.sets, field) ?? (meta.sets[field] = {});
      const from = sets[field];
      for (const key of Object.keys(from)) {
        if (!isKey(key)) continue;
        const slots = own(elements, key) ?? (elements[key] = {});
        const theirs = from[key];
        for (const origin of Object.keys(theirs)) {
          if (!isKey(origin)) continue;
          const slot = own(slots, origin);
          if (!slot) {
            slots[origin] = [theirs[origin][0], theirs[origin][1]];
            continue;
          }
          if (slot[0] < theirs[origin][0]) slot[0] = theirs[origin][0];
          if (slot[1] < theirs[origin][1]) slot[1] = theirs[origin][1];
        }
      }
    }
    const seqs = seqsOf(source.meta);
    for (const field of Object.keys(seqs)) {
      if (!isKey(field)) continue;
      const mine = own(meta.seqs, field);
      if (mine === undefined) meta.seqs[field] = seqs[field];
      else if (mine.k === seqs[field].k) meta.seqs[field] = S.join(mine, seqs[field]);
      else if (mine.k === 't') meta.seqs[field] = seqs[field]; // a list outranks a text
    }
    const trees = treesOf(source.meta);
    for (const field of Object.keys(trees)) {
      if (!isKey(field)) continue;
      const mine = own(meta.trees, field);
      meta.trees[field] = mine === undefined ? trees[field] : T.joinTrees(mine, trees[field]);
    }
  }
  applyBase(entry, {});
  // A register that also became a counter on the other side: the register
  // wins (the rule is refuse-on-write, and the writes already happened).
  for (const field of Object.keys(meta.counters)) {
    if (own(meta.clock, field) !== undefined) {
      delete meta.counters[field];
      data[field] = a.meta.clock[field] === meta.clock[field] ? a.data[field] : b.data[field];
    }
  }
  // A set that is a register or a counter on the other side: the register,
  // then the counter, wins — the precedence the writes were refused by.
  for (const field of Object.keys(meta.sets)) {
    if (own(meta.clock, field) !== undefined) {
      delete meta.sets[field];
      data[field] = a.meta.clock[field] === meta.clock[field] ? a.data[field] : b.data[field];
    } else if (isCounter(meta, field)) {
      delete meta.sets[field];
      data[field] = counterValue(meta.counters[field]);
    }
  }
  // A list or a text that is a register, a counter or a set on the other
  // side: those win, in that order — the precedence the writes were refused by.
  for (const field of Object.keys(meta.seqs)) {
    if (own(meta.clock, field) !== undefined) {
      delete meta.seqs[field];
      data[field] = a.meta.clock[field] === meta.clock[field] ? a.data[field] : b.data[field];
    } else if (isCounter(meta, field)) {
      delete meta.seqs[field];
      data[field] = counterValue(meta.counters[field]);
    } else if (isSet(meta, field)) {
      delete meta.seqs[field];
      data[field] = liveElements(meta.sets[field]);
    }
  }
  // A tree that is anything else on the other side: the other kind wins.
  for (const field of Object.keys(meta.trees)) {
    if (own(meta.clock, field) !== undefined) {
      delete meta.trees[field];
      data[field] = a.meta.clock[field] === meta.clock[field] ? a.data[field] : b.data[field];
    } else if (isCounter(meta, field)) {
      delete meta.trees[field];
      data[field] = counterValue(meta.counters[field]);
    } else if (isSet(meta, field)) {
      delete meta.trees[field];
      data[field] = liveElements(meta.sets[field]);
    } else if (isSeq(meta, field)) {
      delete meta.trees[field];
      data[field] = S.render(seqIndexOf(entry, field));
    }
  }
  return entry;
};

// What a `remove` carries for each element: the newest add ts per origin this
// node holds — dead ones too, so the remove reaches a peer that has not seen
// an earlier remove of the same tag. An element the node never saw is left
// out: there is nothing to remove, and nothing a peer could apply.
const observedTags = (meta, field, elements) => {
  const tags = [];
  const known = meta ? own(setsOf(meta), field) : undefined;
  if (!known) return tags;
  for (let i = 0; i < elements.length; i++) {
    const key = elementKey(elements[i]);
    if (key === undefined || !isKey(key)) continue;
    const slots = own(known, key);
    if (!slots) continue;
    const observed = {};
    let any = false;
    for (const origin of Object.keys(slots)) {
      if (slots[origin][0] > 0) {
        observed[origin] = slots[origin][0];
        any = true;
      }
    }
    if (any) tags.push([elements[i], observed]);
  }
  return tags;
};

// The wire/log shape of a batch: one positional array per op, type as a
// single character, absent fields as null — no key names repeated per op. A
// slot may be appended (the writer's schema version was the 13th, the actor
// the 14th, the signature, its payload digest and the digest's nonce the
// 15th to 17th): a reader of an older shape ignores slots it does not know,
// a reader of a newer one takes an absent slot as null.
const TYPE_CODES = {
  write: 'w',
  set: 's',
  inc: 'i',
  delete: 'd',
  merge: 'm',
  advance: 'a',
  purge: 'p',
  add: '+',
  remove: '-',
  splice: '/',
  assign: '=',
  move: '^',
  mark: '*',
  tree: '~',
};
const CODE_TYPES = {
  w: 'write',
  s: 'set',
  i: 'inc',
  d: 'delete',
  m: 'merge',
  a: 'advance',
  p: 'purge',
  '+': 'add',
  '-': 'remove',
  '/': 'splice',
  '=': 'assign',
  '^': 'move',
  '*': 'mark',
  '~': 'tree',
};

const packOps = (ops) => {
  const packed = new Array(ops.length);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    packed[i] = [
      op.origin,
      op.seq,
      op.ts,
      own(TYPE_CODES, op.type) ?? op.type,
      op.id,
      op.scope ?? null,
      op.data === undefined ? null : op.data,
      op.meta === undefined ? null : op.meta,
      op.key === undefined ? null : op.key,
      op.value === undefined ? null : op.value,
      op.vector === undefined ? null : op.vector,
      op.from === undefined ? null : op.from,
      op.v === undefined ? null : op.v,
      op.actor === undefined ? null : op.actor,
      op.sig === undefined ? null : op.sig,
      op.digest === undefined ? null : op.digest,
      op.nonce === undefined ? null : op.nonce,
    ];
  }
  return packed;
};

const unpackOps = (packed) => {
  if (!Array.isArray(packed)) return [];
  const ops = [];
  for (const row of packed) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [origin, seq, ts, code, id, scope, data, meta, key, value, vector, from, v, actor, sig, digest, nonce] = row;
    const op = { origin, seq, ts, type: own(CODE_TYPES, code) ?? code };
    if (id !== null && id !== undefined) op.id = id;
    if (v !== null && v !== undefined) op.v = v;
    if (actor !== null && actor !== undefined) op.actor = actor;
    if (sig !== null && sig !== undefined) op.sig = sig;
    if (digest !== null && digest !== undefined) op.digest = digest;
    if (nonce !== null && nonce !== undefined) op.nonce = nonce;
    if (vector !== null && vector !== undefined) op.vector = vector;
    if (from !== null && from !== undefined) op.from = from;
    if (scope !== null && scope !== undefined) op.scope = scope;
    if (data !== null && data !== undefined) op.data = data;
    if (meta !== null && meta !== undefined) op.meta = meta;
    if (key !== null && key !== undefined) op.key = key;
    if (value !== null && value !== undefined) op.value = value;
    ops.push(op);
  }
  return ops;
};

// What a field is in an entry, by its meta: register, counter, set, list,
// text, tree — or undefined. `kindsOf` names every field of the entry.
const kindOf = (entry, field) => {
  const { meta } = entry;
  if (isCounter(meta, field)) return 'counter';
  if (isSet(meta, field)) return 'set';
  if (isSeq(meta, field)) return seqKind(meta, field);
  if (isTree(meta, field)) return 'tree';
  return own(entry.data, field) !== undefined || own(meta.clock, field) !== undefined ? 'register' : undefined;
};

const kindsOf = (entry) => {
  const kinds = {};
  if (!entry) return kinds;
  for (const field of new Set([...Object.keys(entry.data), ...Object.keys(entry.meta.clock)])) {
    kinds[field] = kindOf(entry, field);
  }
  return kinds;
};

module.exports = {
  createEntry,
  cloneEntry,
  applyOp,
  mergeEntry,
  isAlive,
  isCounter,
  isSet,
  isSeq,
  isTree,
  seqIndexOf,
  kindOf,
  kindsOf,
  observedTags,
  latestClock,
  deepEqual,
  packOps,
  unpackOps,
};
