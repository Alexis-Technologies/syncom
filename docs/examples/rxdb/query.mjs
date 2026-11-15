// RxDB's side of the Query page's "Coming from RxDB" code group (docs/guide/query.md), run by
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
      properties: {
        id: { type: 'string', maxLength: 100 },
        title: { type: 'string' },
        done: { type: 'boolean' },
        due: { type: 'string' },
      },
      required: ['id', 'title', 'done'],
    },
  },
});
await db.tasks.bulkInsert([
  { id: 't1', title: 'Write the docs', done: false, due: '2026-12-01' },
  { id: 't2', title: 'Ship it', done: false, due: '2026-11-20' },
  { id: 't4', title: 'Answer issues', done: false },
]);

// #region watch
const seen = [];
const subscription = db.tasks
  .find({ selector: { done: false }, sort: [{ title: 'asc' }] })
  .$.subscribe((docs) => seen.push(docs.map((doc) => doc.id))); // [ 't4', 't2', 't1' ] right away
const shipped = await db.tasks.findOne('t2').exec();
await shipped.incrementalPatch({ done: true }); // [ 't4', 't1' ] once the write lands
// #endregion watch
await new Promise((resolve) => setTimeout(resolve, 50));
subscription.unsubscribe();
assert.deepEqual(seen, [
  ['t4', 't2', 't1'],
  ['t4', 't1'],
]);
await db.close();
