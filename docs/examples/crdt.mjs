// The CRDT page (docs/guide/crdt.md) shows the regions of this file. The three nodes are wired in one process with
// @alexify/syncom/testing's mesh (laptop and phone dial server), so the page can show two nodes editing at once.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';
import { createMesh, memoryEngine, settle } from '@alexify/syncom/testing';

const mesh = await createMesh(
  ['server', 'laptop', 'phone'],
  [
    ['laptop', 'server'],
    ['phone', 'server'],
  ],
  {
    createStorage: (name, options) =>
      createDatabase({
        ...options,
        path: name,
        engine: memoryEngine(),
        logger: false,
        schema: { entities: { Task: { index: ['done'] } } },
      }),
  },
);
const server = mesh.get('server');
const laptop = mesh.get('laptop');
const phone = mesh.get('phone');
const nodes = [server, laptop, phone];
const conflicts = [];
for (const node of nodes) node.on('conflict', (event) => conflicts.push(event));
// #region conflict
for (const node of [server, laptop, phone]) {
  node.on('conflict', (event) => {
    if (event.kind !== 'register') return;
    console.log(`${event.field}: kept "${event.winner.value}", dropped "${event.loser.value}"`);
  });
}
// title: kept "Write the manual", dropped "Write the guide"   (on the nodes that received the older write last)
// #endregion conflict

const task = await server.Task.insert({ title: 'Write the docs', done: false });
await server.updateText(task.id, 'notes', 'Draft');
await settle(mesh.storages);
// Both nodes go offline, so that neither sees the other's edits until they are back.
for (const link of mesh.links.values()) link.disconnect();

// #region laptop
// on the laptop, offline
await laptop.Task.update(task.id, { title: 'Write the guide' }); // a register
await laptop.inc(task.id, 'votes', 1); // a counter
await laptop.add(task.id, 'tags', ['docs']); // a set
await laptop.updateText(task.id, 'notes', 'First draft'); // a text
// #endregion laptop
// The phone writes a moment later, so its stamps are the newer ones.
await new Promise((resolve) => setTimeout(resolve, 5));
// #region phone
// on the phone, offline too
await phone.Task.update(task.id, { title: 'Write the manual' });
await phone.inc(task.id, 'votes', 2);
await phone.add(task.id, 'tags', ['urgent']);
await phone.updateText(task.id, 'notes', 'Draft, reviewed');
// #endregion phone
for (const link of mesh.links.values()) await link.reconnect();
await settle(mesh.storages);

// #region merged
// Once they have synced, every node reads the same task:
console.log(await laptop.Task.get(task.id));
// { title: 'Write the manual', done: false, $type: 'Task',
//   notes: 'First draft, reviewed', votes: 3, tags: [ 'docs', 'urgent' ] }
// #endregion merged
const merged = await laptop.Task.get(task.id);
for (const node of nodes) assert.deepEqual(await node.Task.get(task.id), merged);
assert.equal(merged.votes, 3);
assert.deepEqual(merged.tags, ['docs', 'urgent']);
assert.equal(merged.notes, 'First draft, reviewed');
assert.equal(merged.title, 'Write the manual', 'the phone wrote last, so its stamp is the newest');

assert.ok(
  conflicts.some(
    (event) =>
      event.kind === 'register' &&
      event.field === 'title' &&
      event.winner.value === 'Write the manual' &&
      event.loser.value === 'Write the guide',
  ),
);

await mesh.close();

// #region deltas
import { diff, merge, apply } from '@alexify/syncom';

console.log(diff({ title: 'Draft', tags: ['a'] }, { title: 'Final', tags: ['a', 'b'] }));
// { title: 'Final', tags: [ 'b' ] }        an array is a grow-only set: only what was added

console.log(merge({ hits: 10, tags: ['a'] }, { hits: 1, tags: ['b'], old: undefined }));
// { hits: 11, tags: [ 'a', 'b' ] }         numbers add, arrays join, undefined deletes

console.log(
  apply({ hits: 0 }, [
    { type: 'inc', key: 'hits', value: 5 },
    { type: 'dec', key: 'hits', value: 2 },
  ]),
);
// { hits: 3 }
// #endregion deltas
assert.deepEqual(diff({ title: 'Draft', tags: ['a'] }, { title: 'Final', tags: ['a', 'b'] }), {
  title: 'Final',
  tags: ['b'],
});
assert.deepEqual(merge({ hits: 10, tags: ['a'] }, { hits: 1, tags: ['b'], old: undefined }), {
  hits: 11,
  tags: ['a', 'b'],
});
assert.deepEqual(
  apply({ hits: 0 }, [
    { type: 'inc', key: 'hits', value: 5 },
    { type: 'dec', key: 'hits', value: 2 },
  ]),
  { hits: 3 },
);

// #region numbers-add
console.log(merge({ hits: 10 }, diff({ hits: 10 }, { hits: 3 }))); // { hits: 13 }, not 3
// #endregion numbers-add
assert.deepEqual(merge({ hits: 10 }, diff({ hits: 10 }, { hits: 3 })), { hits: 13 });
