// The Schema migration page (docs/guide/migration-schema.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';
import { memoryEngine, createMesh, settle } from '@alexify/syncom/testing';

const engine = memoryEngine();

// #region v1
// Version 1 of the app: a task has a `title`.
const v1 = await createDatabase({
  engine,
  path: 'board',
  schema: { version: 1, entities: { Task: {} } },
});
const task = await v1.Task.insert({ title: 'Write the docs', done: false });
await v1.close();
// #endregion v1

// #region v2
// Version 2 renames `title` to `name`.
const board = await createDatabase({
  engine,
  path: 'board',
  schema: {
    version: 2,
    entities: { Task: {} },
    migrations: {
      2: { Task: { up: ({ title, ...rest }) => ({ ...rest, name: title }) } },
    },
  },
});

console.log(board.schemaInfo.previous); // { version: 1, hash: null }: this database ran version 1 before
console.log(await board.Task.get(task.id)); // { done: false, name: 'Write the docs', $type: 'Task' }
console.log(board.getCachedData(task.id)); // { title: 'Write the docs', done: false, $type: 'Task' }: as stored
// #endregion v2
assert.deepEqual(board.schemaInfo.previous, { version: 1, hash: null });
assert.deepEqual(await board.Task.get(task.id), { done: false, name: 'Write the docs', $type: 'Task' });
assert.deepEqual(board.getCachedData(task.id), { title: 'Write the docs', done: false, $type: 'Task' });

// #region query
// Queries and documents see version 2 as well.
const rows = await board.Task.select({ name: 'Write the docs' }).fetch();
console.log(rows.length); // 1
// #endregion query
assert.equal(rows.length, 1);

// #region migrate
if (board.schemaInfo.previous) {
  const result = await board.migrate();
  console.log(result); // { migrated: 1, counters: 0, sets: 0, lists: 0, texts: 0, trees: 0 }
}
console.log(board.getCachedData(task.id)); // { done: false, name: 'Write the docs', $type: 'Task' }
// #endregion migrate
assert.deepEqual(board.getCachedData(task.id), { done: false, name: 'Write the docs', $type: 'Task' });
assert.equal((await board.migrate()).migrated, 0, 'idempotent');
await board.close();

// Two nodes on two versions: the phone still runs version 1, the server version 2.
const v1Schema = { version: 1, entities: { Task: {} } };
const v2Schema = {
  version: 2,
  entities: { Task: {} },
  migrations: { 2: { Task: { up: ({ title, ...rest }) => ({ ...rest, name: title }) } } },
};

// #region peers
const mesh = await createMesh(['server', 'phone'], [['phone', 'server']], {
  // each node gets its own schema through `nodes`; createStorage spreads it in
  createStorage: (name, options) => createDatabase({ ...options, engine: memoryEngine(), path: name }),
  nodes: { server: { schema: v2Schema }, phone: { schema: v1Schema } },
});
const phone = mesh.get('phone');
const server = mesh.get('server');

phone.on('schema', (event) => console.log(event.kind, event.op.v)); // ahead 2

const old = await phone.Task.insert({ title: 'Made on the phone' });
const fresh = await server.Task.insert({ name: 'Made on the server' });
await settle(mesh.storages);

console.log(await server.Task.get(old.id)); // { name: 'Made on the phone', $type: 'Task' }: the lens
console.log(await phone.Task.get(fresh.id)); // { name: 'Made on the server', $type: 'Task' }: as written
// #endregion peers
const aheads = [];
phone.on('schema', (event) => aheads.push(event));
assert.deepEqual(await server.Task.get(old.id), { name: 'Made on the phone', $type: 'Task' });
assert.deepEqual(await phone.Task.get(fresh.id), { name: 'Made on the server', $type: 'Task' });
await server.Task.insert({ name: 'Another one' });
await settle(mesh.storages);
assert.equal(aheads.length, 1);
assert.deepEqual([aheads[0].kind, aheads[0].held, aheads[0].op.v], ['ahead', false, 2]);
await mesh.close();

// #region hold
const held = await createMesh(['server', 'phone'], [['phone', 'server']], {
  createStorage: (name, options) => createDatabase({ ...options, engine, path: `hold/${name}` }),
  nodes: {
    server: { schema: v2Schema },
    phone: { schema: { ...v1Schema, ahead: 'hold' } }, // keep newer ops in the log until this node upgrades
  },
});
const later = await held.get('server').Task.insert({ name: 'Wait for version 2' });
await settle(held.storages);
console.log(await held.get('phone').Task.get(later.id)); // null: held, not applied
await held.close();

const upgraded = await createDatabase({ engine, path: 'hold/phone', schema: v2Schema });
console.log(upgraded.schemaInfo.held); // { replayed: 1, lost: 0 }
console.log(await upgraded.Task.get(later.id)); // { name: 'Wait for version 2', $type: 'Task' }
// #endregion hold
assert.deepEqual(upgraded.schemaInfo.held, { replayed: 1, lost: 0 });
assert.deepEqual(await upgraded.Task.get(later.id), { name: 'Wait for version 2', $type: 'Task' });
await upgraded.close();

const drifts = [];
// #region drift
// Both nodes say version 2, but their builds describe the schema differently.
const openNode = async (name, options) => {
  const db = await createDatabase({ ...options, engine: memoryEngine(), path: name });
  db.on('schema', (event) => {
    if (event.kind === 'drift') console.warn(`${name}: schema drift at version ${event.version}`);
  });
  return db;
};
const drifted = await createMesh(['server', 'phone'], [['phone', 'server']], {
  createStorage: openNode,
  nodes: {
    server: { schema: { ...v2Schema, snapshot: { Task: { name: 'string' } } } },
    phone: { schema: { ...v2Schema, snapshot: { Task: { name: 'string', due: 'date' } } } },
  },
});
// phone: schema drift at version 2
// server: schema drift at version 2
// #endregion drift
drifted.get('phone').on('schema', (event) => drifts.push(['phone', event.kind]));
drifted.get('server').on('schema', (event) => drifts.push(['server', event.kind]));
await settle(drifted.storages);
await drifted.links.get('mem://server').reconnect(); // a new hello: reported again
await settle(drifted.storages);
assert.deepEqual(new Set(drifts.map(([name, kind]) => `${name}:${kind}`)), new Set(['phone:drift', 'server:drift']));
await drifted.close();

// #region aliases
import { Model } from '@alexify/metaschema';

const modelV1 = new Model({}, new Map([['Task', { title: 'string', done: 'boolean' }]]));
const modelV2 = new Model(
  {},
  new Map([
    [
      'Task',
      { name: { type: 'string', aliases: ['title'] }, done: 'boolean', 'notes?': { type: 'string', default: '' } },
    ],
  ]),
);
const schemaOf = (model, version) => ({
  version,
  snapshot: model.toJSON(),
  entities: { Task: { schema: model.entities.get('Task') } },
});

const before = await createDatabase({ engine, path: 'meta', schema: schemaOf(modelV1, 1) });
const written = await before.Task.insert({ title: 'Read the lens', done: false });
await before.close();

const after = await createDatabase({ engine, path: 'meta', schema: schemaOf(modelV2, 2) });
console.log(await after.Task.get(written.id)); // { name: 'Read the lens', done: false, notes: '', $type: 'Task' }
// #endregion aliases
assert.deepEqual(await after.Task.get(written.id), { name: 'Read the lens', done: false, notes: '', $type: 'Task' });
await after.close();
