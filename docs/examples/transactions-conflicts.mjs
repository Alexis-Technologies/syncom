// The Transactions and conflicts page (docs/guide/transactions-conflicts.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';
import { MemoryLink, memoryEngine, settle } from '@alexify/syncom/testing';

const engine = memoryEngine();
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
// #region schema
const schema = {
  entities: {
    Task: { index: ['done'], unique: ['slug'] },
    Stats: {},
  },
};
// #endregion schema
const server = await createDatabase({ engine, path: 'server', schema });
const unit = server.sync.unit({ access: 'public' });
const links = {};
const dial = (name) => () => (links[name] = new MemoryLink(unit));
const open = async (name) => {
  const db = await createDatabase({ engine, path: name, schema, sync: { connect: dial(name) } });
  await db.sync.addNode({ url: 'wss://board.example.com/api' });
  await db.sync.awaitInitialReplication();
  return db;
};
const laptop = await open('laptop');
const phone = await open('phone');
const board = laptop;
await board.Stats.insert({ id: 'stats', name: 'Board totals' });

// #region transact
const task = await board.Task.insert({ title: 'Write the docs', slug: 'docs', done: false, assignee: null });

await board.transact(async (tx) => {
  await tx.update(task.id, { done: true });
  await tx.inc('stats', 'closed', 1);
  console.log((await tx.get(task.id)).done); // true: the transaction reads its own writes
});
// both writes landed together, or neither would have
// #endregion transact
assert.equal((await board.Task.get(task.id)).done, true);
assert.equal((await board.Stats.get('stats')).closed, 1);

// #region rollback
await assert.rejects(
  board.transact(async (tx) => {
    await tx.update(task.id, { done: false });
    throw new Error('changed my mind');
  }),
  /changed my mind/,
);
console.log((await board.Task.get(task.id)).done); // true: nothing of the transaction was written
// #endregion rollback
assert.equal((await board.Task.get(task.id)).done, true);

// #region swap
// Claim the task only if nobody has: the comparison runs in the write queue.
const claimed = await board.swap(task.id, { assignee: 'ada' }, { assignee: null });
const again = await board.swap(task.id, { assignee: 'bob' }, { assignee: null });
console.log(claimed, again); // true false
// #endregion swap
assert.equal(claimed, true);
assert.equal(again, false);
assert.equal((await board.Task.get(task.id)).assignee, 'ada');

// #region if-match
const reopened = await board.Task.update(task.id, { done: false }, { ifMatch: { assignee: 'ada' } });
console.log(reopened); // true: written, because the record matched
// #endregion if-match
assert.equal(reopened, true);

await settle([server, laptop, phone]);

// #region fields
links.phone.disconnect(); // Bob's phone is offline
await phone.Task.update(task.id, { done: true }); // Bob closes the task
await phone.inc(task.id, 'votes', 1);
await phone.add(task.id, 'tags', ['urgent']);

await laptop.Task.update(task.id, { title: 'Write the sync docs' }); // Ada renames it
await laptop.inc(task.id, 'votes', 1);
await laptop.add(task.id, 'tags', ['docs']);

await laptop.sync.awaitDocumentPushed(task.id);
await links.phone.reconnect();
await phone.sync.awaitInSync();
console.log(await phone.Task.get(task.id));
// { title: 'Write the sync docs', slug: 'docs', done: true, assignee: 'ada',
//   '$type': 'Task', votes: 2, tags: [ 'docs', 'urgent' ] }
// #endregion fields
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
await tick();
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
await assert.rejects(board.Task.insert({ title: 'Docs again', slug: 'docs', done: false }), (error) => {
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
