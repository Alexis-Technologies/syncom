'use strict';

// A smoke of the package on a runtime that is not Node.js's test runner —
// Deno (`deno run -A tests/smoke/smoke.js`), Bun (`bun tests/smoke/smoke.js`)
// and Node itself (`node tests/smoke/smoke.js`): plain `node:assert`, no
// runner. A database in memory is opened, written, queried; two nodes over an
// in-process link converge. What fails here is the runtime's, not a test's.

const assert = require('node:assert');
const syncom = require('../../src/all/all.js');
const { createMesh, settle } = require('../utils/mesh.js');

const main = async () => {
  const engine = syncom.memoryEngine();
  const schema = { entities: { Task: { index: ['done'] } } };
  const db = await syncom.createDatabase({ engine, path: 'smoke', logger: false, defer: 0, schema });
  const id = await db.insert({ $type: 'Task', title: 'runs here', done: false });
  await db.Task.update(id, { done: true });
  assert.deepStrictEqual(await db.get(id), { $type: 'Task', title: 'runs here', done: true });
  assert.strictEqual(await db.Task.count({ done: true }), 1);
  assert.strictEqual((await db.Task.select({ done: true }).fetch())[0].title, 'runs here');
  await db.close();

  // Two nodes over a memory link: an op made on one lands on the other.
  const t = { after: () => {} };
  const createStorage = (_t, name, options) =>
    syncom.createDatabase({ engine, path: `smoke/${name}`, logger: false, defer: 0, schema, ...options });
  const mesh = await createMesh(t, ['A', 'B'], [['B', 'A']], createStorage);
  const a = mesh.get('A');
  const b = mesh.get('B');
  const shared = await a.insert({ $type: 'Task', title: 'from A', done: false });
  await settle([a, b]);
  assert.deepStrictEqual(await b.get(shared), { $type: 'Task', title: 'from A', done: false });
  await a.close();
  await b.close();
  console.log(
    `syncom smoke ok on ${globalThis.Deno ? 'Deno' : globalThis.Bun ? 'Bun' : 'Node'} ${globalThis.Deno?.version?.deno ?? globalThis.Bun?.version ?? process.version}`,
  );
};

main().catch((error) => {
  console.error('syncom smoke failed:', error);
  process.exit(1);
});
