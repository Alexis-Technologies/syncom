'use strict';

// A smoke of the package on a runtime that is not Node.js's test runner —
// Deno (`deno run -A tests/smoke/smoke.js`), Bun (`bun tests/smoke/smoke.js`)
// and Node itself (`node tests/smoke/smoke.js`): plain `node:assert`, no
// runner, and the package reached through its own `exports` (the self-reference
// `@alexify/syncom/<subpath>`), so what resolves here is what a consumer resolves.
// A database in memory is opened, written, queried; two nodes over the testing
// subpath's link converge; the shared facade leads alone; an attachment's bytes
// are put and read. What fails here is the runtime's, not a test's.

const assert = require('node:assert');
const syncom = require('@alexify/syncom/all');
const { createMesh, settle, memoryEngine } = require('@alexify/syncom/testing');
const { openShared } = require('@alexify/syncom/shared');
const { attachments } = require('@alexify/syncom/attachments');

const main = async () => {
  const engine = memoryEngine();
  const schema = { entities: { Task: { index: ['done'] } } };
  const db = await syncom.createDatabase({ engine, path: 'smoke', logger: false, defer: 0, schema });
  const id = await db.insert({ $type: 'Task', title: 'runs here', done: false });
  await db.Task.update(id, { done: true });
  assert.deepStrictEqual(await db.get(id), { $type: 'Task', title: 'runs here', done: true });
  assert.strictEqual(await db.Task.count({ done: true }), 1);
  assert.strictEqual((await db.Task.select({ done: true }).fetch())[0].title, 'runs here');
  await db.close();

  // Two nodes over the testing subpath's link: an op made on one lands on the other.
  const createStorage = (name, options) =>
    syncom.createDatabase({ engine, path: `smoke/${name}`, logger: false, defer: 0, schema, ...options });
  const mesh = await createMesh(['A', 'B'], [['B', 'A']], { createStorage });
  const a = mesh.get('A');
  const b = mesh.get('B');
  const shared = await a.insert({ $type: 'Task', title: 'from A', done: false });
  await settle([a, b]);
  assert.deepStrictEqual(await b.get(shared), { $type: 'Task', title: 'from A', done: false });
  await a.close();
  await b.close();

  // The shared facade alone: no election, no channel — it leads, and reads and writes as a database.
  const tab = await openShared({
    createDatabase: syncom.createDatabase,
    engine,
    path: 'smoke/tabs',
    logger: false,
    defer: 0,
    schema,
  });
  assert.strictEqual(tab.leader, true);
  const led = await tab.insert({ $type: 'Task', title: 'led', done: false });
  assert.deepStrictEqual(await tab.get(led), { $type: 'Task', title: 'led', done: false });
  await tab.close();

  // An attachment: bytes in the engine's blobs store, named on the record, read back whole.
  const withBlobs = await syncom.createDatabase({
    engine,
    path: 'smoke/blobs',
    logger: false,
    defer: 0,
    schema,
    plugins: [attachments()],
  });
  const holder = await withBlobs.insert({ $type: 'Task', title: 'with bytes', done: false });
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  await withBlobs.attachments.put(holder, 'five.bin', bytes, { type: 'application/octet-stream' });
  const got = await withBlobs.attachments.get(holder, 'five.bin');
  assert.deepStrictEqual([...got.bytes], [1, 2, 3, 4, 5]);
  assert.strictEqual(got.length, 5);
  await withBlobs.close();

  console.log(
    `syncom smoke ok on ${globalThis.Deno ? 'Deno' : globalThis.Bun ? 'Bun' : 'Node'} ${globalThis.Deno?.version?.deno ?? globalThis.Bun?.version ?? process.version}`,
  );
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
