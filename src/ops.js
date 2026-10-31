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
//   gone[f]     — the field's own reset watermark, set by an `unset`: what
//                 the field held below it is pruned (a register, a counter's
//                 slots, a set's tags, a block's runs — as under `base`), an
//                 op on the field stamped below it is moot, one above it
//                 makes the field again, of whatever kind the op is
//   base        — the record-reset watermark: a field is visible only if its
//                 clock is not below base. A `write` (whole-record write) and
//                 a `delete` both raise it, which is what stops an older
//                 concurrent `set` from resurrecting a field they removed.
//   deleted     — the tombstone stamp; the record is alive again as soon as
//                 something newer than it lands (see isAlive)
//   counters[f] — { [stream]: [seq, sum, ts] }: a PN-counter, one running sum
//                 per STREAM — the op's vector key, `origin` or `origin@scope`
//                 (src/vector.js opKey), since seqs run per stream: re-applying
//                 an `inc` (seq already seen in its stream) is a no-op, two
//                 snapshots join by taking the higher seq per stream, and one
//                 node's incs in two scopes are two sums; the global stream's
//                 slot is keyed by the bare origin. A sum
//                 stays within ±MAX_COUNT, an inc past it is a `bound` refusal
//   sets[f]     — { [elementKey]: { [origin]: [added, removed] } }: an
//                 observed-remove set. elementKey is the element's JSON text;
//                 per (element, origin) the ts of that origin's newest `add`
//                 and the newest add ts a `remove` had observed (0 = none).
//                 The element is live for that origin iff added > removed.
//   blocks[f]   — a field of a kind a plugin brings (src/plugin.js): a list
//                 or a text (the sequence engine's block, @alexify/syncom/text),
//                 a tree (the move log, @alexify/syncom/tree). `k` names the
//                 kind's code, `ts` the newest stamp the block holds; how the
//                 block applies an op, joins with a peer's, prunes under a
//                 reset and reads is the plugin's — why it converges is argued
//                 there. data[f] is what the plugin renders.
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
// A field may be a PATH (`profile/city`, src/paths.js): a field of its own
// in every map here, under the prefixes above it. A register at a prefix
// is the floor of what hangs under it — a whole-object write of `profile`
// resets `profile/*` stamped below it, a later child survives and is read
// over the object — and an unset of a prefix takes the subtree; a counter,
// a set or a block holds its prefix alone: an op under one is refused, and
// where one lands, what hung under the prefix goes (the same whatever the
// order, like the kinds' precedence). A record holds at most MAX_PATHS
// fields.
//
// A field is a REGISTER, a COUNTER, a SET, or a kind of one block, never two
// of them. Locally an op on a field of another kind is refused before it is
// stamped (`kindClash` in src/commit.js). From a peer the kinds' precedence
// decides, on the op path (`yieldTo`) as on a snapshot merge: the register
// wins, then the counter, the set, then the plugins' kinds by their declared
// rank (list, text, tree). Where the winner arrives the loser's state is
// dropped; where the winner is held the loser's op is refused (reported in
// `rejected`). The rule reads kinds alone, never stamps, which is what makes
// it commute. An op of a kind this node has no plugin for is refused as
// `reason: 'kind'` — reported, logged and relayed by the apply path, never
// silently dropped; a block of such a kind in a peer's meta is left out.
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

const { compareClock, maxClock, floorOf, opKey } = require('./vector.js');
const { deepEqual, OP_TYPES, asJson, isPlainObject, own } = require('./shape.js');
// The wire's packing is src/sync/wire.js's; re-exported for the readers of this module.
const { packOps, unpackOps } = require('./sync/wire.js');
const { limitsOf, HOME, EMPTY: NO_PLUGINS } = require('./plugin.js');
const { isPath, ancestorsOf, under, MAX_PATHS } = require('./paths.js');

const createEntry = () => ({
  data: {},
  meta: { clock: {}, base: null, deleted: null, counters: {}, sets: {}, blocks: {}, gone: {} },
});

// A meta without a `sets`, `blocks` or `gone` key — a peer's raw one, read
// before it is normalized — reads it as empty.
const EMPTY = Object.freeze({});
const setsOf = (meta) => meta.sets ?? EMPTY;
const blocksOf = (meta) => meta.blocks ?? EMPTY;
const goneOf = (meta) => meta.gone ?? EMPTY;

// Whether an object holds an own key: `Object.keys(x).length > 0` built
// the array of every key to answer — the whole of a set of 20 000 elements
// per op, for a kind check. The walk stops at the first own key; an
// inherited one (there is none on the trusted shapes) is skipped.
const hasAny = (object) => {
  // oxlint-disable-next-line guard-for-in -- every key is checked to be own
  for (const key in object) if (Object.hasOwn(object, key)) return true;
  return false;
};

// A set field's elements, copied whole: the map, every slot map and slot.
const cloneElements = (from) => {
  const elements = {};
  for (const key of Object.keys(from)) {
    const slots = {};
    const theirs = from[key];
    for (const origin of Object.keys(theirs)) slots[origin] = [theirs[origin][0], theirs[origin][1]];
    elements[key] = slots;
  }
  return elements;
};

// A set field's elements map that holds an element — remembered per map: a
// key walk of a dictionary-mode object lists every key even to find the
// first (20 000 elements, half a millisecond per kind check). Only a yes is
// kept: a map is written only as this meta's own copy (`writableSet`), and a
// write never empties one — a prune that does removes the map.
const FILLED = new WeakSet();

// The set fields an op derived entry owns: `cloneEntry` shares every set
// field with the entry it copies — a set of thousands of elements was copied
// whole by every op of its record, a keystroke in another field included —
// and the first write of a field copies it (`writableSet`), per meta.
const OWNED_SETS = new WeakMap();

// The elements of set `field` of `meta`, this meta's own: created, or
// copied from the entry it was cloned from, at the first write.
const writableSet = (meta, field) => {
  let owned = OWNED_SETS.get(meta);
  if (owned === undefined) OWNED_SETS.set(meta, (owned = new Set()));
  if (owned.has(field)) return meta.sets[field];
  const held = own(meta.sets, field);
  const elements = held === undefined ? {} : cloneElements(held);
  if (held !== undefined && FILLED.has(held)) FILLED.add(elements);
  meta.sets[field] = elements;
  owned.add(field);
  return elements;
};

const cloneEntry = (entry) => {
  const counters = {};
  for (const field of Object.keys(entry.meta.counters)) counters[field] = { ...entry.meta.counters[field] };
  const meta = {
    clock: { ...entry.meta.clock },
    base: entry.meta.base,
    deleted: entry.meta.deleted,
    counters,
    // Shared, field by field, until an op writes one (writableSet).
    sets: { ...setsOf(entry.meta) },
    // A block is never mutated in place (a plugin hands back a new one), so
    // the map is copied and the blocks are shared.
    blocks: { ...blocksOf(entry.meta) },
    gone: { ...goneOf(entry.meta) },
  };
  if (entry.meta.v !== undefined) meta.v = entry.meta.v;
  if (entry.meta.purged !== undefined) meta.purged = entry.meta.purged;
  // Nothing a plugin cached on the entry comes along: a block read from a
  // file is hydrated once through the plugin's own cache, keyed by the plain
  // block (src/text/sequence.js), and the copy that outlived it held the
  // parsed JSON and an old index for as long as the record lived.
  return { data: { ...entry.data }, meta };
};

// What one stream's running sum may reach, either way: past it a float
// would no longer count an increment of 1, and the next step is Infinity,
// which JSON keeps as null. Each sum depends on its stream's ops alone, so a
// bound on it refuses the same op on every node.
const MAX_COUNT = Number.MAX_SAFE_INTEGER;

// The sums added up in the order of their slots' keys: floats round by the
// order they are added in, and the order of arrival differs between nodes.
const counterValue = (perStream) => {
  let sum = 0;
  for (const stream of Object.keys(perStream).sort()) sum += perStream[stream][1];
  return sum;
};

// The origin of a counter slot's stream (an origin never holds `@`), and
// the slot's stamp: its newest inc's, under that origin.
const streamOrigin = (stream) => {
  const at = stream.indexOf('@');
  return at === -1 ? stream : stream.slice(0, at);
};
const slotStamp = (stream, count) => [count[2], streamOrigin(stream)];

const isCounter = (meta, field) => {
  const perStream = own(meta.counters, field);
  return Boolean(perStream) && hasAny(perStream);
};

const isSet = (meta, field) => {
  const elements = own(setsOf(meta), field);
  if (!elements) return false;
  if (FILLED.has(elements)) return true;
  if (!hasAny(elements)) return false;
  FILLED.add(elements);
  return true;
};

// A field a plugin's block holds — a list, a text, a tree.
const isBlock = (meta, field) => own(blocksOf(meta), field) !== undefined;

// The plugin a block's code names, and the kind it reads as. A block whose
// code no registered plugin knows (it cannot be in an entry this node built,
// since normalizeMeta leaves such a block out) reads as its code, with no
// rank: anything outranks it.
const moduleOf = (plugins, block) => (typeof block.k === 'string' ? own(plugins.byCode, block.k) : undefined);
const kindOfBlock = (plugins, block) => moduleOf(plugins, block)?.codes[block.k] ?? block.k;
const rankOf = (plugins, kind) => own(plugins.rank, kind) ?? Infinity;

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
  const values = [];
  for (let i = 0; i < keys.length; i++) values.push(JSON.parse(keys[i]));
  return values;
};

// Whether an element's slots hold a live add.
const isLive = (slots) => {
  if (slots === undefined) return false;
  for (const origin of Object.keys(slots)) if (slots[origin][0] > slots[origin][1]) return true;
  return false;
};

// Where `key` is, or would go, among the live elements `values` (sorted by
// their text): a binary search, an element's text made per step.
const placeOf = (values, key) => {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (elementKey(values[mid]) < key) low = mid + 1;
    else high = mid;
  }
  return low;
};

// A key a JSON payload may carry that must never become a property name
// here: assigning under it would replace the object's prototype. Every
// other name — `constructor`, `toString` — is a field like any other, which
// is why lookups below go through `own` rather than the prototype chain.
const isKey = (key) => key !== '__proto__';

// A stamp is `[ts, origin]`, ts a positive safe integer like an op's: what a
// peer's meta holds otherwise (a float, 1e300, Infinity) is no stamp.
const isStamp = (value) =>
  Array.isArray(value) &&
  value.length === 2 &&
  Number.isSafeInteger(value[0]) &&
  value[0] > 0 &&
  typeof value[1] === 'string';
const stampOf = (value) => (isStamp(value) ? [value[0], value[1]] : null);
const isCount = (value) =>
  Array.isArray(value) &&
  Number.isInteger(value[0]) &&
  Number.isFinite(value[1]) &&
  Math.abs(value[1]) <= MAX_COUNT &&
  typeof value[2] === 'number';
const isSlot = (value) =>
  Array.isArray(value) &&
  value.length === 2 &&
  Number.isSafeInteger(value[0]) &&
  value[0] >= 0 &&
  Number.isSafeInteger(value[1]) &&
  value[1] >= 0 &&
  value[0] + value[1] > 0;

// A peer-supplied meta, rebuilt into the shape the rest of this module
// trusts: own keys only, stamps as `[ts, origin]`, counters as `[seq, sum,
// ts]` per stream, set slots as `[added, removed]` per element and origin
// under a canonical JSON key, each block normalized by its plugin under the
// node's bounds, anything else dropped. A copy, so nothing of the peer's
// object is kept by reference and a `__proto__` key in it reaches nothing.
// A block of a kind no plugin here knows is left out and, when `dropped` is
// given, reported there as `{ field, reason: 'kind', kind }`.
// A peer's meta normalized once per object and bounds, where its holder
// says it will not change (`settleMeta`: a snapshot record's copy, an op's
// meta): a snapshot record is asked its newest stamp (the skew check, then
// the clock) and then joined — three walks of it, its blocks hydrated three
// times. The result is shared and read-only (mergeEntry copies what it
// keeps); the kinds it dropped are told again to every caller that asks.
const SETTLED = new WeakSet();
const NORMALIZED = new WeakMap();
const settleMeta = (meta) => {
  if (isPlainObject(meta)) SETTLED.add(meta);
  return meta;
};
const normalizeMeta = (meta, limits = null, dropped = null) => {
  const bounds = limitsOf(limits);
  if (!SETTLED.has(meta)) return normalizeOnce(meta, bounds, dropped);
  const memo = NORMALIZED.get(meta);
  if (memo !== undefined && memo.pendingMax === bounds.pendingMax && memo.plugins === bounds.plugins) {
    if (dropped !== null) for (let i = 0; i < memo.dropped.length; i++) dropped.push(memo.dropped[i]);
    return memo.normalized;
  }
  const told = [];
  const normalized = normalizeOnce(meta, bounds, told);
  if (dropped !== null) for (let i = 0; i < told.length; i++) dropped.push(told[i]);
  NORMALIZED.set(meta, { pendingMax: bounds.pendingMax, plugins: bounds.plugins, normalized, dropped: told });
  return normalized;
};

const normalizeOnce = (meta, bounds, dropped) => {
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
      const perStream = {};
      for (const stream of Object.keys(source)) {
        const count = source[stream];
        if (isKey(stream) && isCount(count)) perStream[stream] = [count[0], count[1], count[2]];
      }
      if (Object.keys(perStream).length > 0) counters[field] = perStream;
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
  // The reset watermarks first — the record's, and each field's own: they
  // decide which of a block's runs are orphans (read from the head) and
  // which wait for an anchor (bounded).
  const base = stampOf(meta.base);
  const gone = {};
  if (isPlainObject(meta.gone)) {
    for (const field of Object.keys(meta.gone)) {
      const stamp = stampOf(meta.gone[field]);
      if (isKey(field) && stamp) gone[field] = stamp;
    }
  }
  const blocks = {};
  if (isPlainObject(meta.blocks)) {
    for (const field of Object.keys(meta.blocks)) {
      const raw = meta.blocks[field];
      if (!isKey(field) || !isPlainObject(raw)) continue;
      const mod = moduleOf(bounds.plugins, raw);
      if (mod === undefined) {
        if (dropped !== null) dropped.push({ field, reason: 'kind', kind: typeof raw.k === 'string' ? raw.k : null });
        continue;
      }
      const block = mod.normalize(raw, floorOf({ base, gone }, field), bounds);
      if (block !== null) blocks[field] = block;
    }
  }
  const normalized = { clock, base, deleted: stampOf(meta.deleted), counters, sets, blocks, gone };
  // Fields are paths, at most MAX_PATHS of them: the first in sorted order stay.
  const fields = new Set();
  const kept = [];
  for (const map of [clock, counters, sets, blocks, gone]) {
    for (const field of Object.keys(map)) {
      if (fields.has(field)) continue;
      fields.add(field);
      if (isPath(field)) kept.push(field);
    }
  }
  if (kept.length < fields.size || kept.length > MAX_PATHS) {
    kept.sort();
    const allowed = new Set(kept.length > MAX_PATHS ? kept.slice(0, MAX_PATHS) : kept);
    for (const map of [clock, counters, sets, blocks, gone]) {
      for (const field of Object.keys(map)) if (!allowed.has(field)) delete map[field];
    }
  }
  if (Number.isInteger(meta.v)) normalized.v = meta.v;
  const purged = stampOf(meta.purged);
  if (purged) normalized.purged = purged;
  return normalized;
};

// The newest stamp an entry's metadata holds, over registers, the reset
// watermark, the tombstone, the counters, the sets and the blocks — what a
// node must have observed before it stamps a write to that record, or the
// write sorts below state the node already has and is dropped as stale.
// `trusted` says the meta is this module's own shape (an entry this node
// holds); a peer's raw meta is rebuilt first, under `limits`.
const latestClock = (meta, trusted = false, limits = null) => {
  if (!isPlainObject(meta)) return null;
  const { clock, base, deleted, counters, sets, blocks, gone, purged } = trusted
    ? { ...meta, sets: setsOf(meta), blocks: blocksOf(meta), gone: goneOf(meta) }
    : normalizeMeta(meta, limits);
  let latest = maxClock(maxClock(base, deleted), purged ?? null);
  for (const field of Object.keys(gone)) latest = maxClock(latest, gone[field]);
  for (const field of Object.keys(blocks)) latest = maxClock(latest, [blocks[field].ts, '']);
  for (const field of Object.keys(clock)) latest = maxClock(latest, clock[field]);
  for (const field of Object.keys(counters)) {
    const perStream = counters[field];
    for (const stream of Object.keys(perStream)) latest = maxClock(latest, slotStamp(stream, perStream[stream]));
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

// The newest ts of a meta this node holds — what a write path observes into
// the clock before it stamps (the clock reads a stamp's ts alone) — as a
// stamp `[ts, '']`, or null. Known without a walk once an entry has been
// asked: an op's result takes its source's and the op's ts (no stamp an op
// lays is newer than its own — a remove's tags, an inc's slot, a block's
// runs); a meta read from a file or joined in a merge is walked once. The
// walk went over every set element of the record on every local write.
const LATEST = new WeakMap();
const latestHeld = (meta) => {
  if (!isPlainObject(meta)) return null;
  let ts = LATEST.get(meta);
  if (ts === undefined) {
    const latest = latestClock(meta, true);
    ts = latest === null ? 0 : latest[0];
    LATEST.set(meta, ts);
  }
  return ts > 0 ? [ts, ''] : null;
};

// Drops a block field.
const dropBlock = (entry, field) => {
  delete entry.meta.blocks[field];
};

// Drops what `field` holds below `floor`: a register stamped under it, a
// counter's slots, a set's tags (a surviving component under it clamped,
// not kept: a tag the reset made moot must read the same whether it landed
// before or after), and prunes a block under it (the plugin's rule), the
// field read again whatever was dropped: a new floor can bring an orphan
// run back to the head.
const pruneField = (entry, field, floor, delta, plugins) => {
  const { meta, data } = entry;
  const clock = own(meta.clock, field);
  if (clock !== undefined && compareClock(clock, floor) < 0) {
    delete meta.clock[field];
    delete data[field];
    delta[field] = undefined;
  }
  const perStream = own(meta.counters, field);
  if (perStream !== undefined) {
    for (const stream of Object.keys(perStream)) {
      if (compareClock(slotStamp(stream, perStream[stream]), floor) < 0) delete perStream[stream];
    }
    if (isCounter(meta, field)) {
      const value = counterValue(perStream);
      if (data[field] !== value) delta[field] = value;
      data[field] = value;
    } else {
      delete meta.counters[field];
      delete data[field];
      delta[field] = undefined;
    }
  }
  if (own(meta.sets, field) !== undefined) {
    const elements = writableSet(meta, field);
    for (const key of Object.keys(elements)) {
      const slots = elements[key];
      for (const origin of Object.keys(slots)) {
        const slot = slots[origin];
        const newest = slot[0] > slot[1] ? slot[0] : slot[1];
        if (compareClock([newest, origin], floor) < 0) {
          delete slots[origin];
          continue;
        }
        if (slot[0] > 0 && compareClock([slot[0], origin], floor) < 0) slot[0] = 0;
        if (slot[1] > 0 && compareClock([slot[1], origin], floor) < 0) slot[1] = 0;
      }
      if (Object.keys(slots).length === 0) delete elements[key];
    }
    if (Object.keys(elements).length === 0) {
      delete meta.sets[field];
      delete data[field];
      delta[field] = undefined;
    } else {
      const value = liveElements(elements);
      if (!deepEqual(data[field], value)) delta[field] = value;
      data[field] = value;
    }
  }
  const block = own(meta.blocks, field);
  if (block !== undefined) {
    const mod = moduleOf(plugins, block);
    const next = mod === undefined ? null : mod.prune(block, floor);
    if (next === null) {
      dropBlock(entry, field);
      delete data[field];
      delta[field] = undefined;
    } else {
      meta.blocks[field] = next;
      const value = mod.render(entry, field, next);
      if (!deepEqual(data[field], value)) delta[field] = value;
      data[field] = value;
    }
  }
};

// Every field pruned under its floor — the (new) record base, or its own
// unset, whichever is newer; a field's own watermark below the base is moot
// and goes.
const applyBase = (entry, delta, plugins) => {
  const { meta } = entry;
  for (const field of Object.keys(meta.gone)) {
    if (compareClock(meta.gone[field], meta.base) < 0) delete meta.gone[field];
  }
  const fields = new Set([
    ...Object.keys(meta.clock),
    ...Object.keys(meta.counters),
    ...Object.keys(meta.sets),
    ...Object.keys(meta.blocks),
  ]);
  for (const field of fields) pruneField(entry, field, floorOf(meta, field), delta, plugins);
};

// The fields under `prefix` — the paths of the subtree.
const fieldsUnder = (meta, prefix) => {
  const out = new Set();
  for (const map of [meta.clock, meta.counters, meta.sets, meta.blocks]) {
    for (const field of Object.keys(map)) if (under(field, prefix)) out.add(field);
  }
  return out;
};

// Every field under `prefix` pruned under `floor` — a register written at
// the prefix, or the prefix unset: the subtree below the stamp goes.
const pruneUnder = (entry, prefix, floor, delta, plugins) => {
  for (const field of fieldsUnder(entry.meta, prefix)) pruneField(entry, field, floor, delta, plugins);
};

// Every field under `prefix` dropped, whatever its stamp: a counter, a set
// or a block holds its prefix alone.
const dropUnder = (entry, prefix, delta, plugins) => {
  const { meta } = entry;
  for (const field of fieldsUnder(meta, prefix)) {
    const held = kindOf(entry, field, plugins);
    if (held === 'register') {
      delete meta.clock[field];
      delete entry.data[field];
      delta[field] = undefined;
    } else if (held !== undefined) dropKind(entry, field, held, delta);
    delete meta.gone[field];
  }
};

// Whether the kind `kind` of `plugins` nests: a list's elements and a
// tree's nodes carry fields of their own; a text, a counter, a set do not.
const nests = (plugins, kind) => own(plugins.byName, kind)?.nests?.[kind] === true;

// The prefix of `field` a counter, a set or a block that does not nest
// holds, and its kind — an op under it is refused — or null. Under a kind
// that nests, the next segment names a member, no field.
const holderAbove = (entry, field, plugins) => {
  if (!field.includes('/')) return null;
  let member = false;
  for (const prefix of ancestorsOf(field)) {
    if (member) {
      member = false;
      continue;
    }
    const kind = kindOf(entry, prefix, plugins);
    if (kind === undefined || kind === 'register') continue;
    if (nests(plugins, kind)) {
      member = true;
      continue;
    }
    return { prefix, kind };
  }
  return null;
};

// Whether `field` is new to the entry and the record holds MAX_PATHS fields
// already: an op that would add it is refused as `bound`.
const pathsFull = (entry, field, rejected) => {
  const { meta } = entry;
  const maps = [meta.clock, meta.counters, meta.sets, meta.blocks];
  for (const map of maps) if (own(map, field) !== undefined) return false;
  const fields = new Set();
  for (const map of maps) for (const key of Object.keys(map)) fields.add(key);
  if (fields.size < MAX_PATHS) return false;
  rejected.push({ field, reason: 'bound', detail: 'paths', count: fields.size + 1, max: MAX_PATHS });
  return true;
};

// Drops what the kind `held` keeps of `field`; a register is never dropped
// (nothing outranks it).
const dropKind = (entry, field, held, delta) => {
  const { meta } = entry;
  if (held === 'counter') delete meta.counters[field];
  else if (held === 'set') delete meta.sets[field];
  else dropBlock(entry, field);
  delete entry.data[field];
  delta[field] = undefined;
};

// Makes room for an op of `kind` on `field`: null when it may land — the
// field was free, its own kind, or held by a kind it outranks, dropped now —
// else the kind that holds the field and keeps it: the holder outranks the
// op, or the op is stamped below the reset that would have taken it anyway.
// The kinds in order of precedence are the registry's ranks (src/plugin.js):
// the register, the counter, the set, then the plugins' kinds.
const yieldTo = (entry, field, kind, stamp, delta, plugins) => {
  const held = kindOf(entry, field, plugins);
  if (held === undefined || held === kind) return null;
  if (rankOf(plugins, held) < rankOf(plugins, kind) || compareClock(stamp, floorOf(entry.meta, field)) < 0) return held;
  dropKind(entry, field, held, delta);
  return null;
};

// Room for an op of `kind` on `field`, with the paths in mind: a prefix a
// counter, a set or a block holds refuses it (`rejected` names the prefix),
// a new field past MAX_PATHS is `bound`, and the kinds' precedence decides
// the rest (`yieldTo`); null when the op may land.
const roomFor = (entry, field, kind, stamp, delta, rejected, plugins) => {
  const above = holderAbove(entry, field, plugins);
  if (above !== null) {
    rejected.push({ field, reason: above.kind, prefix: above.prefix });
    return above.kind;
  }
  if (pathsFull(entry, field, rejected)) return 'bound';
  const holder = yieldTo(entry, field, kind, stamp, delta, plugins);
  if (holder !== null) rejected.push({ field, reason: holder });
  return holder;
};

// Removes fields at `stamp`: each field's own reset watermark moves up to
// it and what the field held below it goes, whatever its kind — an op on
// the field stamped below the watermark is moot from then on, one above
// it makes the field again. A field never set here takes the watermark too
// (news to persist: a peer's older write of it must still lose), and reads
// as removed in the delta.
const applyUnset = (entry, fields, stamp, delta, plugins) => {
  const { meta } = entry;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!isPath(field)) continue;
    if (compareClock(stamp, meta.base) < 0) continue;
    if (compareClock(own(meta.gone, field), stamp) >= 0) continue;
    meta.gone[field] = stamp;
    pruneField(entry, field, stamp, delta, plugins);
    pruneUnder(entry, field, stamp, delta, plugins);
    delta[field] = undefined;
  }
};

// Sets register fields at `stamp`, honouring last-writer-wins per field. A
// register outranks every other kind: whatever held the field goes.
const applyFields = (entry, fields, stamp, delta, rejected, plugins, changes = null) => {
  const { meta, data } = entry;
  // Own keys only: `fields` may be a JSON-parsed peer payload, where
  // "__proto__" is an ordinary own key, or an in-process object with a
  // prototype chain nothing here should walk. The clock is read the same
  // way, or a field called `constructor` would meet Object's.
  for (const field of Object.keys(fields)) {
    if (!isPath(field)) continue;
    if (roomFor(entry, field, 'register', stamp, delta, rejected, plugins) !== null) continue;
    if (compareClock(own(meta.clock, field), stamp) >= 0) continue;
    if (compareClock(stamp, floorOf(meta, field)) < 0) continue;
    meta.clock[field] = stamp;
    data[field] = fields[field];
    delta[field] = fields[field];
    if (changes !== null) {
      changes.push({ action: 'put', field, value: fields[field] });
      changes.covered.add(field);
    }
    // A register written at a prefix resets what hangs under it below the stamp.
    pruneUnder(entry, field, stamp, delta, plugins);
  }
};

// A set's `add`: the origin's newest add of each element moves up to the
// op's stamp. Maps are created only when a slot is written — an empty map
// left behind by a malformed payload would make two nodes' metas differ.
const addElements = (meta, field, op, stamp) => {
  if (compareClock(stamp, floorOf(meta, field)) < 0) return false;
  let moved = false;
  const { value } = op;
  for (let i = 0; i < value.length; i++) {
    const key = elementKey(value[i]);
    if (key === undefined || !isKey(key)) continue;
    const elements = writableSet(meta, field);
    const slots = own(elements, key) ?? (elements[key] = {});
    const slot = own(slots, op.origin);
    if (!slot) {
      slots[op.origin] = [op.ts, 0];
      FILLED.add(elements);
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
      if (compareClock([ts, origin], floorOf(meta, field)) < 0) continue;
      const elements = writableSet(meta, field);
      const slots = own(elements, key) ?? (elements[key] = {});
      const slot = own(slots, origin);
      if (!slot) {
        slots[origin] = [0, ts];
        FILLED.add(elements);
        moved = true;
      } else if (slot[1] < ts) {
        slot[1] = ts;
        moved = true;
      }
    }
  }
  return moved;
};

// A payload the engine does not admit: reported, so a local caller hears of
// it (a bug) and a peer's is counted (`sync.op.rejected`), never silent.
const malformed = (field, rejected) => {
  rejected.push({ field: typeof field === 'string' ? field : null, reason: 'malformed' });
};

// The elements an add or a remove names, each by its text, once.
const namedElements = (op) => {
  const out = [];
  const seen = new Set();
  const { value } = op;
  for (let i = 0; i < value.length; i++) {
    let element = value[i];
    if (op.type === 'remove') {
      if (!Array.isArray(element) || element.length !== 2 || !isPlainObject(element[1])) continue;
      element = element[0];
    }
    const key = elementKey(element);
    if (key === undefined || !isKey(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
};

// Past this many elements in and out, the reading is made again whole
// rather than laid one element at a time into the one before.
const SET_STEPS = 32;

const applySet = (entry, op, stamp, delta, rejected, plugins, changes) => {
  const { meta } = entry;
  const { key: field } = op;
  if (!isPath(field) || !isKey(op.origin) || !Array.isArray(op.value)) {
    return void malformed(field, rejected);
  }
  if (roomFor(entry, field, 'set', stamp, delta, rejected, plugins) !== null) return;
  // What the op names, and which of it was live: the reading moves by what
  // came in and went out, never by a walk of the set — a set of 20 000
  // elements read and sorted whole on every add made each one milliseconds.
  const held = own(meta.sets, field);
  const before = Array.isArray(entry.data[field]) ? entry.data[field] : null;
  const named = namedElements(op);
  const was = [];
  for (let i = 0; i < named.length; i++) was.push(held !== undefined && isLive(own(held, named[i])));
  const moved = op.type === 'add' ? addElements(meta, field, op, stamp) : removeElements(meta, field, op);
  if (!moved) return;
  // A set holds its prefix alone.
  dropUnder(entry, field, delta, plugins);
  const elements = meta.sets[field];
  const added = [];
  const removed = [];
  for (let i = 0; i < named.length; i++) {
    const live = isLive(own(elements, named[i]));
    if (live && !was[i]) added.push(named[i]);
    else if (!live && was[i]) removed.push(named[i]);
  }
  added.sort();
  removed.sort();
  let now;
  if (before === null || added.length + removed.length > SET_STEPS) {
    now = liveElements(elements);
  } else if (added.length + removed.length === 0) {
    now = before;
  } else {
    now = before.slice();
    for (let i = 0; i < removed.length; i++) {
      const at = placeOf(now, removed[i]);
      if (at < now.length && elementKey(now[at]) === removed[i]) now.splice(at, 1);
    }
    for (let i = 0; i < added.length; i++) now.splice(placeOf(now, added[i]), 0, JSON.parse(added[i]));
  }
  // A tag that moved is news to persist even when the array reads the same.
  entry.data[field] = now;
  delta[field] = now;
  // What the reading shows of it: the elements now in, the elements now out.
  if (added.length > 0) {
    const values = [];
    for (let i = 0; i < added.length; i++) values.push(JSON.parse(added[i]));
    changes.push({ action: 'add', field, elements: values });
  }
  if (removed.length > 0) {
    const values = [];
    for (let i = 0; i < removed.length; i++) values.push(JSON.parse(removed[i]));
    changes.push({ action: 'remove', field, elements: values });
  }
  changes.covered.add(field);
};

// An op of a plugin's kind: the shape every block op shares is checked
// here, the kinds' precedence decides on another kind under the field, an
// op below the reset is moot, and the plugin applies the op to the block it
// holds (none yet: the plugin makes one). What the plugin hands back — a new
// block, or none, and a refusal: `bound` with which bound, the count and
// the limit; `malformed` as such — lands on the entry, and the field reads
// as the plugin renders it. A block is never mutated in place.
const applyBlock = (entry, op, stamp, delta, rejected, mod, limits, changes) => {
  const { meta } = entry;
  const { key: field, value: payload } = op;
  if (!isPath(field) || !isKey(op.origin) || !isPlainObject(payload)) {
    return void malformed(field, rejected);
  }
  const kind = mod.kindOfOp(op);
  if (kind === null) return void malformed(field, rejected);
  if (roomFor(entry, field, kind, stamp, delta, rejected, limits.plugins) !== null) return;
  if (compareClock(stamp, floorOf(meta, field)) < 0) return;
  const held = own(meta.blocks, field);
  const result = mod.apply(entry, field, held, op, stamp, limits);
  if (result.reason === 'bound') {
    rejected.push({ field, reason: 'bound', detail: result.detail, count: result.count, max: result.max });
  } else if (result.reason === 'malformed') malformed(field, rejected);
  if (!result.changed) return;
  if (result.block === null) {
    if (held !== undefined) {
      dropBlock(entry, field);
      delete entry.data[field];
      delta[field] = undefined;
    }
    return;
  }
  // What the reading shows of the op, as the plugin read it from the block.
  // A field the op makes reads as something even when no change of the
  // plugin's says so (a tree whose only node went to the trash reads `[]`):
  // then it is left to `changesOf`, which reports it whole.
  if (result.change !== undefined && (result.change.length > 0 || held !== undefined)) {
    for (const change of result.change) changes.push({ ...change, field });
    changes.covered.add(field);
  }
  meta.blocks[field] = result.block;
  // Pending work is news to persist even when the field reads the same.
  entry.data[field] = mod.render(entry, field, result.block, result.hint ?? null);
  delta[field] = entry.data[field];
  // A block holds its prefix alone — unless its members carry fields.
  if (!nests(limits.plugins, kind)) dropUnder(entry, field, delta, limits.plugins);
};

// Everything the entry held, gone: the purge, and a merge that meets one.
const erase = (entry, stamp, delta) => {
  const { meta, data } = entry;
  for (const field of Object.keys(data)) delta[field] = undefined;
  entry.data = {};
  meta.clock = {};
  meta.counters = {};
  meta.sets = {};
  meta.blocks = {};
  meta.gone = {};
  // Canonical: whatever came before, a purged entry looks the same, so two
  // nodes that saw the purge and a write in either order hold one meta.
  meta.purged = maxClock(meta.purged ?? null, stamp);
  meta.base = meta.purged;
  meta.deleted = meta.purged;
};

// The op types the core applies itself; every other type of the protocol
// is a plugin's (or, with no plugin for it here, a refusal).
const CORE_TYPES = new Set(['purge', 'set', 'unset', 'write', 'delete', 'merge', 'inc', 'add', 'remove']);

/**
 * Applies one op to an entry (null for a record this node has never seen).
 * Returns `{ entry, changed, delta, rejected }` — a NEW entry, whether it
 * differs, the fields that changed (undefined = removed) and the fields the
 * field-kind rule refused. Idempotent: applying an op twice, or an op older
 * than what the entry already reflects, changes nothing. `limits` is the
 * node's `{ pendingMax, plugins }` (src/plugin.js limitsOf).
 */
const applyOp = (previous, op, limits = null) => {
  const bounds = limitsOf(limits);
  const { plugins } = bounds;
  const entry = previous ? cloneEntry(previous) : createEntry();
  const { meta } = entry;
  const stamp = [op.ts, op.origin];
  const delta = {};
  const rejected = [];
  // What the reading shows of the op, in the write API's terms — a `put`,
  // an `inc`, an `add`, a `splice`… — by the path that applied it; a field
  // changed another way (a reset, a kind outranked, a prefix pruned) reads
  // as a `reset` with its value, or an `unset` (`changesOf`).
  const changes = [];
  changes.covered = new Set();
  const outcome = (changed, whole = false) => {
    if (whole) delete changes.covered;
    else changesOf(entry, delta, changes, plugins);
    // The newest stamp, carried: the source's and this op's (a merge joins
    // another meta's stamps — walked when asked). Only along a line a write
    // path has asked (`latestHeld`): an entry made from nothing, or folded by
    // a reader no one stamps after, would add an entry to the weak map per op
    // for nothing — a fifth of a register write's cost.
    if (op.type !== 'merge' && previous) {
      const known = LATEST.get(previous.meta);
      if (known !== undefined) LATEST.set(meta, Math.max(known, op.ts));
    }
    return { entry, changed, delta, rejected, changes };
  };

  // A purged record takes nothing more — not a newer write, not a revival.
  if (meta.purged && op.type !== 'purge' && op.type !== 'merge') {
    return outcome(false, true);
  }
  if (op.type === 'purge') {
    erase(entry, stamp, delta);
    const before = previous ? previous.meta.purged : undefined;
    const changed = before === undefined || compareClock(meta.purged, before) > 0;
    if (changed) changes.push({ action: 'purge' });
    return outcome(changed, true);
  }

  if (op.type === 'set') {
    if (!isPlainObject(op.data)) malformed(null, rejected);
    else {
      if (!previous && Number.isInteger(op.v)) meta.v = op.v;
      applyFields(entry, op.data, stamp, delta, rejected, plugins, changes);
    }
  } else if (op.type === 'unset') {
    if (!Array.isArray(op.value)) malformed(null, rejected);
    else applyUnset(entry, op.value, stamp, delta, plugins);
  } else if (op.type === 'write') {
    if (!isPlainObject(op.data)) malformed(null, rejected);
    else if (compareClock(stamp, meta.base) > 0) {
      meta.base = stamp;
      // A write above the tombstone is a revival; dropping the stale stamp
      // keeps the metadata identical whichever order the two arrived in.
      if (compareClock(meta.deleted, meta.base) < 0) meta.deleted = null;
      if (Number.isInteger(op.v)) meta.v = op.v;
      applyBase(entry, delta, plugins);
      applyFields(entry, op.data, stamp, delta, rejected, plugins, changes);
    }
  } else if (op.type === 'delete') {
    if (compareClock(stamp, meta.base) > 0) {
      meta.base = stamp;
      meta.deleted = stamp;
      applyBase(entry, delta, plugins);
      changes.push({ action: 'delete' });
      return outcome(true, true);
    }
  } else if (op.type === 'merge') {
    // A whole entry joined in — how a snapshot page becomes log entries a
    // downstream peer can receive. Idempotent and commutative by
    // construction (see mergeEntry). A block of a kind no plugin here knows
    // is left out and reported.
    if (isPlainObject(op.data) && isPlainObject(op.meta)) {
      const joined = mergeEntry(previous, { data: op.data, meta: normalizeMeta(op.meta, bounds, rejected) }, bounds);
      // Only the replicated halves count: a cached entry also carries its
      // block hash and the encrypted flag.
      const same = previous && deepEqual(joined.data, previous.data) && deepEqual(joined.meta, previous.meta);
      if (!same) {
        for (const field of Object.keys(joined.data)) {
          if (!previous || previous.data[field] !== joined.data[field]) delta[field] = joined.data[field];
        }
        if (previous) {
          for (const field of Object.keys(previous.data)) {
            if (!Object.hasOwn(joined.data, field)) delta[field] = undefined;
          }
        }
        const before = previous ? previous.meta : null;
        const moved =
          joined.meta.base !== (before ? before.base : null) ||
          joined.meta.deleted !== (before ? before.deleted : null);
        const gone = isAlive(joined) ? changesOf(joined, delta, changes, plugins) : [{ action: 'delete' }];
        return { entry: joined, changed: true, delta, rejected, moved, changes: gone };
      }
    }
    return outcome(false, true);
  } else if (op.type === 'inc') {
    const { key: field, value } = op;
    if (!isPath(field) || !isKey(op.origin) || !Number.isFinite(value)) {
      malformed(field, rejected);
    } else if (roomFor(entry, field, 'counter', stamp, delta, rejected, plugins) === null) {
      if (compareClock(stamp, floorOf(meta, field)) >= 0) {
        // The slot of the op's stream: its seq is only ever compared with
        // the seqs of that stream.
        const stream = opKey(op);
        const perStream = own(meta.counters, field) ?? (meta.counters[field] = {});
        const known = own(perStream, stream);
        const sum = (known ? known[1] : 0) + value;
        const fresh = !known || known[0] < op.seq;
        if (fresh && !(Math.abs(sum) <= MAX_COUNT)) {
          rejected.push({ field, reason: 'bound', detail: 'counter', count: sum, max: MAX_COUNT });
          if (Object.keys(perStream).length === 0) delete meta.counters[field];
        } else if (fresh) {
          perStream[stream] = [op.seq, sum, op.ts];
          entry.data[field] = counterValue(perStream);
          delta[field] = entry.data[field];
          changes.push({ action: 'inc', field, value });
          changes.covered.add(field);
          // A counter holds its prefix alone.
          dropUnder(entry, field, delta, plugins);
        }
      }
    }
  } else if (op.type === 'add' || op.type === 'remove') {
    applySet(entry, op, stamp, delta, rejected, plugins, changes);
  } else if (!CORE_TYPES.has(op.type) && OP_TYPES.has(op.type)) {
    const mod = own(plugins.byType, op.type);
    if (mod !== undefined) applyBlock(entry, op, stamp, delta, rejected, mod, bounds, changes);
    else {
      const field = typeof op.key === 'string' ? op.key : null;
      rejected.push({ field, reason: 'kind', kind: HOME[op.type] ?? op.type });
    }
  }

  const before = previous ? previous.meta : null;
  const changed =
    Object.keys(delta).length > 0 ||
    meta.base !== (before ? before.base : null) ||
    meta.deleted !== (before ? before.deleted : null);
  return outcome(changed);
};

// The changes of an op, completed from its delta: a field the op's own path
// did not report — reset by a whole-record write, outranked by another
// kind, pruned under a prefix, joined from a snapshot — reads as a `reset`
// with its value (a copy), or an `unset` when it went.
const changesOf = (entry, delta, changes, plugins) => {
  for (const field of Object.keys(delta)) {
    if (changes.covered.has(field)) continue;
    if (delta[field] === undefined) changes.push({ action: 'unset', field });
    else changes.push({ action: 'reset', field, kind: kindOf(entry, field, plugins), value: asJson(delta[field]) });
  }
  delete changes.covered;
  return changes;
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
    const perStream = meta.counters[field];
    for (const stream of Object.keys(perStream)) {
      if (compareClock(slotStamp(stream, perStream[stream]), meta.deleted) > 0) return true;
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
  // A block touched after the tombstone revives the record too.
  const blocks = blocksOf(meta);
  for (const field of Object.keys(blocks)) if (compareClock([blocks[field].ts, ''], meta.deleted) > 0) return true;
  return false;
};

/**
 * Joins two entries for the same record — the snapshot merge. Commutative,
 * associative and idempotent, and equal to applying both histories in any
 * interleaving (up to the documented counter/reset straddle). Both entries
 * are expected in this module's shape: a peer's goes through normalizeMeta
 * first (applyOp does that for a `merge` op). `limits` names the plugins
 * whose blocks join.
 */
const mergeEntry = (a, b, limits = null) => {
  const bounds = limitsOf(limits);
  const { plugins } = bounds;
  // A side alone is joined with nothing rather than copied: its data is read
  // again from its meta, so a field the meta does not back (a slot or a block
  // normalizeMeta refused, a value with no stamp) does not come with it.
  if (!a) return b ? mergeEntry(createEntry(), b, bounds) : null;
  if (!b) return cloneEntry(a);
  const entry = createEntry();
  const { meta, data } = entry;
  meta.base = maxClock(a.meta.base, b.meta.base);
  meta.deleted = maxClock(a.meta.deleted, b.meta.deleted);
  if (compareClock(meta.deleted, meta.base) < 0) meta.deleted = null;
  for (const source of [a, b]) {
    const gone = goneOf(source.meta);
    for (const field of Object.keys(gone)) {
      if (isKey(field)) meta.gone[field] = maxClock(own(meta.gone, field) ?? null, gone[field]);
    }
  }
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
        data[field] = own(source.data, field);
      }
    }
    for (const field of Object.keys(source.meta.counters)) {
      if (!isKey(field)) continue;
      const perStream = own(meta.counters, field) ?? (meta.counters[field] = {});
      const from = source.meta.counters[field];
      for (const stream of Object.keys(from)) {
        const held = own(perStream, stream);
        if (isKey(stream) && (!held || held[0] < from[stream][0])) perStream[stream] = from[stream];
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
    // Two blocks of one kind join by the plugin's rule; of two kinds, the
    // one of lower rank wins (a list outranks a text).
    const blocks = blocksOf(source.meta);
    for (const field of Object.keys(blocks)) {
      if (!isKey(field)) continue;
      const theirs = blocks[field];
      const mine = own(meta.blocks, field);
      if (mine === undefined) meta.blocks[field] = theirs;
      else if (mine.k === theirs.k) {
        const mod = moduleOf(plugins, mine);
        meta.blocks[field] = mod === undefined ? mine : mod.join(mine, theirs);
      } else if (rankOf(plugins, kindOfBlock(plugins, theirs)) < rankOf(plugins, kindOfBlock(plugins, mine))) {
        meta.blocks[field] = theirs;
      }
    }
  }
  applyBase(entry, {}, plugins);
  // A register that also became a counter on the other side: the register
  // wins, by the kinds' precedence (the writes already happened).
  for (const field of Object.keys(meta.counters)) {
    if (own(meta.clock, field) !== undefined) {
      delete meta.counters[field];
      data[field] = a.meta.clock[field] === meta.clock[field] ? own(a.data, field) : own(b.data, field);
    }
  }
  // A set that is a register or a counter on the other side: the register,
  // then the counter, wins — the precedence the writes were refused by.
  for (const field of Object.keys(meta.sets)) {
    if (own(meta.clock, field) !== undefined) {
      delete meta.sets[field];
      data[field] = a.meta.clock[field] === meta.clock[field] ? own(a.data, field) : own(b.data, field);
    } else if (isCounter(meta, field)) {
      delete meta.sets[field];
      data[field] = counterValue(meta.counters[field]);
    }
  }
  // A block that is a register, a counter or a set on the other side: those
  // win, in that order — every kind of the core outranks every plugin's.
  for (const field of Object.keys(meta.blocks)) {
    if (own(meta.clock, field) !== undefined) {
      dropBlock(entry, field);
      data[field] = a.meta.clock[field] === meta.clock[field] ? own(a.data, field) : own(b.data, field);
    } else if (isCounter(meta, field)) {
      dropBlock(entry, field);
      data[field] = counterValue(meta.counters[field]);
    } else if (isSet(meta, field)) {
      dropBlock(entry, field);
      data[field] = liveElements(meta.sets[field]);
    }
  }
  // A counter, a set or a block that does not nest holds its prefix alone:
  // what the other side hung under it goes, as it would have on the op path.
  for (const map of [meta.counters, meta.sets]) {
    for (const field of Object.keys(map)) if (own(map, field) !== undefined) dropUnder(entry, field, {}, plugins);
  }
  for (const field of Object.keys(meta.blocks)) {
    if (!nests(plugins, kindOfBlock(plugins, meta.blocks[field]))) dropUnder(entry, field, {}, plugins);
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

// What a field is in an entry, by its meta: register, counter, set, or the
// kind a plugin's block reads as (list, text, tree) — or undefined.
// `kindsOf` names every field of the entry. `plugins` is the registry
// (src/plugin.js; the core's kinds alone when absent).
const kindOf = (entry, field, plugins = null) => {
  const { meta } = entry;
  if (isCounter(meta, field)) return 'counter';
  if (isSet(meta, field)) return 'set';
  const block = own(blocksOf(meta), field);
  if (block !== undefined) return kindOfBlock(plugins ?? NO_PLUGINS, block);
  return own(entry.data, field) !== undefined || own(meta.clock, field) !== undefined ? 'register' : undefined;
};

const kindsOf = (entry, plugins = null) => {
  const kinds = {};
  if (!entry) return kinds;
  const { data } = entry;
  const fields = Object.keys(data);
  for (let i = 0; i < fields.length; i++) kinds[fields[i]] = kindOf(entry, fields[i], plugins);
  const clocked = Object.keys(entry.meta.clock);
  for (let i = 0; i < clocked.length; i++) {
    if (!Object.hasOwn(data, clocked[i])) kinds[clocked[i]] = kindOf(entry, clocked[i], plugins);
  }
  return kinds;
};

module.exports = {
  MAX_COUNT,
  MAX_PATHS,
  createEntry,
  cloneEntry,
  applyOp,
  mergeEntry,
  isAlive,
  isCounter,
  streamOrigin,
  isSet,
  isBlock,
  kindOf,
  kindsOf,
  observedTags,
  latestClock,
  latestHeld,
  settleMeta,
  normalizeMeta,
  deepEqual,
  packOps,
  unpackOps,
};
