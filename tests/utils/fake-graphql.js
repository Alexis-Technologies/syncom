'use strict';

// A GraphQL endpoint in memory behind a `fetch`: documents with a revision
// and a sequence, two operations — `pullTasks(since, limit)` answering the
// documents changed since and the position after them, and `pushTasks(rows)`
// writing each row whose `assumedRev` is the current revision and answering
// the rest as conflicts — plus a `subscribe(listener)` for a stream.

const clone = (value) => JSON.parse(JSON.stringify(value));

const createFakeGraphQL = () => {
  const docs = new Map();
  const changes = [];
  const listeners = new Set();
  const write = (id, data, deleted) => {
    const held = docs.get(id);
    const doc = { id, data: deleted ? null : clone(data), deleted, rev: (held?.rev ?? 0) + 1 };
    docs.set(id, doc);
    changes.push(doc);
    return doc;
  };
  const endpoint = {
    docs,
    changes,
    calls: [],
    write(id, data, { deleted = false } = {}) {
      const doc = write(id, data, deleted);
      for (const listener of listeners) {
        listener({ documents: [clone({ id, data: doc.data, deleted, rev: doc.rev })], checkpoint: changes.length });
      }
      return doc;
    },
    read(id) {
      const doc = docs.get(id);
      return doc === undefined || doc.deleted ? null : clone(doc.data);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async fetch(_url, init) {
      const { query, variables } = JSON.parse(init.body);
      endpoint.calls.push(query.trim().split(/[\s({]/)[1] ?? query);
      const answer = (body) => ({
        ok: true,
        status: 200,
        json: async () => clone(body),
        text: async () => JSON.stringify(body),
      });
      if (query.includes('pullTasks')) {
        const since = variables.since ?? 0;
        const page = changes.slice(since, since + variables.limit);
        const documents = page.map((doc) => ({ id: doc.id, data: doc.data, deleted: doc.deleted, rev: doc.rev }));
        return answer({ data: { pullTasks: { documents, checkpoint: since + page.length } } });
      }
      if (query.includes('pushTasks')) {
        const conflicts = [];
        const written = [];
        for (const row of variables.rows) {
          const held = docs.get(row.id);
          if ((held?.rev ?? null) !== (row.assumedRev ?? null)) {
            conflicts.push(
              held === undefined
                ? { id: row.id, data: null, deleted: true, rev: null }
                : { id: held.id, data: held.data, deleted: held.deleted, rev: held.rev },
            );
            continue;
          }
          const doc = write(row.id, row.data, row.deleted === true);
          written.push({ id: doc.id, rev: doc.rev });
        }
        return answer({ data: { pushTasks: { conflicts, written } } });
      }
      return answer({ errors: [{ message: `Unknown operation: ${query.slice(0, 40)}` }] });
    },
  };
  return endpoint;
};

module.exports = { createFakeGraphQL };
