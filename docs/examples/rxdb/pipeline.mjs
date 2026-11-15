// RxDB's side of the "Coming from RxDB" code group of docs/guide/pipeline.md, run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
import { createRxDatabase, addRxPlugin } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { RxDBPipelinePlugin } from 'rxdb/plugins/pipeline';
import { RxDBLeaderElectionPlugin } from 'rxdb/plugins/leader-election';

addRxPlugin(RxDBPipelinePlugin);
addRxPlugin(RxDBLeaderElectionPlugin);
const board = await createRxDatabase({ name: 'board', storage: getRxStorageMemory() });
const schemaOf = (properties) => ({
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: { id: { type: 'string', maxLength: 100 }, ...properties },
});
await board.addCollections({
  tasks: { schema: schemaOf({ title: { type: 'string' }, done: { type: 'boolean' } }) },
  activities: { schema: schemaOf({ task: { type: 'string' }, title: { type: 'string' } }) },
});

// #region create
const pipeline = await board.tasks.addPipeline({
  identifier: 'activity',
  destination: board.activities, // reads of the destination wait while the handler runs
  handler: async (docs) => {
    for (const doc of docs) {
      const id = `done.${doc.id}`;
      if (doc.done && !doc.deleted) await board.activities.upsert({ id, task: doc.id, title: doc.title });
      else await (await board.activities.findOne(id).exec())?.remove();
    }
  },
});
// #endregion create
await board.tasks.insert({ id: 'docs', title: 'Write the docs', done: true });
await pipeline.awaitIdle();
assert.equal((await board.activities.find().exec()).length, 1);
await board.close();
