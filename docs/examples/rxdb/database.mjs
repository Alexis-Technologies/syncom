// RxDB's side of the Database page's "Coming from RxDB" code group (docs/guide/database.md), run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
// #region open
import { createRxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';

const board = await createRxDatabase({
  name: 'board',
  storage: getRxStorageMemory(),
  multiInstance: false, // one instance per name; true shares it between tabs
});
await board.addCollections({
  tasks: {
    schema: {
      version: 0,
      primaryKey: 'id',
      type: 'object',
      properties: { id: { type: 'string', maxLength: 100 }, title: { type: 'string' }, done: { type: 'boolean' } },
      required: ['id', 'title', 'done'],
      indexes: ['done'],
    },
  },
});
await board.tasks.insert({ id: crypto.randomUUID(), title: 'Write the docs', done: false });
await board.close();
// #endregion open
assert.equal(board.closed, true);
