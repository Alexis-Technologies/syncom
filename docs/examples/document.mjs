// The Document page (docs/guide/document.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';

const db = await createDatabase({ path: 'board', schema: { entities: { Task: { index: ['done'] } } } });
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

// #region open
const task = await db.Task.insert({ title: 'Write the docs', done: false });
console.log(task.id, task.title, task.done); // '…' 'Write the docs' false

const again = await db.Task.document(task.id);
console.log(again === task); // true: one live document per record
// #endregion open
assert.equal(again, task);

// #region save
task.title = 'Write the guide';
console.log(task.delta()); // { title: 'Write the guide' }: staged, not written yet
await task.save(); // one write with every staged change
console.log(await db.Task.get(task.id)); // { title: 'Write the guide', done: false, $type: 'Task' }
// #endregion save
assert.deepEqual(await db.Task.get(task.id), { title: 'Write the guide', done: false, $type: 'Task' });
assert.deepEqual(task.delta(), {});

// #region kinds
await task.inc('votes', 1); // a counter
await task.add('tags', ['docs', 'urgent']); // a set
await task.remove('tags', ['urgent']);
console.log(task.votes, task.tags); // 1 [ 'docs' ]
// #endregion kinds
assert.equal(task.votes, 1);
assert.deepEqual(task.tags, ['docs']);

// #region not-a-register
const voted = await db.Task.insert({ title: 'Vote on me', done: false });
await voted.inc('votes', 1);
voted.votes = 10;
await voted.save().catch((error) => console.log(error.code)); // 'FIELD_KIND': votes is a counter
// #endregion not-a-register
await assert.rejects(() => voted.save(), { code: 'FIELD_KIND' });
assert.deepEqual(voted.delta(), { votes: 10 }); // a refused save keeps what was staged

// #region events
task.on('update', (data, delta) => console.log('update', delta));
task.title = 'Write the user guide'; // update { title: 'Write the user guide' }
await task.save();
await db.Task.update(task.id, { done: true }); // a write from elsewhere: update { done: true }
// #endregion events
await tick();
assert.equal(task.done, true);
task.clear('update');

// #region elsewhere
task.title = 'Typed, not saved yet';
await db.Task.update(task.id, { done: false }); // another part of the app, or a peer
await tick();
console.log(task.done, task.title); // false 'Typed, not saved yet': the staged edit stays on top
await task.save();
// #endregion elsewhere
assert.equal(task.done, false);
assert.equal((await db.Task.get(task.id)).title, 'Typed, not saved yet');

// #region observe
const stop = task.observe('votes', (changes) => console.log(changes));
await db.inc(task.id, 'votes', 2);
// [ { id: '…', action: 'inc', field: 'votes', value: 2 } ]
stop();
// #endregion observe
await tick();
assert.equal(task.votes, 3);

// #region delete
const doomed = await db.Task.insert({ title: 'Duplicate task', done: false });
doomed.on('update', (data) => console.log('deleted:', data === null)); // deleted: true
await db.Task.delete(doomed.id);
console.log(await doomed.data()); // null
// #endregion delete
await tick();
assert.equal(await doomed.data(), null);
await db.close();
