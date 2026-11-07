'use strict';

// A backend for the connector tests: documents by id with a revision each, a
// change feed by sequence, compare-and-set on write (a row whose `assumed`
// is not what the backend holds is a conflict; a row that assumes nothing
// known — `assumed` undefined, a probe — is answered as the backend holds it
// and nothing is written), a row refused by name (`refuse(id, error)` →
// `{ id, error }`), and a stream of changes — what a CouchDB, a REST endpoint
// or a table with a `modified` column do, in memory. `handlers()` is the pair
// `replicate()` takes.

const { canonical } = require('../../src/connector/same.js');

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
// The same reading whatever the order of the keys: a compare-and-set judges the data, not its text.
const same = (a, b) => canonical(a ?? null) === canonical(b ?? null);

const createFakeBackend = () => {
  const docs = new Map();
  const changes = [];
  const listeners = new Set();
  const failing = { pull: 0, push: 0 };
  const refusing = new Map();
  const backend = {
    docs,
    changes,
    calls: { pull: 0, push: 0 },
    /** The next `count` pulls or pushes fail. */
    fail(direction, count = 1) {
      failing[direction] = count;
    },
    /** A row with this id is refused by name — answered `{ id, error }`, nothing written — until `refuse(id, null)`. */
    refuse(id, error) {
      if (error === null) refusing.delete(id);
      else refusing.set(id, error);
    },
    /** A write made on the backend itself (another client's): told to the streams. */
    write(id, data, { deleted = false } = {}) {
      const doc = backend.set(id, data, { deleted });
      const seq = changes.length;
      for (const emit of listeners) emit({ documents: [clone({ id, data: doc.data, deleted })], checkpoint: seq });
      return doc;
    },
    /** A write made on the backend that no stream tells of (another client's, behind the connector's back). */
    set(id, data, { deleted = false } = {}) {
      const held = docs.get(id);
      const doc = { id, data: deleted ? null : clone(data), deleted, rev: (held?.rev ?? 0) + 1 };
      docs.set(id, doc);
      changes.push(clone(doc));
      return doc;
    },
    read(id) {
      const doc = docs.get(id);
      return doc === undefined || doc.deleted ? null : clone(doc.data);
    },
    handlers() {
      return {
        pull: {
          handler: async (checkpoint, batchSize) => {
            backend.calls.pull++;
            if (failing.pull > 0) {
              failing.pull--;
              throw new Error('backend down (pull)');
            }
            const from = typeof checkpoint === 'number' ? checkpoint : 0;
            const page = changes.slice(from, from + batchSize);
            const documents = [];
            for (const doc of page) documents.push(clone({ id: doc.id, data: doc.data, deleted: doc.deleted }));
            return { documents, checkpoint: from + page.length };
          },
          stream: (emit) => {
            listeners.add(emit);
            return () => listeners.delete(emit);
          },
        },
        push: {
          handler: async (rows) => {
            backend.calls.push++;
            if (failing.push > 0) {
              failing.push--;
              throw new Error('backend down (push)');
            }
            const conflicts = [];
            for (const row of rows) {
              const held = docs.get(row.id);
              const heldData = held === undefined || held.deleted ? null : held.data;
              const refusal = refusing.get(row.id);
              if (refusal !== undefined) {
                conflicts.push({ id: row.id, error: clone(refusal) });
                continue;
              }
              // A probe (`assumed` undefined): "tell me what you hold" — answered as a refusal, nothing written.
              // Compare-and-set otherwise: the row's `assumed` must be what the backend holds.
              if (row.assumed === undefined || !same(heldData, row.assumed)) {
                conflicts.push(clone({ id: row.id, data: heldData, deleted: heldData === null }));
                continue;
              }
              const doc = {
                id: row.id,
                data: row.deleted ? null : clone(row.data),
                deleted: row.deleted,
                rev: (held?.rev ?? 0) + 1,
              };
              docs.set(row.id, doc);
              changes.push(clone(doc));
            }
            return conflicts;
          },
        },
      };
    },
  };
  return backend;
};

module.exports = { createFakeBackend };
