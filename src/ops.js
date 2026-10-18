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
// A field is a REGISTER or a COUNTER, never both: `set`/`write` on a counter
// field and `inc` on a register field are refused (reported in `rejected`) —
// the two kinds cannot be made to commute, and refusing is honest where
// guessing would silently diverge.

const { compareClock, maxClock } = require('./vector.js');

const createEntry = () => ({ data: {}, meta: { clock: {}, base: null, deleted: null, counters: {} } });

const cloneEntry = (entry) => {
  const counters = {};
  for (const field in entry.meta.counters) counters[field] = { ...entry.meta.counters[field] };
  const meta = { clock: { ...entry.meta.clock }, base: entry.meta.base, deleted: entry.meta.deleted, counters };
  if (entry.meta.v !== undefined) meta.v = entry.meta.v;
  if (entry.meta.purged !== undefined) meta.purged = entry.meta.purged;
  return { data: { ...entry.data }, meta };
};

const counterValue = (perOrigin) => {
  let sum = 0;
  for (const origin in perOrigin) sum += perOrigin[origin][1];
  return sum;
};

const isCounter = (meta, field) => {
  const perOrigin = meta.counters[field];
  return Boolean(perOrigin) && Object.keys(perOrigin).length > 0;
};

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// Structural equality over JSON-shaped values, key order ignored — what a
// `merge` op needs to tell "already have this" from "news".
const deepEqual = (a, b) => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.hasOwn(b, key) || !deepEqual(a[key], b[key])) return false;
  }
  return true;
};

// A peer-supplied meta, coerced to the shape the rest of this module trusts.
const normalizeMeta = (meta) => {
  const normalized = {
    clock: isPlainObject(meta.clock) ? { ...meta.clock } : {},
    base: Array.isArray(meta.base) ? meta.base : null,
    deleted: Array.isArray(meta.deleted) ? meta.deleted : null,
    counters: isPlainObject(meta.counters) ? meta.counters : {},
  };
  if (Number.isInteger(meta.v)) normalized.v = meta.v;
  if (Array.isArray(meta.purged)) normalized.purged = meta.purged;
  return normalized;
};

// The newest stamp an entry's metadata holds, over registers, the reset
// watermark, the tombstone and the counters — what a node must have observed
// before it stamps a write to that record, or the write sorts below state the
// node already has and is dropped as stale. Takes raw peer-shaped meta too.
const latestClock = (meta) => {
  if (!isPlainObject(meta)) return null;
  const { clock, base, deleted, counters, purged } = normalizeMeta(meta);
  let latest = maxClock(maxClock(base, deleted), purged ?? null);
  for (const field in clock) {
    if (Array.isArray(clock[field])) latest = maxClock(latest, clock[field]);
  }
  for (const field in counters) {
    const perOrigin = counters[field];
    if (!isPlainObject(perOrigin)) continue;
    for (const origin in perOrigin) {
      const ts = Array.isArray(perOrigin[origin]) ? perOrigin[origin][2] : undefined;
      if (typeof ts === 'number') latest = maxClock(latest, [ts, origin]);
    }
  }
  return latest;
};

// Drops every register and counter entry that fell below the (new) base.
const applyBase = (entry, delta) => {
  const { meta, data } = entry;
  for (const field in meta.clock) {
    if (compareClock(meta.clock[field], meta.base) < 0) {
      delete meta.clock[field];
      delete data[field];
      delta[field] = undefined;
    }
  }
  for (const field in meta.counters) {
    const perOrigin = meta.counters[field];
    for (const origin in perOrigin) {
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
};

// Sets register fields at `stamp`, honouring last-writer-wins per field.
const applyFields = (entry, fields, stamp, delta, rejected) => {
  const { meta, data } = entry;
  // Own keys only: `fields` may be a JSON-parsed peer payload, where
  // "__proto__" is an ordinary own key, or an in-process object with a
  // prototype chain nothing here should walk.
  for (const field of Object.keys(fields)) {
    if (field === '__proto__') continue;
    if (isCounter(meta, field)) {
      rejected.push({ field, reason: 'counter' });
      continue;
    }
    if (compareClock(meta.clock[field], stamp) >= 0) continue;
    if (compareClock(stamp, meta.base) < 0) continue;
    meta.clock[field] = stamp;
    data[field] = fields[field];
    delta[field] = fields[field];
  }
};

/**
 * Applies one op to an entry (null for a record this node has never seen).
 * Returns `{ entry, changed, delta, rejected }` — a NEW entry, whether it
 * differs, the fields that changed (undefined = removed) and the fields the
 * register/counter rule refused. Idempotent: applying an op twice, or an op
 * older than what the entry already reflects, changes nothing.
 */
// Everything the entry held, gone: the purge, and a merge that meets one.
const erase = (entry, stamp, delta) => {
  const { meta, data } = entry;
  for (const field of Object.keys(data)) delta[field] = undefined;
  entry.data = {};
  meta.clock = {};
  meta.counters = {};
  // Canonical: whatever came before, a purged entry looks the same, so two
  // nodes that saw the purge and a write in either order hold one meta.
  meta.purged = maxClock(meta.purged ?? null, stamp);
  meta.base = meta.purged;
  meta.deleted = meta.purged;
};

const applyOp = (previous, op) => {
  const entry = previous ? cloneEntry(previous) : createEntry();
  const { meta } = entry;
  const stamp = [op.ts, op.origin];
  const delta = {};
  const rejected = [];

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
    if (typeof field === 'string' && field !== '__proto__' && Number.isFinite(value)) {
      if (meta.clock[field] !== undefined) {
        rejected.push({ field, reason: 'register' });
      } else if (compareClock(stamp, meta.base) >= 0) {
        const perOrigin = (meta.counters[field] ??= {});
        const known = perOrigin[op.origin];
        if (!known || known[0] < op.seq) {
          perOrigin[op.origin] = [op.seq, (known ? known[1] : 0) + value, op.ts];
          entry.data[field] = counterValue(perOrigin);
          delta[field] = entry.data[field];
        }
      }
    }
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
  for (const field in meta.clock) {
    if (compareClock(meta.clock[field], meta.deleted) > 0) return true;
  }
  for (const field in meta.counters) {
    const perOrigin = meta.counters[field];
    for (const origin in perOrigin) {
      if (compareClock([perOrigin[origin][2], origin], meta.deleted) > 0) return true;
    }
  }
  return false;
};

/**
 * Joins two entries for the same record — the snapshot merge. Commutative,
 * associative and idempotent, and equal to applying both histories in any
 * interleaving (up to the documented counter/reset straddle).
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
    for (const field in source.meta.clock) {
      if (compareClock(source.meta.clock[field], meta.clock[field]) > 0) {
        meta.clock[field] = source.meta.clock[field];
        data[field] = source.data[field];
      }
    }
    for (const field in source.meta.counters) {
      const perOrigin = (meta.counters[field] ??= {});
      const from = source.meta.counters[field];
      for (const origin in from) {
        if (!perOrigin[origin] || perOrigin[origin][0] < from[origin][0]) perOrigin[origin] = from[origin];
      }
    }
  }
  applyBase(entry, {});
  // A register that also became a counter on the other side: the register
  // wins (the rule is refuse-on-write, and the writes already happened).
  for (const field in meta.counters) {
    if (meta.clock[field] !== undefined) {
      delete meta.counters[field];
      data[field] = a.meta.clock[field] === meta.clock[field] ? a.data[field] : b.data[field];
    }
  }
  return entry;
};

// The wire/log shape of a batch: one positional array per op, type as a
// single letter, absent fields as null — no key names repeated per op. A
// slot may be appended (the writer's schema version was the 13th, the actor
// the 14th): a reader of an older shape ignores slots it does not know, a
// reader of a newer one takes an absent slot as null.
const TYPE_CODES = { write: 'w', set: 's', inc: 'i', delete: 'd', merge: 'm', advance: 'a', purge: 'p' };
const CODE_TYPES = { w: 'write', s: 'set', i: 'inc', d: 'delete', m: 'merge', a: 'advance', p: 'purge' };

const packOps = (ops) => {
  const packed = new Array(ops.length);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    packed[i] = [
      op.origin,
      op.seq,
      op.ts,
      TYPE_CODES[op.type] ?? op.type,
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
    ];
  }
  return packed;
};

const unpackOps = (packed) => {
  if (!Array.isArray(packed)) return [];
  const ops = [];
  for (const row of packed) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [origin, seq, ts, code, id, scope, data, meta, key, value, vector, from, v, actor] = row;
    const op = { origin, seq, ts, type: CODE_TYPES[code] ?? code };
    if (id !== null && id !== undefined) op.id = id;
    if (v !== null && v !== undefined) op.v = v;
    if (actor !== null && actor !== undefined) op.actor = actor;
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

module.exports = {
  createEntry,
  cloneEntry,
  applyOp,
  mergeEntry,
  isAlive,
  isCounter,
  latestClock,
  deepEqual,
  packOps,
  unpackOps,
};
