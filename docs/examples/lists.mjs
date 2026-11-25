// The Lists page (docs/guide/lists.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
// #region edit
import { createDatabase, memoryEngine } from '@alexify/syncom/all';

const board = await createDatabase({
  engine: memoryEngine(),
  schema: { entities: { Task: {} } },
});
const task = await board.Task.insert({ title: 'Plan the release' });

await board.push(task.id, 'checklist', ['write', 'ship']); // the first write makes `checklist` a list
await board.splice(task.id, 'checklist', 1, 0, ['test']); // insert at index 1
await board.splice(task.id, 'checklist', 0, 1); // remove one element at index 0
await board.splice(task.id, 'checklist', 0, 1, [{ step: 'test', owner: 'ada' }]); // replace it
console.log((await board.Task.get(task.id)).checklist);
// [ { step: 'test', owner: 'ada' }, 'ship' ]
// #endregion edit
assert.deepEqual((await board.Task.get(task.id)).checklist, [{ step: 'test', owner: 'ada' }, 'ship']);

// #region document
await task.push('checklist', ['announce']); // the same call on the live document
// #endregion document
assert.deepEqual((await board.Task.get(task.id)).checklist, [{ step: 'test', owner: 'ada' }, 'ship', 'announce']);

// #region errors
try {
  await board.splice(task.id, 'checklist', 9, 0, ['late']);
} catch (error) {
  console.log(error.code, error.length); // ALX_ERR_OUT_OF_RANGE 3
}
try {
  await board.splice(task.id, 'title', 0, 0, ['not a list']);
} catch (error) {
  console.log(error.code, error.kind); // ALX_ERR_FIELD_KIND register
}
// #endregion errors
await assert.rejects(board.splice(task.id, 'checklist', 9, 0, ['late']), { code: 'ALX_ERR_OUT_OF_RANGE', length: 3 });
await assert.rejects(board.splice(task.id, 'title', 0, 0, ['x']), { code: 'ALX_ERR_FIELD_KIND', kind: 'register' });
await assert.rejects(board.Task.update(task.id, { checklist: [] }), { code: 'ALX_ERR_FIELD_KIND', kind: 'list' });

// #region move
await board.setAt(task.id, 'checklist', 0, 'test it'); // a new value for the element at 0
await board.move(task.id, 'checklist', 2, 0); // the element at 2 goes first
console.log((await board.Task.get(task.id)).checklist); // [ 'announce', 'test it', 'ship' ]
// #endregion move
assert.deepEqual((await board.Task.get(task.id)).checklist, ['announce', 'test it', 'ship']);

// #region children
const [first] = await board.elements(task.id, 'checklist'); // the elements' names, in order
await board.setAt(task.id, 'checklist', 0, { step: 'announce' });
await board.update(task.id, { [`checklist/${first}/done`]: true }); // a register inside the element
await board.inc(task.id, `checklist/${first}/votes`, 1); // a counter inside it
console.log((await board.Task.get(task.id)).checklist[0]);
// { step: 'announce', done: true, votes: 1 }
// #endregion children
assert.deepEqual((await board.Task.get(task.id)).checklist[0], { step: 'announce', done: true, votes: 1 });
await board.move(task.id, 'checklist', 0, 2);
assert.equal(await board.elementAt(task.id, 'checklist', 2), first, 'an element keeps its name across a move');
assert.deepEqual((await board.Task.get(task.id)).checklist[2], { step: 'announce', done: true, votes: 1 });
await board.close();

// #region mesh
import { createMesh, settle } from '@alexify/syncom/testing';

// Three nodes in one process: the laptop and the phone each dial the server.
const mesh = await createMesh(
  ['server', 'laptop', 'phone'],
  [
    ['laptop', 'server'],
    ['phone', 'server'],
  ],
  {
    createStorage: (name, options) =>
      createDatabase({ ...options, engine: memoryEngine(), schema: { entities: { Task: {} } } }),
  },
);
const [server, laptop, phone] = ['server', 'laptop', 'phone'].map((name) => mesh.get(name));
// #endregion mesh

// #region concurrent
const { id } = await server.Task.insert({ title: 'Plan the release' });
await server.push(id, 'checklist', ['write', 'ship']);
await settle(mesh.storages); // every node holds [ 'write', 'ship' ]

await laptop.sync.stop(); // both go offline
await phone.sync.stop();
await laptop.splice(id, 'checklist', 1, 0, ['review', 'fix']); // between 'write' and 'ship'
await phone.splice(id, 'checklist', 1, 0, ['test', 'docs']); // the same spot
await laptop.sync.start(); // and come back
await phone.sync.start();
await settle(mesh.storages);

console.log((await laptop.Task.get(id)).checklist);
// [ 'write', 'review', 'fix', 'test', 'docs', 'ship' ] on every node,
// or the two runs the other way round: the order of the node ids decides
// #endregion concurrent
const merged = (await laptop.Task.get(id)).checklist;
assert.deepEqual(merged, (await phone.Task.get(id)).checklist);
assert.deepEqual(merged, (await server.Task.get(id)).checklist);
const laptopFirst = ['write', 'review', 'fix', 'test', 'docs', 'ship'];
const phoneFirst = ['write', 'test', 'docs', 'review', 'fix', 'ship'];
assert.deepEqual(merged, laptop.nodeId < phone.nodeId ? laptopFirst : phoneFirst);

// #region concurrent-move
await server.Task.set(id, { title: 'Plan the release' }); // a fresh list for the next case
await server.push(id, 'checklist', ['write', 'test', 'ship']);
await settle(mesh.storages);

await laptop.sync.stop();
await phone.sync.stop();
await laptop.move(id, 'checklist', 2, 0); // 'ship' first
await new Promise((resolve) => setTimeout(resolve, 10)); // a moment later...
await phone.move(id, 'checklist', 2, 1); // ...'ship' second
await laptop.sync.start();
await phone.sync.start();
await settle(mesh.storages);
console.log((await server.Task.get(id)).checklist); // [ 'write', 'ship', 'test' ]: once, where the newer move put it
// #endregion concurrent-move
assert.deepEqual((await server.Task.get(id)).checklist, ['write', 'ship', 'test']);
assert.deepEqual((await laptop.Task.get(id)).checklist, ['write', 'ship', 'test']);

// #region move-remove
await laptop.sync.stop();
await phone.sync.stop();
await laptop.move(id, 'checklist', 1, 0); // 'ship' first
await phone.splice(id, 'checklist', 1, 1); // 'ship' removed
await laptop.sync.start();
await phone.sync.start();
await settle(mesh.storages);
console.log((await phone.Task.get(id)).checklist); // [ 'ship', 'write', 'test' ]: the move brought it back
// #endregion move-remove
assert.deepEqual((await phone.Task.get(id)).checklist, ['ship', 'write', 'test']);
assert.deepEqual((await server.Task.get(id)).checklist, ['ship', 'write', 'test']);
await mesh.close();
