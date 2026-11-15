// RxDB's side of the SQLite page's "Coming from RxDB" code group (docs/guide/storage-sqlite.md), run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
// #region open
import { createRxDatabase } from 'rxdb';
import { getRxStorageSQLiteTrial, getSQLiteBasicsNodeNative } from 'rxdb/plugins/storage-sqlite';
import { DatabaseSync } from 'node:sqlite';

// The free trial storage; the production one is in RxDB Premium. The "basics" adapt node:sqlite.
const db = await createRxDatabase({
  name: 'board',
  storage: getRxStorageSQLiteTrial({ sqliteBasics: getSQLiteBasicsNodeNative(DatabaseSync) }),
});
await db.addCollections({
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
await db.tasks.insert({ id: 'sqlite', title: 'Stored in SQLite', done: false });
// #endregion open
assert.equal(await db.tasks.count().exec(), 1);
await db.close();
