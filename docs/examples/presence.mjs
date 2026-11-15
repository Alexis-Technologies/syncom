// The Presence page (docs/guide/presence.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';
import { createMesh, memoryEngine, settle, waitUntil } from '@alexify/syncom/testing';

// One process stands in for the network: the laptop and the phone dial the server.
const engine = memoryEngine();
const schema = { entities: { Task: {} } };
const mesh = await createMesh(
  ['server', 'laptop', 'phone'],
  [
    ['laptop', 'server'],
    ['phone', 'server'],
  ],
  { createStorage: (name, options) => createDatabase({ ...options, engine, path: name, schema }) },
);
const [server, laptop, phone] = mesh.storages.values();
await settle(mesh.storages);

// #region create
import { createPresence } from '@alexify/syncom/presence';

const here = createPresence(laptop, { timeout: 30_000 }); // a state lives 30 s without a renewal
laptop.sync.presence(here); // carried to and from every host the laptop dials

const there = createPresence(phone);
phone.sync.presence(there);
// #endregion create

// #region listen
there.on('change', ({ added, updated, removed }) => {
  for (const node of added) console.log(there.get(node).name, 'is here');
  for (const node of removed) console.log(node, 'left');
});
// #endregion listen

// #region set
const task = await laptop.Task.insert({ title: 'Write the docs', done: false });
await laptop.splice(task.id, 'notes', 0, 0, 'Add screenshots of the board');

await here.set({ name: 'Ada', color: '#7c3aed', task: task.id, caret: await laptop.cursor(task.id, 'notes', 4) });
// #endregion set
await settle(mesh.storages);

await waitUntil(() => there.get(laptop.nodeId) !== undefined);

// #region read
const ada = there.get(laptop.nodeId);
console.log(ada.name, 'is on', ada.task); // Ada is on <the task's id>
console.log(await phone.position(ada.task, 'notes', ada.caret)); // { index: 4, side: 'before' }
// #endregion read
assert.equal(ada.name, 'Ada');
assert.equal((await phone.position(ada.task, 'notes', ada.caret)).index, 4);

// #region caret-moves
await phone.splice(task.id, 'notes', 0, 0, 'TODO: '); // Bob types before Ada's caret
await settle(mesh.storages);
console.log((await laptop.position(task.id, 'notes', ada.caret)).index); // 10: the caret moved with the text
// #endregion caret-moves
assert.equal((await laptop.position(task.id, 'notes', ada.caret)).index, 10);

// #region leave
await here.delete(); // Ada closes the task: everyone sees her state go
// #endregion leave
await waitUntil(() => there.get(laptop.nodeId) === undefined);
assert.equal(laptop.log.length + phone.log.length > 0, true);
const logged = [];
for (const db of [server, laptop, phone]) {
  for (const entry of db.log.since(db.log.formatId(0))) logged.push(entry.op.type);
}
assert.ok(
  logged.every((type) => type !== 'presence'),
  'nothing of presence is logged',
);

// #region encode
// Over a transport of your own (a BroadcastChannel between tabs, a WebRTC room):
const channel = new BroadcastChannel('board-presence');
here.on('update', (update) => channel.postMessage(update)); // this node's state, signed when it can sign
channel.onmessage = ({ data }) => void there.apply(data); // the newest per node; a forged one is dropped
// #endregion encode
channel.close();

await here.destroy();
await there.destroy();
await mesh.close();
