// RxDB's side of the Plugins page's "Coming from RxDB" code group (docs/guide/plugins.md), run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
import { createRxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';

// #region own-methods
import { addRxPlugin } from 'rxdb';

addRxPlugin({
  name: 'archive',
  rxdb: true,
  prototypes: {
    // Every RxDocument of every database in this process gets the method
    RxDocument: (proto) => {
      proto.archive = function () {
        return this.incrementalPatch({ archived: true, archivedAt: Date.now() });
      };
    },
  },
});

const tasks = await createRxDatabase({ name: 'tasks', storage: getRxStorageMemory() });
await tasks.addCollections({
  tasks: {
    schema: {
      version: 0,
      primaryKey: 'id',
      type: 'object',
      properties: {
        id: { type: 'string', maxLength: 100 },
        title: { type: 'string' },
        archived: { type: 'boolean' },
        archivedAt: { type: 'number' },
      },
      required: ['id', 'title'],
    },
  },
});
const task = await tasks.tasks.insert({ id: 'old-task', title: 'Old task' });
await task.archive();
// #endregion own-methods
const stored = await tasks.tasks.findOne('old-task').exec();
assert.equal(stored.archived, true);
await tasks.close();
