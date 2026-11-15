// RxDB's side of the Document page's "Coming from RxDB" code group (docs/guide/document.md), run by
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

// #region edit
let task = await db.tasks.insert({ id: 'docs', title: 'Write the docs', done: false });
const seen = [];
task.$.subscribe((latest) => seen.push(latest.title)); // every revision of the document

const updated = await task.patch({ title: 'Write the guide' }); // a new revision, a new object
console.log(task.title, updated.title); // 'Write the docs' 'Write the guide'
task = task.getLatest();
// #endregion edit
assert.equal(task.title, 'Write the guide');
assert.deepEqual(seen, ['Write the docs', 'Write the guide']);
await db.close();
