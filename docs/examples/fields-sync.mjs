// The Fields that merge page (docs/guide/fields.md) shows the regions of this file: two nodes that edit one task
// while they cannot reach each other. tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { settle } from '@alexify/syncom/testing';

// #region nodes
import { createDatabase } from '@alexify/syncom/all';
import { memoryEngine } from '@alexify/syncom/memory';
import { MemoryLink } from '@alexify/syncom/testing';

const engine = memoryEngine(); // every node keeps its data in memory
const schema = { entities: { Task: {} } };

// The server hosts: its unit answers the nodes that dial it.
const server = await createDatabase({ engine, path: 'server', schema });
const unit = server.sync.unit({ access: 'public' }); // any connection may say hello

// A node that dials the server. MemoryLink is a test stand-in for the network: an app's
// connect returns createWrpcLink(await WrpcClient.connect(node.url)) instead.
const links = {};
const open = async (name) => {
  const db = await createDatabase({
    engine,
    path: name,
    schema,
    sync: { connect: () => (links[name] = new MemoryLink(unit)) },
  });
  await db.sync.addNode({ url: 'mem://server' });
  await db.sync.awaitInitialReplication(); // the node's first sync with the server
  return db;
};

const laptop = await open('laptop');
const task = await laptop.Task.insert({ title: 'Write the docs', done: false });
await laptop.add(task.id, 'tags', ['docs']);
await laptop.sync.awaitDocumentPushed(task.id); // the server holds the task
const phone = await open('phone'); // its first sync brings the task down
// #endregion nodes
assert.deepEqual(await phone.Task.get(task.id), {
  title: 'Write the docs',
  done: false,
  $type: 'Task',
  tags: ['docs'],
});

// #region offline
links.phone.disconnect(); // the train goes into a tunnel

await laptop.Task.update(task.id, { title: 'Write the user guide' }); // a register
await phone.Task.update(task.id, { done: true }); // another register of the same task
await laptop.inc(task.id, 'votes', 1); // both vote: a counter
await phone.inc(task.id, 'votes', 1);
await laptop.add(task.id, 'tags', ['writing']); // both tag: a set
await phone.add(task.id, 'tags', ['urgent']);
await laptop.Task.update(task.id, { 'assignee/name': 'ada' }); // two paths under one prefix
await phone.Task.update(task.id, { 'assignee/team': 'core' });

await links.phone.reconnect(); // back online: each node receives what the other did
// #endregion offline
await settle([server, laptop, phone]);

// #region merged
console.log(await laptop.Task.get(task.id));
// { title: 'Write the user guide', done: true, $type: 'Task', tags: [ 'docs', 'urgent', 'writing' ],
//   votes: 2, assignee: { name: 'ada', team: 'core' } }
console.log(await phone.Task.get(task.id)); // the same, field for field
// #endregion merged
const expected = {
  title: 'Write the user guide',
  done: true,
  $type: 'Task',
  tags: ['docs', 'urgent', 'writing'],
  votes: 2,
  assignee: { name: 'ada', team: 'core' },
};
assert.deepEqual(await laptop.Task.get(task.id), expected);
assert.deepEqual(await phone.Task.get(task.id), expected);

// #region same-field
links.phone.disconnect();
await laptop.Task.update(task.id, { title: 'Draft the guide' });
await new Promise((resolve) => setTimeout(resolve, 5)); // a moment later, on the other device
await phone.Task.update(task.id, { title: 'Publish the guide' });
await links.phone.reconnect();
// #endregion same-field
await settle([server, laptop, phone]);
const titles = [(await laptop.Task.get(task.id)).title, (await phone.Task.get(task.id)).title];
console.log(titles); // [ 'Publish the guide', 'Publish the guide' ]: the later write, on both
assert.deepEqual(titles, ['Publish the guide', 'Publish the guide']);

// #region delete
links.phone.disconnect();
await laptop.Task.delete(task.id); // Ada deletes the task
await new Promise((resolve) => setTimeout(resolve, 5)); // a moment later, on the other device
await phone.Task.update(task.id, { done: false }); // Bob, offline, reopens it
await phone.inc(task.id, 'votes', 1); // and votes for it
await links.phone.reconnect();
// #endregion delete
await settle([server, laptop, phone]);
assert.equal(await laptop.get(task.id), null);
assert.equal(await phone.get(task.id), null);
await assert.rejects(phone.inc(task.id, 'votes', 1), { code: 'ALX_ERR_NOT_FOUND' });

// #region revived
console.log(await laptop.Task.get(task.id)); // null: the delete wins over Bob's later edits
console.log(await phone.Task.get(task.id)); // null on Bob's device too
await phone.Task.update(task.id, { done: true }).catch((error) => console.log(error.code)); // ALX_ERR_NOT_FOUND

await phone.Task.set(task.id, { title: 'Write the docs', done: false }); // a whole-record write brings it back
// #endregion revived
await settle([server, laptop, phone]);
const back = { title: 'Write the docs', done: false, $type: 'Task' };
assert.deepEqual(await laptop.Task.get(task.id), back);
assert.deepEqual(await phone.Task.get(task.id), back);

// The other order: an edit made before the delete loses to it, and the record stays deleted.
const older = await laptop.Task.insert({ title: 'Book the room', done: false });
await settle([server, laptop, phone]);
links.phone.disconnect();
await phone.Task.update(older.id, { done: true });
await new Promise((resolve) => setTimeout(resolve, 5));
await laptop.Task.delete(older.id);
await links.phone.reconnect();
await settle([server, laptop, phone]);
assert.equal(await laptop.get(older.id), null);
assert.equal(await phone.get(older.id), null);

await phone.close();
await laptop.close();
await server.close();
