// The JSON import and export page (docs/guide/import-export.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';
import { memoryEngine } from '@alexify/syncom/memory';

const schema = { entities: { Task: {}, Note: {} } };
const board = await createDatabase({ path: 'board', schema });
const task = await board.Task.insert({ title: 'Write the docs', done: false });
await board.inc(task.id, 'votes', 2);
const gone = await board.Task.insert({ title: 'Deleted', done: true });
await board.Task.delete(gone.id);
await board.Note.insert({ text: 'not a task' });

// #region export
import { exportJSON } from '@alexify/syncom/dump';

const dump = await exportJSON(board);
console.log(Object.keys(dump)); // [ 'format', 'node', 'schema', 'kinds', 'eventId', 'vector', 'meta', 'records' ]
console.log(dump.records.length); // 3: the live records and the tombstone, each with its meta
// #endregion export
assert.deepEqual(Object.keys(dump), ['format', 'node', 'schema', 'kinds', 'eventId', 'vector', 'meta', 'records']);
assert.equal(dump.records.length, 3);
assert.equal(dump.records.filter((record) => record.deleted).length, 1);

// #region plain
const tasks = await exportJSON(board, { collections: ['Task'], meta: false });
console.log(tasks.records); // [ { id: '…', data: { title: 'Write the docs', done: false, $type: 'Task', votes: 2 } } ]
// #endregion plain
assert.deepEqual(tasks.records, [
  { id: task.id, data: { title: 'Write the docs', done: false, $type: 'Task', votes: 2 } },
]);

// #region pages
import { exportPages } from '@alexify/syncom/dump';

let count = 0;
for await (const page of exportPages(board, { limit: 2 })) count += page.length; // 2 records, then 1
console.log(count); // 3
// #endregion pages
assert.equal(count, 3);

// #region merge
import { importJSON } from '@alexify/syncom/dump';

const copy = await createDatabase({ engine: memoryEngine(), path: 'copy', schema });
console.log(await importJSON(copy, dump)); // { mode: 'merge', records: 3 }
console.log(await copy.Task.get(task.id)); // { title: 'Write the docs', done: false, $type: 'Task', votes: 2 }
// #endregion merge
assert.deepEqual(await copy.Task.get(task.id), { title: 'Write the docs', done: false, $type: 'Task', votes: 2 });
assert.equal(await copy.get(gone.id), null);
await copy.inc(task.id, 'votes', 1);
assert.equal((await copy.get(task.id)).votes, 3, 'the counter merged as a counter');

// #region insert
const fresh = await createDatabase({ engine: memoryEngine(), path: 'fresh', schema });
console.log(await importJSON(fresh, dump, { mode: 'insert' })); // { mode: 'insert', records: 3 }
// #endregion insert
assert.equal((await fresh.get(task.id)).title, 'Write the docs');
assert.equal(await fresh.get(gone.id), null);

// #region foreign
const fromElsewhere = {
  records: [
    { id: 'legacy-1', data: { $type: 'Task', title: 'From the old app', done: false } },
    { id: 'legacy-2', data: { $type: 'Task', title: 'Removed there' }, deleted: true },
  ],
};
await importJSON(fresh, fromElsewhere, { mode: 'insert' });
console.log(await fresh.Task.get('legacy-1')); // { $type: 'Task', title: 'From the old app', done: false }
// #endregion foreign
assert.equal((await fresh.Task.get('legacy-1')).title, 'From the old app');
assert.equal(await fresh.get('legacy-2'), null);

// #region mismatch
const v2 = await createDatabase({
  engine: memoryEngine(),
  path: 'v2',
  schema: { ...schema, version: 2, snapshot: { Task: ['title', 'done', 'due'] } },
});
const refused = await importJSON(v2, dump).catch((error) => error);
console.log(refused.code); // SCHEMA_MISMATCH: the dump was made under another schema
await importJSON(v2, dump, { force: true }); // you know the records read the same under both
// #endregion mismatch
assert.equal(refused.code, 'SCHEMA_MISMATCH');
assert.equal((await v2.get(task.id)).title, 'Write the docs');

await Promise.all([board.close(), copy.close(), fresh.close(), v2.close()]);
