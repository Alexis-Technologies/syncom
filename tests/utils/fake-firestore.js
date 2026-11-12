'use strict';

// Firestore in memory, in the shape of the modular SDK the adapter calls: a
// collection of documents stamped by the server at commit, `query` over
// `orderBy`/`startAfter`/`limit`, `getDocs`, `doc`, `runTransaction` (its own
// `get`/`set`; run again when a document it read moved before it committed),
// `serverTimestamp` as a sentinel, `onSnapshot` over a query, `Timestamp`.

const SERVER = Symbol('serverTimestamp');

// As the SDK's: whole seconds and the nanoseconds within them; the server stamps with microseconds, which
// `toMillis()` rounds — a cursor made of milliseconds skips or repeats the rest of a commit's documents.
class Timestamp {
  constructor(seconds, nanoseconds) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
  }
  static fromMillis(ms) {
    const seconds = Math.floor(ms / 1000);
    return new Timestamp(seconds, Math.round((ms - seconds * 1000) * 1e6));
  }
  static fromMicros(us) {
    const seconds = Math.floor(us / 1e6);
    return new Timestamp(seconds, (us - seconds * 1e6) * 1000);
  }
  toMillis() {
    return this.seconds * 1000 + Math.round(this.nanoseconds / 1e6);
  }
}

// A copy that keeps Timestamps as they are.
const copy = (value) => {
  if (value instanceof Timestamp || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(copy);
  const out = {};
  for (const key of Object.keys(value)) out[key] = copy(value[key]);
  return out;
};

// A value's place in Firestore's order: the group, then one or two numbers (a Timestamp compares exactly, seconds
// then nanoseconds — never as one float), or a string.
const rank = (value) => {
  if (value === null || value === undefined) return [0, 0, 0];
  if (value instanceof Timestamp) return [1, value.seconds, value.nanoseconds];
  if (typeof value === 'number') return [1, value, 0];
  if (typeof value === 'boolean') return [0, value ? 1 : 0, 0];
  return [2, String(value), 0];
};
const compareValues = (a, b) => {
  const [ra, va, na] = rank(a);
  const [rb, vb, nb] = rank(b);
  if (ra !== rb) return ra - rb;
  if (va !== vb) return va < vb ? -1 : 1;
  return na < nb ? -1 : na > nb ? 1 : 0;
};

const createFakeFirestore = ({ stampField = 'serverTimestamp', deletedField = '_deleted' } = {}) => {
  const docs = new Map();
  const versions = new Map();
  const listeners = new Set();
  // The server's clock in microseconds: several commits within one millisecond carry distinct stamps, as on the
  // server.
  let last = 0;
  const tick = () => {
    last = Math.max(Date.now() * 1000, last + 1);
    return last;
  };
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const commit = (id, data) => {
    const stamped = copy(data);
    for (const key of Object.keys(stamped)) if (stamped[key] === SERVER) stamped[key] = Timestamp.fromMicros(tick());
    docs.set(id, stamped);
    versions.set(id, (versions.get(id) ?? 0) + 1);
  };
  const snapOf = (id) => {
    const data = docs.get(id);
    return {
      id,
      exists: () => data !== undefined,
      data: () => (data === undefined ? undefined : copy(data)),
      get: (field) => (data === undefined ? undefined : copy(data[field])),
    };
  };
  const valueOf = (id, data, field) => (field === '__name__' ? id : data[field]);
  // A query run: the collection ordered, cut after the cursor, limited.
  const run = (q) => {
    const orders = q.constraints.filter((c) => c.type === 'orderBy');
    const after = q.constraints.find((c) => c.type === 'startAfter');
    const limit = q.constraints.find((c) => c.type === 'limit');
    const compare = (a, b) => {
      for (const { field, dir } of orders) {
        const result = compareValues(valueOf(a[0], a[1], field), valueOf(b[0], b[1], field));
        if (result !== 0) return dir === 'desc' ? -result : result;
      }
      return 0;
    };
    let rows = [...docs.entries()].sort(compare);
    if (after) {
      rows = rows.filter((row) => {
        for (let i = 0; i < orders.length && i < after.values.length; i++) {
          const result = compareValues(valueOf(row[0], row[1], orders[i].field), after.values[i]);
          if (result !== 0) return orders[i].dir === 'desc' ? result < 0 : result > 0;
        }
        return false;
      });
    }
    if (limit) rows = rows.slice(0, limit.n);
    return rows.map(([id]) => snapOf(id));
  };

  const collection = { kind: 'collection' };
  const database = { kind: 'database' };
  const fake = {
    docs,
    collection,
    database,
    attempts: 0,
    pendingWaits: 0,
    /** Called once between a transaction's reads and its commit: what another client does meanwhile. */
    race: null,
    sdk: {
      Timestamp,
      query: (ref, ...constraints) => ({
        ref: ref.ref ?? ref,
        constraints: [...(ref.constraints ?? []), ...constraints],
      }),
      orderBy: (field, dir = 'asc') => ({ type: 'orderBy', field, dir }),
      limit: (n) => ({ type: 'limit', n }),
      startAfter: (...values) => ({ type: 'startAfter', values }),
      documentId: () => '__name__',
      doc: (ref, id) => {
        // An id Firestore refuses: a path separator, or the reserved `__name__` form.
        if (id.includes('/') || /^__.*__$/.test(id)) {
          const error = new Error(
            `Invalid document reference. Document references must have an even number of segments, or ${id} is reserved`,
          );
          error.code = 'invalid-argument';
          throw error;
        }
        return { type: 'doc', id };
      },
      serverTimestamp: () => SERVER,
      getDocs: async (q) => ({ docs: run(q), metadata: { hasPendingWrites: false } }),
      waitForPendingWrites: async () => {
        fake.pendingWaits++;
      },
      async runTransaction(db, fn) {
        for (let attempt = 0; attempt < 5; attempt++) {
          fake.attempts++;
          const read = new Map();
          const writes = [];
          const tx = {
            async get(ref) {
              read.set(ref.id, versions.get(ref.id) ?? 0);
              return snapOf(ref.id);
            },
            set(ref, data) {
              writes.push([ref.id, data]);
            },
          };
          await fn(tx);
          if (fake.race !== null) {
            const race = fake.race;
            fake.race = null;
            race();
          }
          let moved = false;
          for (const [id, version] of read) if ((versions.get(id) ?? 0) !== version) moved = true;
          if (moved) continue;
          for (const [id, data] of writes) commit(id, data);
          if (writes.length > 0) notify();
          return;
        }
        throw new Error('fake-firestore: transaction contended too often');
      },
      onSnapshot(q, next, error = null) {
        const listener = () => next({ docs: run(q), metadata: { hasPendingWrites: false } });
        listener.error = error;
        listeners.add(listener);
        queueMicrotask(listener);
        return () => listeners.delete(listener);
      },
    },
    /** Every listener told of an error (the SDK's listener erring: permissions, a dropped socket). */
    failStreams(error = new Error('fake-firestore: listener failed')) {
      for (const listener of [...listeners]) listener.error?.(error);
    },
    /** A write made on the collection itself (another client's), stamped by the server. */
    write(id, data, { deleted = false, pending = false } = {}) {
      const doc = deleted ? {} : copy(data);
      doc[deletedField] = deleted;
      doc[stampField] = pending ? null : SERVER;
      commit(id, doc);
      notify();
    },
    read(id) {
      const doc = docs.get(id);
      if (doc === undefined || doc[deletedField] === true) return null;
      const out = {};
      for (const key of Object.keys(doc)) if (key !== stampField && key !== deletedField) out[key] = copy(doc[key]);
      return out;
    },
  };
  return fake;
};

module.exports = { createFakeFirestore, Timestamp };
