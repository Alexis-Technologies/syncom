// RxDB's side of the Errors page's "Coming from RxDB" code group (docs/guide/errors.md), run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
import { createRxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';

const board = await createRxDatabase({ name: 'board', storage: getRxStorageMemory() });
await board.addCollections({
  tasks: {
    schema: {
      version: 0,
      primaryKey: 'id',
      type: 'object',
      properties: { id: { type: 'string', maxLength: 100 }, title: { type: 'string' } },
      required: ['id', 'title'],
    },
  },
});
// #region exists
await board.tasks.insert({ id: 'write-docs', title: 'Write the docs' });
try {
  await board.tasks.insert({ id: 'write-docs', title: 'Write them again' });
} catch (error) {
  console.log(error.rxdb, error.code, error.parameters.id); // true CONFLICT write-docs
}
// #endregion exists
await assert.rejects(board.tasks.insert({ id: 'write-docs', title: 'again' }), (error) => {
  return error.code === 'CONFLICT' && error.parameters.id === 'write-docs';
});
await board.close();
