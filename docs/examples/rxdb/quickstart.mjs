// RxDB's side of the Quickstart's "Coming from RxDB" code group (docs/guide/quickstart.md), run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
// #region collection
import { createRxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';

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
        done: { type: 'boolean' },
      },
      required: ['id', 'title', 'done'],
    },
  },
});
// #endregion collection

// #region insert
await board.tasks.insert({ id: 'write-docs', title: 'Write the docs', done: false });
const open = await board.tasks.find({ selector: { done: false } }).exec();
// #endregion insert
assert.equal(open.length, 1);
await board.close();
