// RxDB's side of the "Coming from RxDB" code group of docs/guide/migration-storage.md, run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
import { createRxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';

const tasks = {
  schema: {
    version: 0,
    primaryKey: 'id',
    type: 'object',
    properties: { id: { type: 'string', maxLength: 100 }, title: { type: 'string' } },
  },
};
const oldStorage = getRxStorageMemory();
const before = await createRxDatabase({ name: 'board', storage: oldStorage });
await before.addCollections({ tasks });
await before.tasks.insert({ id: 'move', title: 'Move the data' });
await before.close();

// #region copy
import { migrateStorage } from 'rxdb/plugins/migration-storage';

// a new database under a new name, on the new storage, with the same collections
const board = await createRxDatabase({ name: 'board-v2', storage: getRxStorageMemory() });
await board.addCollections({ tasks });
await migrateStorage({
  database: board,
  oldDatabaseName: 'board',
  oldStorage, // the documents are read from here and written into `board`
});
// #endregion copy
assert.equal((await board.tasks.findOne('move').exec()).title, 'Move the data');
await board.close();
