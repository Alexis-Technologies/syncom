// The Engine performance page (docs/guide/storage-performance.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';

// #region measure
import { createDatabase } from '@alexify/syncom/all';
import { memoryEngine } from '@alexify/syncom/memory';
import { sqliteEngine } from '@alexify/syncom/sqlite';

const schema = { entities: { Task: { index: ['done'] } } };
const candidates = {
  files: {}, // the default in Node.js: JSON files in a directory
  memory: { engine: memoryEngine() },
  sqlite: { engine: sqliteEngine({ file: 'tasks.sqlite' }) },
};
const rows = [];
for (let i = 0; i < 1000; i++) rows.push({ title: `Task ${i}`, done: i % 2 === 0 });

const results = {};
for (const [name, storage] of Object.entries(candidates)) {
  // Open each with the options your app uses: the chain, signing and hooks cost time on every engine.
  const db = await createDatabase({ path: `tasks-${name}`, schema, ...storage });
  let started = performance.now();
  await db.Task.bulkInsert(rows);
  await db.flush(); // the records have landed, not only the log
  const write = performance.now() - started;

  started = performance.now();
  const open = await db.Task.select({ done: false }).fetch();
  const read = performance.now() - started;
  results[name] = { write: Math.round(write), read: Math.round(read), rows: open.length };
  await db.close();
}
await candidates.sqlite.engine.close();
console.table(results); // milliseconds on this machine, with this data
// #endregion measure

for (const name of Object.keys(candidates)) assert.equal(results[name].rows, 500);
