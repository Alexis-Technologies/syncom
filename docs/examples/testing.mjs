// The Testing page (docs/guide/testing.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory; node:test reports and sets the exit code.
import assert from 'node:assert/strict';
// #region memory
import { it } from 'node:test';
import { createDatabase } from '@alexify/syncom/all';
import { memoryEngine } from '@alexify/syncom/testing';

const engine = memoryEngine(); // one engine for the whole test file, a database per path

const openBoard = (path) =>
  createDatabase({ engine, path, logger: false, schema: { entities: { Task: { index: ['done'] } } } });

it('should close a task', async () => {
  const board = await openBoard('close-a-task');
  const task = await board.Task.insert({ title: 'Write the docs', done: false });
  await board.Task.update(task.id, { done: true });
  assert.equal((await board.Task.get(task.id)).done, true);
  await board.close();
});
// #endregion memory

// #region with-database
import { withDatabase } from '@alexify/syncom/testing';

it('should find no open tasks on an empty board', async () => {
  const open = await withDatabase(
    () => openBoard('empty-board'),
    (board) => board.Task.select({ done: false }).count(),
  );
  assert.equal(open, 0);
});
// #endregion with-database

// #region mesh
import { createMesh, settle } from '@alexify/syncom/testing';

// What createMesh() calls for every node: spread its options (the links) into your own createDatabase()
const boardOn = (memory) => (name, options) =>
  createDatabase({ ...options, engine: memory, path: name, logger: false, schema: { entities: { Task: {} } } });

it('should carry a task written on the phone to the laptop through the server', async () => {
  // ['phone', 'server'] means the phone dials the server
  const mesh = await createMesh(
    ['server', 'laptop', 'phone'],
    [
      ['laptop', 'server'],
      ['phone', 'server'],
    ],
    { createStorage: boardOn(memoryEngine()) }, // a fresh engine: nothing left over from another test
  );
  const task = await mesh.get('phone').Task.insert({ title: 'Buy milk', done: false });
  await settle(mesh.storages);
  assert.equal((await mesh.get('laptop').Task.get(task.id)).title, 'Buy milk');
  await mesh.close();
});
// #endregion mesh

// #region hazards
import { prng } from '@alexify/syncom/testing';

it('should converge over a slow link that repeats pages', async () => {
  const random = prng(42); // the same numbers on every run: a failure can be replayed
  const mesh = await createMesh(['server', 'laptop'], [['laptop', 'server']], {
    createStorage: boardOn(memoryEngine()),
    link: {
      latency: 2, // ms on every call and every event
      duplicate: (page) => page.ops?.length > 0 && random() < 0.5, // a page delivered twice
    },
  });
  for (let i = 0; i < 20; i++) await mesh.get(i % 2 ? 'server' : 'laptop').Task.insert({ title: `task ${i}` });
  await settle(mesh.storages, { timeout: 10_000 });
  assert.equal(await mesh.get('server').Task.select({}).count(), 20);
  assert.equal(await mesh.get('laptop').Task.select({}).count(), 20);
  await mesh.close();
});
// #endregion hazards

// #region drop
import { waitUntil } from '@alexify/syncom/testing';

it('should take the link down when a page is lost, until it reconnects', async () => {
  let lose = false;
  const mesh = await createMesh(['server', 'laptop'], [['laptop', 'server']], {
    createStorage: boardOn(memoryEngine()),
    link: { drop: (page) => lose && page.ops?.length > 0 }, // a page with ops lost while `lose` is on
  });
  await settle(mesh.storages);
  const link = mesh.links.get('mem://server');

  lose = true;
  await mesh.get('server').Task.insert({ title: 'Lost on the way' });
  await waitUntil(() => link.down); // the socket died with the page
  await assert.rejects(settle(mesh.storages, { timeout: 200 }), /did not settle/);

  lose = false;
  await link.reconnect(); // resumes after the last page delivered: the lost one comes again
  await settle(mesh.storages);
  assert.equal(await mesh.get('laptop').Task.select({}).count(), 1);
  await mesh.close();
});
// #endregion drop

// #region streams
import { attachments } from '@alexify/syncom/attachments';

it('should carry a large attachment across a link whose messages are small', async () => {
  const memory = memoryEngine();
  const mesh = await createMesh(['server', 'laptop'], [['laptop', 'server']], {
    createStorage: (name, options) =>
      createDatabase({ ...options, engine: memory, path: name, logger: false, plugins: [attachments()] }),
    // A binary transport that takes no message past 256 KiB, as a WebSocket with a low limit would
    link: { streams: true, maxMessage: 256 * 1024 },
  });
  await settle(mesh.storages);
  const laptop = mesh.get('laptop');

  const id = await laptop.insert({ title: 'Trip photos' });
  await laptop.attachments.put(id, 'photos.zip', new Uint8Array(1024 * 1024).fill(7), { type: 'application/zip' });
  await settle(mesh.storages);

  assert.equal(await mesh.get('server').attachments.has(id, 'photos.zip'), true); // 1 MiB went up in chunks
  assert.equal(mesh.links.get('mem://server').down, false); // and no message was too big
  await mesh.close();
});
// #endregion streams

// #region offline
it('should sync the writes made offline after the reconnect', async () => {
  const mesh = await createMesh(['server', 'laptop'], [['laptop', 'server']], {
    createStorage: boardOn(memoryEngine()),
  });
  await settle(mesh.storages); // the laptop has dialed and met the server
  const link = mesh.links.get('mem://server'); // the link the laptop dialed

  link.disconnect(); // calls fail with code 503, the feed stops
  await mesh.get('laptop').Task.insert({ title: 'Written on the train' });
  assert.equal(await mesh.get('server').Task.select({}).count(), 0);

  await link.reconnect(); // every subscription re-opened from its last event id
  await settle(mesh.storages);
  assert.equal(await mesh.get('server').Task.select({}).count(), 1);
  await mesh.close();
});
// #endregion offline

it('should record what crossed the link', async () => {
  const mesh = await createMesh(['server', 'laptop'], [['laptop', 'server']], {
    createStorage: boardOn(memoryEngine()),
  });
  await mesh.get('laptop').Task.insert({ title: 'counted' });
  await settle(mesh.storages);
  // #region calls
  const calls = mesh.links.get('mem://server').calls;
  console.log(calls.slice(0, 2)); // [ 'syncom/hello', 'syncom/push' ]
  // #endregion calls
  assert.deepEqual(calls.slice(0, 2), ['syncom/hello', 'syncom/push']);
  await mesh.close();
});
