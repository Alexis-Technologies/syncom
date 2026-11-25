// The Encryption page (docs/guide/encryption.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
// #region sealed
import { createDatabase } from '@alexify/syncom/all';

const board = await createDatabase({
  path: 'board',
  schema: { entities: { Task: { index: ['done'] } } },
});

const review = await board.Task.insert({ title: 'Salary review', done: false }, { encrypted: true });
console.log(await board.Task.get(review.id)); // { title: 'Salary review', done: false, $type: 'Task' }
console.log((await board.Task.select({ done: false }).fetch()).length); // 1: found by a query here
// #endregion sealed
const file = JSON.parse(readFileSync(`board/data/${review.id}.json`, 'utf8'));
assert.equal(file.encrypted, true);
assert.equal(file.meta, null);
assert.ok(!JSON.stringify(file).includes('Salary'), 'the record file holds no plaintext');
assert.deepEqual(readdirSync('board/keys').sort(), [
  'private.pem',
  'public.pem',
  'sign-private.pem',
  'sign-public.pem',
]);

// #region refused
await board.Task.update(review.id, { done: true }); // a plain field: fine, sealed again
await board.inc(review.id, 'votes', 1).catch((error) => console.log(error.code)); // ALX_ERR_ENCRYPTED
// #endregion refused
assert.equal((await board.Task.get(review.id)).done, true);
assert.equal((await board.inc(review.id, 'votes', 1).catch((error) => error)).code, 'ALX_ERR_ENCRYPTED');
await board.close();

// #region stays-local
import { createMesh, settle, memoryEngine } from '@alexify/syncom/testing';

const mesh = await createMesh(['server', 'laptop'], [['laptop', 'server']], {
  createStorage: (name, options) =>
    createDatabase({ ...options, engine: memoryEngine(), path: name, schema: { entities: { Task: {} } } }),
});
const laptop = mesh.get('laptop');
await laptop.Task.insert({ title: 'Ship it' });
await laptop.Task.insert({ title: 'Salary review' }, { encrypted: true });
await settle(mesh.storages);

console.log(await laptop.Task.count({})); // 2
console.log(await mesh.get('server').Task.count({})); // 1: the sealed task never left the laptop
// #endregion stays-local
assert.equal(await laptop.Task.count({}), 2);
assert.equal(await mesh.get('server').Task.count({}), 1);
await mesh.close();

// #region at-rest
import { defaultFsi } from '@alexify/syncom';
import { atRest } from '@alexify/syncom/encryption';

const disk = defaultFsi; // the platform's own files
const key = crypto.getRandomValues(new Uint8Array(32)); // keep it outside the database: a keychain, your server

const vault = await createDatabase({ path: 'vault', fsi: atRest(disk, { key }) });
const note = await vault.insert({ text: 'The safe code is 1234' });
await vault.close();

console.log(readFileSync(`vault/data/${note}.json`, 'utf8').slice(0, 5)); // enc1:   every file is ciphertext
// #endregion at-rest
assert.ok(readFileSync(`vault/data/${note}.json`, 'utf8').startsWith('enc1:'));
assert.ok(readFileSync('vault/node.json', 'utf8').startsWith('enc1:'));
const wrongKey = atRest(disk, { key: crypto.getRandomValues(new Uint8Array(32)) });
const refusedOpen = await createDatabase({ path: 'vault', fsi: wrongKey }).catch((error) => error);
assert.equal(refusedOpen.code, 'ALX_ERR_DECRYPT_FAILED');
assert.equal(refusedOpen.reason, 'key');

// #region password
const engine = memoryEngine(); // or IndexedDB, SQLite, MongoDB: atRest() wraps an engine too
const locked = atRest(engine, { password: 'correct horse battery', salt: 'board-salt-1' });

const app = await createDatabase({ path: 'app', engine: locked });
// #endregion password
await app.insert({ text: 'sealed in the engine' });
await app.close();
const reopened = await createDatabase({
  path: 'app',
  engine: atRest(engine, { password: 'correct horse battery', salt: 'board-salt-1' }),
});
assert.equal((await reopened.list()).length, 1);
await reopened.close();

// #region rotate
import { dropDatabase, filesEngine } from '@alexify/syncom';
import { rotateAtRest } from '@alexify/syncom/encryption';

const newKey = crypto.getRandomValues(new Uint8Array(32));
await rotateAtRest(
  { fsi: disk, filesEngine },
  { path: 'vault', from: { key }, to: { key: newKey }, into: { path: 'vault-2' } },
);

await createDatabase({ path: 'vault', fsi: atRest(disk, { key }) }).catch((error) => console.log(error.code)); // ALX_ERR_MOVED
const moved = await createDatabase({ path: 'vault-2', fsi: atRest(disk, { key: newKey }) });
console.log(await moved.get(note)); // { text: 'The safe code is 1234' }   the same node, the same data
await dropDatabase('vault', { fsi: atRest(disk, { key }) }); // once the new place reads
// #endregion rotate
assert.deepEqual(await moved.get(note), { text: 'The safe code is 1234' });
assert.equal(moved.nodeId, vault.nodeId);
await moved.close();
