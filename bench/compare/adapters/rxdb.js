'use strict';

/**
 * RxDB 17, the open-source core: a collection with a JSON Schema, `insert`,
 * `findOne(id).exec()` then `toJSON()`, `incrementalPatch` for an update,
 * `bulkInsert` for a batch. No dev-mode and no validation plugin — how the
 * documentation says to run in production. A document is last-writer-wins
 * with a conflict handler, so the counter scenario leaves it out. A replica
 * pulls through `replicateRxCollection`, RxDB's replication protocol, with
 * a pull handler that reads the source's changes the way RxDB's server
 * plugins do (`getChangedDocumentsSince`).
 *
 * Only in memory: every RxDB storage that writes to disk in Node.js
 * (filesystem-node, SQLite) is a Premium plugin.
 */

const { createRequire } = require('node:module');

const local = createRequire(require.resolve('../package.json'));
const load = (name) => import(local.resolve(name));

const SCHEMA = {
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 32 },
    title: { type: 'string' },
    done: { type: 'boolean' },
    priority: { type: 'number' },
    owner: { type: 'string' },
    hits: { type: 'number' },
  },
  required: ['id', 'title', 'done', 'priority', 'owner', 'hits'],
};

let names = 0;

const open = async () => {
  const { createRxDatabase } = await load('rxdb');
  const { getRxStorageMemory } = await load('rxdb/plugins/storage-memory');
  const db = await createRxDatabase({ name: `todos${++names}`, storage: getRxStorageMemory() });
  await db.addCollections({ todos: { schema: SCHEMA } });
  const todos = db.todos;
  let next = 0;
  return {
    db,
    todos,
    insert: async (record) => {
      const id = `t${next++}`;
      await todos.insert({ id, ...record });
      return id;
    },
    get: async (id) => (await todos.findOne(id).exec())?.toJSON() ?? null,
    update: async (id, patch) => {
      const doc = await todos.findOne(id).exec();
      await doc.incrementalPatch(patch);
    },
    bulk: async (records) => {
      const docs = records.map((record) => ({ id: `t${next++}`, ...record }));
      const { error } = await todos.bulkInsert(docs);
      if (error.length) throw new Error(`bulkInsert: ${error.length} errors`);
      return docs.map((doc) => doc.id);
    },
    close: () => db.close(),
  };
};

let replications = 0;

const replicate = async (source, replica) => {
  const { getChangedDocumentsSince } = await load('rxdb');
  const { replicateRxCollection } = await load('rxdb/plugins/replication');
  const state = replicateRxCollection({
    collection: replica.todos,
    replicationIdentifier: `bench-${++replications}`,
    live: false,
    pull: {
      batchSize: 100,
      handler: async (checkpoint, batchSize) => {
        const changed = await getChangedDocumentsSince(source.todos.storageInstance, batchSize, checkpoint);
        const documents = changed.documents.map(({ _meta, _rev, _attachments, ...doc }) => doc);
        return { documents, checkpoint: changed.checkpoint };
      },
    },
  });
  await state.awaitInitialReplication();
  await state.cancel();
};

module.exports = {
  id: 'rxdb',
  name: 'RxDB',
  package: 'rxdb',
  url: 'https://github.com/pubkey/rxdb',
  unsupported: { disk: 'Node.js disk storages are Premium' },
  lines: {
    memory: { variant: 'memory storage', open, openReplica: open, replicate },
  },
};
