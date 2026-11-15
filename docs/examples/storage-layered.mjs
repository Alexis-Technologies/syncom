// The Memory over disk page (docs/guide/storage-layered.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// #region through
import { createDatabase, defaultFsi } from '@alexify/syncom/all';
import { memory } from '@alexify/syncom/memory';
import { layered } from '@alexify/syncom/layered';

const disk = defaultFsi; // the platform's own files
const fsi = layered([memory(), disk]); // write: 'through' is the default

const board = await createDatabase({ path: 'board', fsi, schema: { entities: { Task: {} } } });
const task = await board.Task.insert({ title: 'On both layers' }); // resolves once the disk has it
await board.close();
// #endregion through

// #region bottom
// The disk alone holds everything the stack wrote.
const plain = await createDatabase({ path: 'board', schema: { entities: { Task: {} } } });
console.log(await plain.Task.get(task.id)); // { title: 'On both layers', $type: 'Task' }
await plain.close();
// #endregion bottom
const reread = await createDatabase({ path: 'board', logger: false });
assert.deepEqual(await reread.get(task.id), { title: 'On both layers', $type: 'Task' });
await reread.close();

// #region back
const failures = [];
const fast = layered([memory(), disk], {
  write: 'back', // a write resolves once memory has it; the disk is written from a queue
  queue: 1024, // calls that may wait before the next write waits for room
  onError: (error) => failures.push(error), // a queued write that failed on the disk
});

const notes = await createDatabase({ path: 'notes', fsi: fast });
for (let i = 0; i < 100; i++) await notes.insert({ text: `note ${i}` });
console.log(fast.pending); // what the queue still holds for the disk, if anything
await notes.close();
await fast.close(); // flushes the queue: rejects with the first write that failed
// #endregion back
assert.equal(fast.pending, 0);
assert.deepEqual(failures, []);
const flushed = await createDatabase({ path: 'notes', logger: false });
assert.equal((await flushed.list()).length, 100);
await flushed.close();

// #region sealed-disk
import { atRest } from '@alexify/syncom/encryption';

const key = crypto.getRandomValues(new Uint8Array(32));
const vault = layered([memory(), atRest(disk, { key })]); // plain in memory, ciphertext on the disk

const secrets = await createDatabase({ path: 'vault', fsi: vault });
const secret = await secrets.insert({ text: 'The safe code is 1234' });
await secrets.close();
// #endregion sealed-disk
assert.ok(readFileSync(`vault/data/${secret}.json`, 'utf8').startsWith('enc1:'));
assert.equal(vault.layers.length, 2);
