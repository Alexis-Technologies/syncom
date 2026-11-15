// The Development checks page (docs/guide/dev-mode.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';

// #region definition
try {
  await createDatabase({ path: 'board', schema: { entities: { Task: { indexes: ['done'] } } } });
} catch (error) {
  console.log(error.message);
  // createDatabase({ schema }): entity Task: unknown key 'indexes'
  //   (expected schema, idField, validate, index, unique, fields, search, id, refs, methods, statics)
}
// #endregion definition
const refused = await createDatabase({ path: 'board', schema: { entities: { Task: { indexes: ['done'] } } } }).catch(
  (error) => error,
);
assert.equal(refused.name, 'TypeError');
assert.match(refused.message, /entity Task: unknown key 'indexes' \(expected schema, idField/);

const db = await createDatabase({ path: 'board', schema: { entities: { Task: { index: ['done'] } } } });

// #region query
try {
  db.Task.select({ votes: { $greater: 2 } });
} catch (error) {
  console.log(error.message); // 'select(): unknown operator $greater'
}
// #endregion query
assert.throws(() => db.Task.select({ votes: { $greater: 2 } }), {
  name: 'TypeError',
  message: 'select(): unknown operator $greater',
});

// #region code
await db.Task.insert({ id: 'write-docs', title: 'Write the docs', done: false });
try {
  await db.Task.insert({ id: 'write-docs', title: 'Write the docs again', done: false });
} catch (error) {
  if (error.code !== 'EXISTS') throw error;
  console.log(error.message); // 'Record write-docs exists already'
}
// #endregion code
await assert.rejects(() => db.Task.insert({ id: 'write-docs', title: 'x' }), {
  name: 'SyncomError',
  code: 'EXISTS',
  message: 'Record write-docs exists already',
});

// #region copies
const task = await db.Task.get('write-docs');
task.title = 'Changed on the copy';
console.log((await db.Task.get('write-docs')).title); // 'Write the docs'
// #endregion copies
assert.equal((await db.Task.get('write-docs')).title, 'Write the docs');

// #region inspect
import { inspect } from '@alexify/syncom/inspect';

await db.inc('write-docs', 'votes', 1);
const anatomy = await inspect(db, 'write-docs');
console.log(anatomy.fields.map(({ field, kind }) => `${field}: ${kind}`));
// [ '$type: register', 'done: register', 'title: register', 'votes: counter' ]
console.log(anatomy.log.map(({ type }) => type)); // [ 'write', 'inc' ]
// #endregion inspect
assert.deepEqual(
  anatomy.fields.map(({ field, kind }) => `${field}: ${kind}`),
  ['$type: register', 'done: register', 'title: register', 'votes: counter'],
);
assert.deepEqual(
  anatomy.log.map(({ type }) => type),
  ['write', 'inc'],
);
await db.close();
