// The Collection page (docs/guide/collection.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';

// #region define
const db = await createDatabase({
  path: 'board',
  schema: { entities: { Task: { index: ['done'] }, Member: {} } },
});
console.log(Object.keys(db.collections)); // [ 'Task', 'Member' ]
console.log(db.Task === db.collections.Task); // true
// #endregion define
assert.deepEqual(Object.keys(db.collections), ['Task', 'Member']);

// #region insert
const task = await db.Task.insert({ title: 'Write the docs', done: false });
console.log(task.id); // a UUID
console.log(await db.Task.get(task.id)); // { title: 'Write the docs', done: false, $type: 'Task' }

const named = await db.Task.insert({ id: 'ship-it', title: 'Ship it', done: false });
console.log(named.id); // 'ship-it': the id came from the data
// #endregion insert
assert.deepEqual(await db.Task.get(task.id), { title: 'Write the docs', done: false, $type: 'Task' });
assert.deepEqual(await db.Task.get('ship-it'), { title: 'Ship it', done: false, $type: 'Task' });

// #region split
await db.inc(named.id, 'votes', 1); // a counter: the database's inc(), by id
await db.add(named.id, 'tags', ['release', 'urgent']); // a set: the database's add()
await db.remove(named.id, 'tags', ['urgent']); // takes 'urgent' out of the set, and nothing else
const record = await db.Task.get(named.id);
console.log(record.votes, record.tags, record.id); // 1 [ 'release' ] undefined: get() returns the record alone

const [row] = await db.Task.select({ title: 'Ship it' }).fetch();
console.log(row.id); // 'ship-it': a query's rows carry the id
// #endregion split
assert.deepEqual(await db.Task.get(named.id), {
  title: 'Ship it',
  done: false,
  $type: 'Task',
  votes: 1,
  tags: ['release'],
});
assert.equal(row.id, 'ship-it');
assert.equal('id' in record, false);
await assert.rejects(() => db.Task.remove('ship-it'), TypeError); // never a by-id call that empties the collection
assert.equal(typeof (await db.insert({ note: 'by id' })), 'string', "the database's insert() resolves to an id");

// #region upsert
await db.Task.upsert({ id: 'ship-it', title: 'Ship it on Friday', done: false }); // written whole
const same = await db.Task.insertIfAbsent({ id: 'ship-it', title: 'Ignored' }); // already there
console.log(same.title); // 'Ship it on Friday'
// #endregion upsert
assert.equal(same.title, 'Ship it on Friday');
assert.deepEqual(await db.Task.get('ship-it'), { title: 'Ship it on Friday', done: false, $type: 'Task' }); // reset

// #region update
await db.Task.update(task.id, { done: true });
await db.Task.update(task.id, { $set: { owner: 'ada' }, $inc: { votes: 1 } });
await db.Task.unset(task.id, 'owner');
const after = await db.Task.modify(task.id, (draft) => {
  draft.title = draft.title.toUpperCase();
});
console.log(after); // { title: 'WRITE THE DOCS', done: true, $type: 'Task', votes: 1 }
// #endregion update
assert.deepEqual(after, { title: 'WRITE THE DOCS', done: true, $type: 'Task', votes: 1 });

// #region delete
await db.Task.delete('ship-it', { data: { reason: 'merged into another task' } });
console.log(await db.Task.get('ship-it')); // null
// #endregion delete
assert.equal(await db.Task.get('ship-it'), null);

// #region bulk
const { success, error } = await db.Task.bulkInsert([
  { id: 'plan', title: 'Plan the release', done: false },
  { id: 'announce', title: 'Announce it', done: false },
  { id: 'plan', title: 'A second plan', done: false }, // the id is taken by the first row
]);
console.log(success); // [ 'plan', 'announce' ]
console.log(error.map((failure) => [failure.index, failure.id, failure.error.code])); // [ [ 2, 'plan', 'ALX_ERR_EXISTS' ] ]
await db.Task.bulkRemove(['announce']);
// #endregion bulk
assert.deepEqual(success, ['plan', 'announce']);
assert.deepEqual(
  error.map((failure) => [failure.index, failure.id, failure.error.code]),
  [[2, 'plan', 'ALX_ERR_EXISTS']],
);
assert.equal(await db.Task.get('announce'), null);

// #region read
const found = await db.Task.findByIds([task.id, 'plan', 'nope']);
console.log([...found.keys()]); // [ task.id, 'plan' ]: a Map of the live records
const live = await db.Task.document('plan'); // a live Document
console.log(live.title); // 'Plan the release'
// #endregion read
assert.deepEqual([...found.keys()].sort(), [task.id, 'plan'].sort());
assert.equal(live.title, 'Plan the release');

// #region foreign
const ada = await db.Member.insert({ name: 'Ada' });
console.log(await db.Task.get(ada.id)); // null: the record is a Member
await db.Task.update(ada.id, { done: true }).catch((refusal) => console.log(refusal.code)); // 'ALX_ERR_NOT_FOUND'
// #endregion foreign
assert.equal(await db.Task.get(ada.id), null);
await assert.rejects(() => db.Task.update(ada.id, { done: true }), { code: 'ALX_ERR_NOT_FOUND' });

// #region events
db.Task.on('change', ({ id, action }) => console.log(action, id));
const quick = await db.Task.insert({ title: 'Review', done: false }); // insert <id>
await db.Task.update(quick.id, { done: true }); // update <id>
await db.Task.delete(quick.id); // remove <id>
// #endregion events
const heard = [];
db.Task.on('change', ({ action }) => heard.push(action));
const more = await db.Task.insert({ title: 'Listen', done: false });
await db.Task.delete(more.id);
await new Promise((resolve) => setTimeout(resolve, 10));
assert.deepEqual(heard, ['insert', 'remove']);
db.Task.clear();

// #region runtime
await db.addCollections({ Tag: { index: ['label'] } });
await db.Tag.insert({ label: 'docs' });
console.log(Object.keys(db.collections)); // [ 'Task', 'Member', 'Tag' ]

const { removed } = await db.Tag.remove(); // deletes every Tag record; the collection stays
db.removeCollection('Tag'); // forgets the collection; records it still had would stay
console.log(removed, db.Tag); // 1 undefined
// #endregion runtime
assert.equal(removed, 1);
assert.equal(db.Tag, undefined);

// #region outside
const loose = await db.insert({ note: 'In no collection' }); // the database's insert() resolves to the id
console.log(await db.get(loose)); // { note: 'In no collection' }
await db.Task.set(loose, { title: 'Now a task', done: false }); // joins Task
console.log(await db.Task.get(loose)); // { title: 'Now a task', done: false, $type: 'Task' }
// #endregion outside
assert.deepEqual(await db.Task.get(loose), { title: 'Now a task', done: false, $type: 'Task' });
await db.close();
