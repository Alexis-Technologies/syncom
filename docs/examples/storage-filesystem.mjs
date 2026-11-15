// The Filesystem (Node.js) page (docs/guide/storage-filesystem.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

// #region open
import { createDatabase } from '@alexify/syncom/all';

const schema = { entities: { Task: { index: ['done'] } } };
const db = await createDatabase({ path: 'board', schema });
const task = await db.Task.insert({ title: 'Stored as a file', done: false });
await db.close();
// #endregion open

// #region read-file
import { readFile } from 'node:fs/promises';

const file = JSON.parse(await readFile(`board/data/${task.id}.json`, 'utf8'));
console.log(file.data); // { title: 'Stored as a file', done: false, $type: 'Task' }
// #endregion read-file
assert.deepEqual(file.data, { title: 'Stored as a file', done: false, $type: 'Task' });
for (const name of ['node.json', 'schema.json', 'keys', 'blockchain', 'data', 'index', 'log']) {
  assert.ok(existsSync(`board/${name}`), name);
}
assert.ok(readdirSync('board/log').some((name) => name.startsWith('seg-')));

// #region durable
const server = await createDatabase({ path: 'server', schema, durable: true, defer: 0 });
// #endregion durable
await server.Task.insert({ title: 'fsync before resolve', done: false });

// #region locked
try {
  await createDatabase({ path: 'server', schema });
} catch (error) {
  console.log(error.code); // 'LOCKED': another instance holds the directory
}
// #endregion locked
await assert.rejects(() => createDatabase({ path: 'server', schema }), { code: 'LOCKED' });
const lock = JSON.parse(readFileSync('server/lock.json', 'utf8'));
assert.equal(lock.pid, process.pid);

// #region wait
const waiting = createDatabase({ path: 'server', schema, lock: { mode: 'wait', timeout: 5000 } });
await server.close(); // the waiting open goes on once this instance lets go
const next = await waiting;
// #endregion wait
assert.equal(await next.Task.count({}), 1);
await next.close();
assert.equal(existsSync('server/lock.json'), false, 'close() releases the lock');

// #region drop
import { dropDatabase } from '@alexify/syncom';

await dropDatabase('server'); // a closed database, every file of it
// #endregion drop
assert.deepEqual(readdirSync('server/data'), []);
assert.equal(existsSync('server/node.json'), false);
