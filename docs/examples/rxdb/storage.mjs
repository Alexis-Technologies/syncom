// RxDB's side of the Storage overview's "Coming from RxDB" code group (docs/guide/storage.md), run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
// #region pick
import { createRxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { getRxStorageSQLiteTrial, getSQLiteBasicsNodeNative } from 'rxdb/plugins/storage-sqlite';
import { DatabaseSync } from 'node:sqlite';

// The storage is a required option: here, plain objects in memory.
const inMemory = await createRxDatabase({ name: 'board', storage: getRxStorageMemory() });
// The same database in SQLite, through the free trial storage and an adapter for node:sqlite.
const inSqlite = await createRxDatabase({
  name: 'board',
  storage: getRxStorageSQLiteTrial({ sqliteBasics: getSQLiteBasicsNodeNative(DatabaseSync) }),
});
// #endregion pick

const schema = {
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 100 },
    title: { type: 'string' },
    done: { type: 'boolean' },
  },
  required: ['id', 'title', 'done'],
};
for (const db of [inMemory, inSqlite]) {
  await db.addCollections({ tasks: { schema } });
  await db.tasks.insert({ id: 'docs', title: 'Write the docs', done: false });
  await db.tasks.insert({ id: 'ship', title: 'Ship it', done: true });
  assert.equal(await db.tasks.count({ selector: { done: false } }).exec(), 1);
  await db.close();
}
