// The ORM page (docs/guide/orm.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';

// #region define
import { createDatabase } from '@alexify/syncom/all';

const board = await createDatabase({
  path: 'board',
  schema: {
    entities: {
      Task: {
        index: ['done'],
        methods: {
          // `this` is the Document
          label() {
            return this.done ? `✓ ${this.title}` : this.title;
          },
          async complete() {
            this.done = true;
            await this.save();
          },
        },
        statics: {
          // `this` is the collection
          open() {
            return this.select({ done: false }).order('title').fetch();
          },
        },
      },
    },
  },
});
// #endregion define

// #region use
const task = await board.Task.insert({ title: 'Write the docs', done: false });
console.log(task.label()); // 'Write the docs'
await task.complete();
console.log(task.label()); // '✓ Write the docs'

await board.Task.insert({ title: 'Ship it', done: false });
console.log((await board.Task.open()).map((row) => row.title)); // [ 'Ship it' ]
// #endregion use
assert.equal(task.label(), '✓ Write the docs');
assert.deepEqual(
  (await board.Task.open()).map((row) => row.title),
  ['Ship it'],
);

// #region hidden
console.log(Object.keys(task)); // [ 'title', 'done', '$type' ]: the fields, no methods
console.log(await board.Task.get(task.id)); // { title: 'Write the docs', done: true, $type: 'Task' }: nothing of them saved
// #endregion hidden
assert.ok(!Object.keys(task).includes('label'));
assert.deepEqual(await board.Task.get(task.id), { title: 'Write the docs', done: true, $type: 'Task' });
await board.close();

// #region clash
const refused = await createDatabase({
  path: 'clash',
  schema: { entities: { Task: { methods: { save() {} } } } }, // `save` is a Document's own
}).catch((error) => error);
console.log(refused.name); // TypeError
// #endregion clash
assert.equal(refused.name, 'TypeError');
