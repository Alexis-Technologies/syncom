// The Memory page (docs/guide/storage-memory.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

// #region engine
import { createDatabase } from '@alexify/syncom/all';
import { memoryEngine } from '@alexify/syncom/memory';

const engine = memoryEngine();
const schema = { entities: { Task: { index: ['done'] } } };

const db = await createDatabase({ path: 'board', schema, engine });
await db.Task.insert({ title: 'Kept in memory', done: false });
// #endregion engine
assert.equal(existsSync('board'), false, 'nothing on disk');

// #region reopen
await db.close();
const again = await createDatabase({ path: 'board', schema, engine });
console.log(await again.Task.count({})); // 1: the same engine still holds the database
await again.close();

await engine.remove('board'); // gone for good
const fresh = await createDatabase({ path: 'board', schema, engine });
console.log(await fresh.Task.count({})); // 0
// #endregion reopen
assert.equal(await fresh.Task.count({}), 0);
await fresh.close();

// #region paths
const server = await createDatabase({ path: 'server', schema, engine });
const laptop = await createDatabase({ path: 'laptop', schema, engine });
console.log(engine.paths); // [ 'board', 'laptop', 'server' ]: one engine, a database per path
// #endregion paths
assert.deepEqual(engine.paths, ['board', 'laptop', 'server']);
await server.close();
await laptop.close();

// #region quota
const sized = await createDatabase({ path: 'sized', schema, engine });
await sized.Task.insert({ title: 'Count my bytes', done: false });
await sized.flush();
console.log(await sized.quota()); // { usage: <bytes held>, quota: null }
// #endregion quota
const room = await sized.quota();
assert.ok(room.usage > 0);
assert.equal(room.quota, null);
await sized.close();

// #region fsi
import { memory } from '@alexify/syncom/memory';

const files = memory();
const inspected = await createDatabase({ path: 'board', schema, fsi: files });
await inspected.Task.insert({ title: 'A file in a Map', done: false });
await inspected.close();
console.log(Object.keys(files.dump()).filter((name) => name.startsWith('board/data/')).length); // 1
// #endregion fsi
assert.equal(Object.keys(files.dump()).filter((name) => name.startsWith('board/data/')).length, 1);
