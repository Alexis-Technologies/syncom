// RxDB's side of the Collection page's "Coming from RxDB" code group (docs/guide/collection.md), run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
import { createRxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';

const db = await createRxDatabase({ name: 'board', storage: getRxStorageMemory() });
await db.addCollections({
  tasks: {
    schema: {
      version: 0,
      primaryKey: 'id',
      type: 'object',
      properties: { id: { type: 'string', maxLength: 100 }, title: { type: 'string' }, done: { type: 'boolean' } },
      required: ['id', 'title', 'done'],
    },
  },
});

// #region bulk
await db.tasks.insert({ id: 'plan', title: 'Plan the release', done: false });
const { success, error } = await db.tasks.bulkInsert([
  { id: 'announce', title: 'Announce it', done: false },
  { id: 'plan', title: 'A second plan', done: false }, // a duplicate inside one batch throws instead
]);
console.log(success.map((doc) => doc.id)); // the documents written
console.log(error.map((row) => row.status)); // a 409 conflict for the taken id
await db.tasks.bulkRemove(['announce']);
// #endregion bulk
assert.deepEqual(
  success.map((doc) => doc.id),
  ['announce'],
);
assert.deepEqual(
  error.map((row) => row.status),
  [409],
);
await db.close();
