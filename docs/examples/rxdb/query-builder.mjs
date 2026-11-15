// RxDB's side of the Query builder page's "Coming from RxDB" code group (docs/guide/query-builder.md), run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
import { addRxPlugin, createRxDatabase } from 'rxdb';
import { RxDBQueryBuilderPlugin } from 'rxdb/plugins/query-builder';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';

addRxPlugin(RxDBQueryBuilderPlugin);
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
        priority: { type: 'number' },
        due: { type: 'string' },
      },
      required: ['id', 'title', 'done', 'priority', 'due'],
    },
  },
});
await db.tasks.bulkInsert([
  { id: 't1', title: 'Write the docs', done: false, priority: 2, due: '2026-12-01' },
  { id: 't2', title: 'Ship it', done: false, priority: 3, due: '2026-11-20' },
  { id: 't3', title: 'Set up the repo', done: true, priority: 1, due: '2026-10-01' },
  { id: 't4', title: 'Answer issues', done: false, priority: 2, due: '2026-11-25' },
]);

// #region chain
const docs = await db.tasks
  .find()
  .where('done')
  .eq(false)
  .where('priority')
  .gte(2)
  .sort({ priority: 'desc', due: 'asc' })
  .limit(2)
  .exec(); // whole documents: RxDB has no projection
console.log(docs.map((doc) => doc.id)); // [ 't2', 't4' ]
// #endregion chain
assert.deepEqual(
  docs.map((doc) => doc.id),
  ['t2', 't4'],
);
await db.close();
