// The Fields that merge page (docs/guide/fields.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';

const db = await createDatabase({ path: 'board', schema: { entities: { Task: {} } } });

// #region register
const task = await db.Task.insert({ title: 'Write the docs', done: false });
await db.Task.update(task.id, { done: true }); // `done` keeps the last value written
// #endregion register
assert.equal((await db.Task.get(task.id)).done, true);

// #region counter
await db.inc(task.id, 'votes', 1); // the first inc() makes `votes` a counter
await db.inc(task.id, 'votes', 2);
await db.inc(task.id, 'votes', -1);
console.log((await db.Task.get(task.id)).votes); // 2
// #endregion counter
assert.equal((await db.Task.get(task.id)).votes, 2);

// #region set
await db.add(task.id, 'tags', ['docs', 'urgent']); // the first add() makes `tags` a set
await db.add(task.id, 'tags', ['docs', 'writing']); // already there: kept once
await db.remove(task.id, 'tags', ['urgent']);
console.log((await db.Task.get(task.id)).tags); // [ 'docs', 'writing' ]
// #endregion set
assert.deepEqual((await db.Task.get(task.id)).tags, ['docs', 'writing']);

// #region one-kind
try {
  await db.Task.update(task.id, { votes: 10 });
} catch (error) {
  console.log(error.code, error.kind); // 'FIELD_KIND' 'counter'
}
// #endregion one-kind
await assert.rejects(() => db.Task.update(task.id, { votes: 10 }), { code: 'FIELD_KIND', kind: 'counter' });

// #region paths
await db.Task.update(task.id, { 'assignee/name': 'ada' }); // a field of its own under `assignee`
await db.Task.update(task.id, { 'assignee/team': 'core' }); // another one beside it
await db.inc(task.id, 'stats/views', 1); // a counter under a prefix
const { assignee, stats } = await db.Task.get(task.id);
console.log(assignee, stats); // { name: 'ada', team: 'core' } { views: 1 }
// #endregion paths
assert.deepEqual(assignee, { name: 'ada', team: 'core' });
assert.deepEqual(stats, { views: 1 });

// #region operators
await db.Task.update(task.id, {
  $inc: { votes: 1 }, // inc() on the counter
  $addToSet: { tags: 'review' }, // add() on the set
  $set: { 'assignee/team': 'docs' }, // a register, by path
});
console.log(await db.Task.get(task.id));
// { title: 'Write the docs', done: true, $type: 'Task', votes: 3,
//   tags: [ 'docs', 'review', 'writing' ], assignee: { name: 'ada', team: 'docs' }, stats: { views: 1 } }
// #endregion operators
assert.deepEqual(await db.Task.get(task.id), {
  title: 'Write the docs',
  done: true,
  $type: 'Task',
  votes: 3,
  tags: ['docs', 'review', 'writing'],
  assignee: { name: 'ada', team: 'docs' },
  stats: { views: 1 },
});

// #region unset
await db.Task.unset(task.id, ['votes', 'stats']); // a field of any kind, and everything under a prefix
console.log(Object.keys(await db.Task.get(task.id))); // [ 'title', 'done', '$type', 'tags', 'assignee' ]
await db.inc(task.id, 'votes', 1); // a new counter, from zero
// #endregion unset
assert.deepEqual(Object.keys(await db.Task.get(task.id)).sort(), [
  '$type',
  'assignee',
  'done',
  'tags',
  'title',
  'votes',
]);
assert.equal((await db.Task.get(task.id)).votes, 1);

// #region whole
await db.Task.set(task.id, { title: 'Write the docs', done: false }); // a whole-record write
console.log(await db.Task.get(task.id)); // { title: 'Write the docs', done: false, $type: 'Task' }
// #endregion whole
assert.deepEqual(await db.Task.get(task.id), { title: 'Write the docs', done: false, $type: 'Task' });
await db.close();
