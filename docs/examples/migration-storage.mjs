// The Storage migration page (docs/guide/migration-storage.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';

const schema = { entities: { Task: { index: ['done'] } } };

// The database as the app has run it so far: files under ./board.
const before = await createDatabase({ path: 'board', schema });
const task = await before.Task.insert({ title: 'Move to SQLite', done: false });
const nodeId = before.nodeId;
const vector = before.vector;

// #region close
await before.close(); // the copy holds the source's lock: close every instance first
// #endregion close

// #region copy
import { filesEngine, defaultFsi } from '@alexify/syncom';
import { sqliteEngine } from '@alexify/syncom/sqlite';
import { migrateStorage } from '@alexify/syncom/dump';

const result = await migrateStorage({
  from: filesEngine(defaultFsi), // what createDatabase({ path }) opens in Node.js
  to: sqliteEngine({ file: 'board.db' }),
  path: 'board',
});
console.log(result); // { records: 1, pieces: 0, copies: 0, kv: …, entries: 1, blobs: 0 }
// #endregion copy
assert.equal(result.records, 1);
assert.equal(result.entries, 1);

// #region open
const board = await createDatabase({ engine: sqliteEngine({ file: 'board.db' }), path: 'board', schema });
console.log(board.nodeId === nodeId); // true: the same node, with its log and its vector
console.log(await board.Task.get(task.id)); // { title: 'Move to SQLite', done: false, $type: 'Task' }
// #endregion open
assert.equal(board.nodeId, nodeId);
assert.deepEqual(board.vector, vector);
assert.deepEqual(await board.Task.get(task.id), { title: 'Move to SQLite', done: false, $type: 'Task' });
await board.close();

// #region refused
const again = await migrateStorage({
  from: filesEngine(defaultFsi),
  to: sqliteEngine({ file: 'board.db' }),
  path: 'board',
}).catch((error) => error);
console.log(again.code); // TARGET_NOT_EMPTY: a copy never writes over a database
// #endregion refused
assert.equal(again.code, 'TARGET_NOT_EMPTY');

// #region merge
import { memoryEngine } from '@alexify/syncom/memory';

const old = await createDatabase({ engine: sqliteEngine({ file: 'board.db' }), path: 'board', schema });
const fresh = await createDatabase({ engine: memoryEngine(), path: 'board', schema });
console.log(await migrateStorage({ from: old, to: fresh, mode: 'merge' })); // { mode: 'merge', records: 1 }
console.log(fresh.nodeId === old.nodeId); // false: a new node that holds the same records
// #endregion merge
assert.notEqual(fresh.nodeId, old.nodeId);
assert.deepEqual(await fresh.Task.get(task.id), { title: 'Move to SQLite', done: false, $type: 'Task' });
await old.close();
await fresh.close();
