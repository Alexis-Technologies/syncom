// RxDB's side of the "Coming from RxDB" code group of docs/guide/testing.md, run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
// #region memory
import { test } from 'node:test';
import { createRxDatabase, randomToken } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';

test('a task can be closed', async () => {
  const board = await createRxDatabase({ name: randomToken(10), storage: getRxStorageMemory() });
  await board.addCollections({
    tasks: {
      schema: {
        version: 0,
        primaryKey: 'id',
        type: 'object',
        properties: { id: { type: 'string', maxLength: 100 }, title: { type: 'string' }, done: { type: 'boolean' } },
      },
    },
  });
  const task = await board.tasks.insert({ id: 'docs', title: 'Write the docs', done: false });
  await task.patch({ done: true });
  assert.equal((await board.tasks.findOne('docs').exec()).done, true);
  await board.close();
});
// #endregion memory
