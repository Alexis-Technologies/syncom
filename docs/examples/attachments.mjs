// The Attachments page (docs/guide/attachments.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createMesh, settle, memoryEngine } from '@alexify/syncom/testing';

// #region open
import { createDatabase } from '@alexify/syncom/all';
import { attachments } from '@alexify/syncom/attachments';

const board = await createDatabase({
  path: 'board',
  plugins: [attachments()],
  schema: { entities: { Task: {} } },
});
// #endregion open

// #region put
const task = await board.Task.insert({ title: 'Fix the login page', done: false });
const screenshot = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // the bytes of a PNG, say

const entry = await board.attachments.put(task.id, 'screenshot.png', screenshot, { type: 'image/png' });
console.log(entry); // { digest: '4c4b6a…', type: 'image/png', length: 8 }
// #endregion put
assert.match(entry.digest, /^[0-9a-f]{64}$/);
assert.deepEqual({ type: entry.type, length: entry.length }, { type: 'image/png', length: 8 });

// #region read
const file = await board.attachments.get(task.id, 'screenshot.png');
console.log(file.bytes); // Uint8Array(8) [ 137, 80, 78, 71, 13, 10, 26, 10 ]
console.log(await board.attachments.list(task.id)); // [ { name: 'screenshot.png', digest: '4c4b6a…', type: 'image/png', length: 8 } ]
console.log(await board.Task.get(task.id));
// { title: 'Fix the login page', done: false, $type: 'Task',
//   _attachments: { 'screenshot.png': { digest: '4c4b6a…', type: 'image/png', length: 8 } } }
// #endregion read
assert.deepEqual(file.bytes, screenshot);
assert.deepEqual((await board.Task.get(task.id))._attachments, { 'screenshot.png': entry });
assert.deepEqual(await board.attachments.list(task.id), [{ name: 'screenshot.png', ...entry }]);

// #region text
await board.attachments.put(task.id, 'notes.txt', 'Steps to reproduce: …', { type: 'text/plain' });
const notes = await board.attachments.get(task.id, 'notes.txt');
console.log(new TextDecoder().decode(notes.bytes)); // Steps to reproduce: …
// #endregion text
assert.equal(new TextDecoder().decode(notes.bytes), 'Steps to reproduce: …');

// #region remove
await board.attachments.remove(task.id, 'screenshot.png'); // the name leaves the record; the bytes stay
console.log(await board.attachments.sweep({ dryRun: true })); // { blobs: 2, marked: 1, removed: 1, pending: 0 }
await board.attachments.sweep(); // removes every blob no record names
// #endregion remove
assert.deepEqual(await board.attachments.sweep({ dryRun: true }), { blobs: 1, marked: 1, removed: 0, pending: 0 });
assert.equal(await board.attachments.get(task.id, 'screenshot.png'), null);
await board.close();

// #region compression
const compressed = await createDatabase({
  path: 'compressed',
  plugins: [attachments({ compression: 'gzip' })], // or 'deflate'
});
const report = await compressed.insert({ title: 'Monthly report' });
const stored = await compressed.attachments.put(report, 'report.csv', 'day,tasks\n'.repeat(1000), { type: 'text/csv' });
console.log(stored); // { digest: '…', type: 'text/csv', length: 10000, encoding: 'gzip' }
// #endregion compression
assert.equal(stored.encoding, 'gzip');
assert.equal(stored.length, 10000);
assert.equal((await compressed.attachments.get(report, 'report.csv')).bytes.length, 10000);
await compressed.close();

// #region peers
const mesh = await createMesh(['server', 'phone'], [['phone', 'server']], {
  createStorage: (name, options) =>
    createDatabase({ ...options, engine: memoryEngine(), path: name, plugins: [attachments()] }),
});
const server = mesh.get('server');
const phone = mesh.get('phone');

const id = await server.insert({ title: 'Design review' });
await server.attachments.put(id, 'mockup.png', new Uint8Array(1024), { type: 'image/png' });
await settle(mesh.storages);

console.log(await phone.attachments.list(id)); // [ { name: 'mockup.png', … } ]: the name arrived
console.log(await phone.attachments.has(id, 'mockup.png')); // false: the bytes did not
const mockup = await phone.attachments.get(id, 'mockup.png'); // asks the server, checks the digest, keeps them
console.log(await phone.attachments.has(id, 'mockup.png')); // true
// #endregion peers
assert.equal((await phone.attachments.list(id)).length, 1);
assert.equal(mockup.bytes.length, 1024);
assert.equal(await phone.attachments.has(id, 'mockup.png'), true);
assert.equal(phone.attachments.stats().fetched, 1);

// #region offline
await server.attachments.put(id, 'second.png', new Uint8Array(16), { type: 'image/png' });
await settle(mesh.storages);
const missing = await phone.attachments.get(id, 'second.png', { fetch: false }).catch((error) => error);
console.log(missing.code); // BLOB_NOT_FOUND: not here, and nobody was asked
// #endregion offline
assert.equal(missing.code, 'BLOB_NOT_FOUND');
await mesh.close();
