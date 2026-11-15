// RxDB's side of the "Coming from RxDB" code group of docs/guide/crdt.md, run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
import { createRxDatabase, addRxPlugin } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { getCRDTSchemaPart, RxDBcrdtPlugin } from 'rxdb/plugins/crdt';

addRxPlugin(RxDBcrdtPlugin);

const board = await createRxDatabase({ name: 'board', storage: getRxStorageMemory() });
await board.addCollections({
  tasks: {
    schema: {
      version: 0,
      primaryKey: 'id',
      type: 'object',
      properties: {
        id: { type: 'string', maxLength: 100 },
        title: { type: 'string' },
        votes: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
        crdts: getCRDTSchemaPart(), // where the plugin keeps the operations
      },
      required: ['id'],
      crdt: { field: 'crdts' }, // the collection opts in
    },
  },
});
const task = await board.tasks.insertCRDT({
  ifMatch: { $set: { id: 'write-docs', title: 'Write the docs', votes: 0, tags: [] } },
});

// #region laptop
// Every change goes through updateCRDT(), as update operators the plugin can replay in order.
await task.updateCRDT({
  ifMatch: {
    $set: { title: 'Write the guide' },
    $inc: { votes: 1 },
    $addToSet: { tags: 'docs' },
  },
});
// #endregion laptop

const latest = task.getLatest();
assert.equal(latest.title, 'Write the guide');
assert.equal(latest.votes, 1);
assert.deepEqual(latest.tags, ['docs']);
await board.close();
