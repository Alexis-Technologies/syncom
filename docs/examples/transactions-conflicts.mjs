// The Transactions and conflicts page (docs/guide/transactions-conflicts.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { settle } from '@alexify/syncom/testing';

// #region nodes
import { createDatabase } from '@alexify/syncom/all';
import { memoryEngine } from '@alexify/syncom/memory';
import { MemoryLink } from '@alexify/syncom/testing';

const engine = memoryEngine(); // every node keeps its data in memory
const schema = {
  entities: {
    Task: { index: ['done'], unique: ['slug'] }, // no two tasks share a slug
    Stats: {}, // the board's totals
  },
};

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
const phone = await open('phone');
// #endregion nodes

// #region transact
const task = await laptop.Task.insert({ title: 'Write the docs', slug: 'docs', done: false, assignee: null });
await laptop.Stats.insert({ id: 'stats', name: 'Board totals' }); // `closed` is born below, as a counter

await laptop.transact(
  async (tx) => {
    await tx.update(task.id, { done: true });
    await tx.inc('stats', 'closed', 1);
    console.log((await tx.get(task.id)).done); // true: the transaction reads its own writes
  },
  { message: 'Close the docs task' }, // rides on both ops, to every node
);
// #endregion transact
assert.equal((await laptop.Task.get(task.id)).done, true);
assert.equal((await laptop.Stats.get('stats')).closed, 1);
assert.equal((await laptop.history(task.id)).versions[0].message, 'Close the docs task');

// A throw leaves nothing written (the Database page shows it).
await assert.rejects(
  laptop.transact(async (tx) => {
    await tx.update(task.id, { done: false });
    throw new Error('changed my mind');
  }),
  /changed my mind/,
);
assert.equal((await laptop.Task.get(task.id)).done, true);

// #region swap
// Claim the task only if nobody has: the comparison runs in the write queue.
const claimed = await laptop.swap(task.id, { assignee: 'ada' }, { assignee: null });
const again = await laptop.swap(task.id, { assignee: 'bob' }, { assignee: null });
console.log(claimed, again); // true false
// #endregion swap
assert.equal(claimed, true);
assert.equal(again, false);
assert.equal((await laptop.Task.get(task.id)).assignee, 'ada');

// #region if-match
// Reopen the task only if it is still Ada's and still closed.
const reopened = await laptop.Task.update(task.id, { done: false }, { ifMatch: { assignee: 'ada', done: true } });
console.log(reopened); // true: written, because the record matched
console.log(await laptop.Task.update(task.id, { done: true }, { ifMatch: { assignee: 'bob' } })); // false
// #endregion if-match
assert.equal(reopened, true);
assert.equal((await laptop.Task.get(task.id)).done, false);

await settle([server, laptop, phone]);

// The offline merge the page summarizes (Fields that merge shows it with code).
links.phone.disconnect();
await phone.Task.update(task.id, { done: true });
await phone.inc(task.id, 'votes', 1);
await phone.add(task.id, 'tags', ['urgent']);
await laptop.Task.update(task.id, { title: 'Write the sync docs' });
await laptop.inc(task.id, 'votes', 1);
await laptop.add(task.id, 'tags', ['docs']);
await laptop.sync.awaitDocumentPushed(task.id);
await links.phone.reconnect();
await phone.sync.awaitInSync();
const merged = {
  title: 'Write the sync docs',
  slug: 'docs',
  done: true,
  assignee: 'ada',
  $type: 'Task',
  votes: 2,
  tags: ['docs', 'urgent'],
};
assert.deepEqual(await phone.Task.get(task.id), merged);
await settle([server, laptop, phone]);
assert.deepEqual(await laptop.Task.get(task.id), merged);

// #region conflict
laptop.on('conflict', (event) => {
  if (event.kind === 'register') {
    console.log(event.field, 'kept', event.winner.value, 'over', event.loser.value);
  }
});
// #endregion conflict
const lost = [];
laptop.on('conflict', (event) => lost.push(event));

// #region same-field
links.phone.disconnect();
await phone.Task.update(task.id, { assignee: 'bob' }); // made first, offline
await new Promise((resolve) => setTimeout(resolve, 5)); // a moment later, on the laptop
await laptop.Task.update(task.id, { assignee: 'cy' }); // made later, online
await laptop.sync.awaitDocumentPushed(task.id);
await links.phone.reconnect();
// on the laptop: assignee kept cy over bob
// #endregion same-field
await settle([server, laptop, phone]);
assert.equal((await phone.Task.get(task.id)).assignee, 'cy');
assert.equal((await laptop.Task.get(task.id)).assignee, 'cy');
assert.equal(lost.length, 1);
assert.equal(lost[0].kind, 'register');
assert.equal(lost[0].field, 'assignee');
assert.equal(lost[0].winner.value, 'cy');
assert.equal(lost[0].loser.value, 'bob');

// #region remove
links.phone.disconnect();
await phone.remove(task.id, 'tags', ['urgent']); // Bob takes 'urgent' off
await laptop.add(task.id, 'tags', ['urgent']); // Ada adds it again at the same time
await laptop.sync.awaitDocumentPushed(task.id);
await links.phone.reconnect();
await phone.sync.awaitInSync();
console.log((await phone.Task.get(task.id)).tags); // [ 'docs', 'urgent' ]: Ada's add was not seen by Bob's remove
// #endregion remove
assert.deepEqual((await phone.Task.get(task.id)).tags, ['docs', 'urgent']);
await settle([server, laptop, phone]);

// #region unique-local
await assert.rejects(laptop.Task.insert({ title: 'Docs again', slug: 'docs', done: false }), (error) => {
  console.log(error.code, error.issues[0].code); // VALIDATION_FAILED unique
  return true;
});
// #endregion unique-local

// #region unique-remote
links.phone.disconnect();
const fromPhone = await phone.Task.insert({ title: 'Release notes', slug: 'notes', done: false });
const fromLaptop = await laptop.Task.insert({ title: 'Notes for the release', slug: 'notes', done: false });
await laptop.sync.awaitDocumentPushed(fromLaptop.id);
await links.phone.reconnect();
// on the laptop, once the phone's task arrives:
// conflict { kind: 'unique', entity: 'Task', fields: [ 'slug' ], id: <the phone's task>, other: <the laptop's> }
// #endregion unique-remote
await settle([server, laptop, phone]);
const uniques = lost.filter((event) => event.kind === 'unique');
assert.ok(uniques.length >= 1);
assert.equal(uniques[0].entity, 'Task');
assert.equal(uniques[0].id, fromPhone.id);
assert.equal(uniques[0].other, fromLaptop.id);
assert.equal((await laptop.Task.select({ slug: 'notes' }).fetch()).length, 2); // both kept

await phone.close();
await laptop.close();
await server.close();
