// RxDB's side of the "Coming from RxDB" code group of docs/guide/orm.md, run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
import { createRxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';

const board = await createRxDatabase({ name: 'board', storage: getRxStorageMemory() });
// #region define
await board.addCollections({
  tasks: {
    schema: {
      version: 0,
      primaryKey: 'id',
      type: 'object',
      properties: { id: { type: 'string', maxLength: 100 }, title: { type: 'string' }, done: { type: 'boolean' } },
    },
    methods: {
      label() {
        return this.done ? `✓ ${this.title}` : this.title;
      },
    },
    statics: {
      open() {
        return this.find({ selector: { done: false } }).exec();
      },
    },
  },
});
// #endregion define
const task = await board.tasks.insert({ id: 'docs', title: 'Write the docs', done: false });
assert.equal(task.label(), 'Write the docs');
assert.equal((await board.tasks.open()).length, 1);
await board.close();
