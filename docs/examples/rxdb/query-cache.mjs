// RxDB's side of the Query cache page's "Coming from RxDB" code group (docs/guide/query-cache.md), run by
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
        boardId: { type: 'string' },
      },
      required: ['id', 'title', 'done', 'boardId'],
    },
  },
});
await db.tasks.insert({ id: 'docs', title: 'Write the docs', done: false, boardId: 'b1' });
const seen = [];

// #region shared
// Two parts of the page show the open tasks of one board.
const header = db.tasks.find({ selector: { boardId: 'b1', done: false } });
const list = db.tasks.find({ selector: { boardId: 'b1', done: false } });
console.log(header === list); // true: the collection's QueryCache hands back one RxQuery

const a = header.$.subscribe((docs) => seen.push(['header', docs.length]));
const b = list.$.subscribe((docs) => seen.push(['list', docs.length]));
// #endregion shared
assert.equal(header, list);
await new Promise((resolve) => setTimeout(resolve, 20));
assert.deepEqual(seen, [
  ['header', 1],
  ['list', 1],
]);
a.unsubscribe();
b.unsubscribe();
await db.close();
