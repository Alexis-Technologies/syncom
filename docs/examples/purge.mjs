// The Purge page (docs/guide/purge.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase, memoryEngine } from '@alexify/syncom/all';
import { createMesh, settle } from '@alexify/syncom/testing';

const mesh = await createMesh(
  ['server', 'laptop', 'phone'],
  [
    ['laptop', 'server'],
    ['phone', 'server'],
  ],
  {
    createStorage: (name, options) =>
      createDatabase({ ...options, engine: memoryEngine(), schema: { entities: { Customer: {} } } }),
  },
);
const [server, laptop, phone] = ['server', 'laptop', 'phone'].map((name) => mesh.get(name));

// #region purge
const ada = await server.Customer.insert({ name: 'Ada Lovelace', email: 'ada@example.com' });
await settle(mesh.storages); // every node holds the record

await laptop.sync.stop(); // the laptop is offline when the request comes in
await server.purge(ada.id, { actor: 'privacy-team' });
await laptop.sync.start(); // and hears of the purge when it is back
await settle(mesh.storages);

console.log(await laptop.Customer.get(ada.id)); // null, here and on every node
console.log(await phone.list()); // []: listed nowhere
// #endregion purge
for (const node of [server, laptop, phone]) assert.equal(await node.get(ada.id), null);
assert.deepEqual(await phone.list(), []);

// #region wins
const bob = await server.Customer.insert({ name: 'Bob', email: 'bob@example.com' });
await settle(mesh.storages);

await phone.sync.stop();
await phone.Customer.update(bob.id, { email: 'bob@new.example.com' }); // offline, a moment before
await server.purge(bob.id); // the purge
await phone.sync.start();
await settle(mesh.storages);
console.log(await phone.Customer.get(bob.id)); // null: the purge wins, whatever the stamps
// #endregion wins
assert.equal(await phone.get(bob.id), null);
assert.equal(await server.get(bob.id), null);

// #region stays
console.log(server.log.entriesOf(ada.id).map(({ op }) => [op.type, op.scrubbed, 'data' in op]));
// [ [ 'write', true, false ], [ 'purge', true, false ] ]: the headers stay, the payload is gone
console.log((await server.history(ada.id)).versions.map((version) => version.data)); // [ null, null ]
// #endregion stays
for (const { op } of server.log.entriesOf(ada.id)) {
  assert.equal(op.scrubbed, true);
  assert.equal(op.data, undefined);
  assert.ok(op.sig, 'the signature stays, so the header still verifies');
}
for (const { op } of laptop.log.entriesOf(ada.id)) assert.equal(op.data, undefined, 'scrubbed on the peer too');

// #region forget
const carol = await server.Customer.insert({ name: 'Carol' });
await settle(mesh.storages);
await laptop.forget(carol.id); // gone from the laptop alone: no op, no peer told
console.log(await laptop.get(carol.id), (await server.get(carol.id)).name); // null 'Carol'
// #endregion forget
assert.equal(await laptop.get(carol.id), null);
assert.equal((await server.get(carol.id)).name, 'Carol');
await mesh.close();
