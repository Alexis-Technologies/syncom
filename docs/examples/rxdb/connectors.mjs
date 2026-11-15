// RxDB's side of the Connectors page's "Coming from RxDB" code group (docs/guide/connectors.md), run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';

const canonical = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
};
// What the server compares: the document's fields and its deletion flag, not RxDB's own metadata.
const fieldsOf = (doc) => {
  if (!doc) return null;
  const { _meta, _rev, _attachments, ...rest } = doc;
  return rest;
};

// A stand-in for the backend's API, in memory: documents in RxDB's shape (the primary key and `_deleted` inside), a
// change feed and a compare-and-set bulk write that answers the conflicts.
const createApi = () => {
  const docs = new Map();
  let seq = 0;
  const put = (doc) => docs.set(doc.id, { doc: structuredClone(doc), seq: ++seq });
  return {
    async changes({ since, limit }) {
      const rows = [...docs.values()].filter((row) => row.seq > since).sort((a, b) => a.seq - b.seq);
      const page = rows.slice(0, limit);
      return { rows: page.map((row) => structuredClone(row.doc)), last: page.length > 0 ? page.at(-1).seq : since };
    },
    async bulk(rows) {
      const conflicts = [];
      for (const { assumedMasterState, newDocumentState } of rows) {
        const held = docs.get(newDocumentState.id)?.doc ?? null;
        if (canonical(fieldsOf(held)) !== canonical(fieldsOf(assumedMasterState))) {
          conflicts.push(structuredClone(held));
          continue;
        }
        put(fieldsOf(newDocumentState));
      }
      return conflicts;
    },
    write: (doc) => put(doc),
    read: (id) => docs.get(id)?.doc ?? null,
  };
};

const api = createApi();
api.write({ id: 't1', title: 'Plan the sprint', done: false, _deleted: false });

// #region replicate
import { createRxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { replicateRxCollection } from 'rxdb/plugins/replication';

const board = await createRxDatabase({ name: 'board', storage: getRxStorageMemory() });
await board.addCollections({
  tasks: {
    schema: {
      version: 0,
      primaryKey: 'id',
      type: 'object',
      properties: { id: { type: 'string', maxLength: 100 }, title: { type: 'string' }, done: { type: 'boolean' } },
      required: ['id'],
    },
  },
});

const replication = replicateRxCollection({
  replicationIdentifier: 'tasks-api',
  collection: board.tasks,
  pull: {
    // Documents carry their primary key and `_deleted`; the checkpoint is yours to shape.
    async handler(checkpoint, batchSize) {
      const page = await api.changes({ since: checkpoint?.seq ?? 0, limit: batchSize });
      return { documents: page.rows, checkpoint: { seq: page.last } };
    },
  },
  push: {
    // Each row is { assumedMasterState, newDocumentState }; answer the conflicts as the server holds them.
    async handler(rows) {
      return api.bulk(rows);
    },
  },
});
await replication.awaitInitialReplication();
// #endregion replicate

assert.equal((await board.tasks.findOne('t1').exec()).title, 'Plan the sprint');
await board.tasks.insert({ id: 't2', title: 'Write the docs', done: false });
await replication.awaitInSync();
assert.equal(api.read('t2').title, 'Write the docs');
await replication.cancel();
await board.close();
