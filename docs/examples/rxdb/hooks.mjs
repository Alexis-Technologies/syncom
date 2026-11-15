// RxDB's side of the "Coming from RxDB" code group of docs/guide/hooks.md, run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
// #region before-write
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
        updatedAt: { type: 'number' },
      },
      required: ['id'],
    },
  },
});

// One hook per moment and collection: before an insert, before a save of an existing document.
board.tasks.preInsert((data) => {
  if (typeof data.title !== 'string' || data.title === '') throw new Error('a task needs a title');
  data.updatedAt = Date.now(); // a hook edits the data in place
}, false);
board.tasks.preSave((data) => {
  data.updatedAt = Date.now();
}, false);
// #endregion before-write

const task = await board.tasks.insert({ id: 'write-docs', title: 'Write the docs', done: false });
assert.equal(typeof task.updatedAt, 'number');
await assert.rejects(board.tasks.insert({ id: 'untitled', done: false }), /a task needs a title/);
await board.close();
