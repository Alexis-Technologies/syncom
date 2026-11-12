'use strict';

// Appwrite in memory, in the shape of the SDK the adapter calls: a `Databases`
// service over one collection (`listDocuments` with the `Query` builder's
// `equal`/`greaterThan`/`orderAsc`/`limit`/`or`/`and`, `createDocument`
// 409 on a duplicate, `updateDocument`/`getDocument` 404 on none), the
// builder itself (JSON strings, as the real one answers) and a client with
// Realtime's `subscribe`.

const clone = (value) => JSON.parse(JSON.stringify(value));

class AppwriteException extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AppwriteException';
    this.code = code;
  }
}

const Query = {
  equal: (attribute, values) =>
    JSON.stringify({ method: 'equal', attribute, values: Array.isArray(values) ? values : [values] }),
  greaterThan: (attribute, value) => JSON.stringify({ method: 'greaterThan', attribute, values: [value] }),
  orderAsc: (attribute) => JSON.stringify({ method: 'orderAsc', attribute }),
  limit: (n) => JSON.stringify({ method: 'limit', values: [n] }),
  or: (queries) => JSON.stringify({ method: 'or', values: queries.map((q) => JSON.parse(q)) }),
  and: (queries) => JSON.stringify({ method: 'and', values: queries.map((q) => JSON.parse(q)) }),
};

const matches = (doc, q) => {
  switch (q.method) {
    case 'equal':
      return q.values.includes(doc[q.attribute]);
    case 'greaterThan':
      return doc[q.attribute] > q.values[0];
    case 'or':
      return q.values.some((inner) => matches(doc, inner));
    case 'and':
      return q.values.every((inner) => matches(doc, inner));
    default:
      return true;
  }
};

const createFakeAppwrite = ({ databaseId = 'db', collectionId = 'tasks' } = {}) => {
  const docs = new Map();
  const listeners = new Set();
  let last = 0;
  const stamp = () => {
    last = Math.max(Date.now(), last + 1);
    return new Date(last).toISOString();
  };
  const notify = (event, doc) => {
    for (const listener of [...listeners]) listener({ events: [event], payload: clone(doc) });
  };
  const check = (db, col) => {
    if (db !== databaseId || col !== collectionId) throw new AppwriteException(404, 'Collection not found');
  };
  const fake = {
    docs,
    Query,
    calls: [],
    /** Called once after a push's read of the documents: what another client does meanwhile. */
    race: null,
    client: {
      subscribe(channels, callback) {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    },
    databases: {
      async listDocuments(db, col, queries = []) {
        check(db, col);
        fake.calls.push('list');
        const parsed = queries.map((q) => JSON.parse(q));
        const filters = parsed.filter((q) => !['orderAsc', 'limit'].includes(q.method));
        const orders = parsed.filter((q) => q.method === 'orderAsc').map((q) => q.attribute);
        const limit = parsed.find((q) => q.method === 'limit')?.values[0] ?? 25;
        let rows = [...docs.values()].filter((doc) => filters.every((q) => matches(doc, q)));
        rows.sort((a, b) => {
          for (const attribute of orders) {
            if (a[attribute] !== b[attribute]) return a[attribute] < b[attribute] ? -1 : 1;
          }
          return 0;
        });
        rows = rows.slice(0, limit);
        if (fake.race !== null) {
          const race = fake.race;
          fake.race = null;
          race();
        }
        return { total: rows.length, documents: rows.map(clone) };
      },
      async createDocument(db, col, id, data) {
        check(db, col);
        fake.calls.push('create');
        // An id Appwrite cannot carry: at most 36 letters, digits, `.`, `-`, `_`, not starting with a special one.
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(id)) {
          throw new AppwriteException(400, 'Invalid `documentId` param: UID must contain at most 36 chars.');
        }
        if (docs.has(id)) throw new AppwriteException(409, 'Document with the requested ID already exists.');
        const doc = { $id: id, $updatedAt: stamp(), ...clone(data) };
        docs.set(id, doc);
        notify('create', doc);
        return clone(doc);
      },
      async updateDocument(db, col, id, data) {
        check(db, col);
        fake.calls.push('update');
        const held = docs.get(id);
        if (held === undefined) throw new AppwriteException(404, 'Document with the requested ID could not be found.');
        const doc = { ...held, ...clone(data), $updatedAt: stamp() };
        docs.set(id, doc);
        notify('update', doc);
        return clone(doc);
      },
      async getDocument(db, col, id) {
        check(db, col);
        const held = docs.get(id);
        if (held === undefined) throw new AppwriteException(404, 'Document with the requested ID could not be found.');
        return clone(held);
      },
    },
    /** A write made on the collection itself (another client's). */
    write(id, data, { deleted = false } = {}) {
      const doc = { $id: id, $updatedAt: stamp(), ...(deleted ? {} : clone(data)), deleted };
      docs.set(id, doc);
      notify(docs.has(id) ? 'update' : 'create', doc);
      return doc;
    },
    /** A document taken away for good (another client's hard delete). */
    remove(id) {
      docs.delete(id);
    },
    read(id) {
      const doc = docs.get(id);
      if (doc === undefined || doc.deleted === true) return null;
      const out = {};
      for (const key of Object.keys(doc)) if (key[0] !== '$' && key !== 'deleted') out[key] = doc[key];
      return out;
    },
  };
  return fake;
};

module.exports = { createFakeAppwrite, AppwriteException };
