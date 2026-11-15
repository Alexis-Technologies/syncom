// The Installation page (docs/guide/install.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
// #region lean
import { createDatabase } from '@alexify/syncom';
import { schema } from '@alexify/syncom/schema';
import { query } from '@alexify/syncom/query';

const db = await createDatabase({
  path: 'board',
  plugins: [schema, query],
  schema: { entities: { Task: { index: ['done'] } } },
});
const task = await db.Task.insert({ title: 'Write the docs', done: false });
console.log(await db.Task.select({ done: false }).count()); // 1
// #endregion lean
assert.equal(await db.Task.select({ done: false }).count(), 1);

// #region missing
try {
  await db.splice(task.id, 'notes', 0, 0, 'Start with the install page');
} catch (error) {
  console.log(error.code); // 'PLUGIN_MISSING'
  console.log(error.message);
  // splice() needs the text plugin: createDatabase({ plugins: [text] }) from '@alexify/syncom/text'
}
// #endregion missing
await assert.rejects(() => db.splice(task.id, 'notes', 0, 0, 'x'), {
  name: 'TypeError',
  code: 'PLUGIN_MISSING',
  message: "splice() needs the text plugin: createDatabase({ plugins: [text] }) from '@alexify/syncom/text'",
});
await db.close();

// #region add-text
import { text } from '@alexify/syncom/text';

const notes = await createDatabase({
  path: 'board',
  plugins: [schema, query, text],
  schema: { entities: { Task: { index: ['done'] } } },
});
await notes.splice(task.id, 'notes', 0, 0, 'Start with the install page');
console.log((await notes.Task.get(task.id)).notes); // 'Start with the install page'
// #endregion add-text
assert.equal((await notes.Task.get(task.id)).notes, 'Start with the install page');
await notes.close();
