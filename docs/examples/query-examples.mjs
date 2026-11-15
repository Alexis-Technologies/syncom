// The Query examples page (docs/guide/query-examples.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';

// #region data
const db = await createDatabase({ path: 'board', schema: { entities: { Task: { index: ['done'] } } } });
const ids = (rows) => rows.map((row) => row.id);

await db.Task.bulkInsert([
  {
    id: 'docs',
    title: 'Write the docs',
    done: false,
    priority: 2,
    due: '2026-12-01',
    assignee: { name: 'ada', team: 'core' },
    checklist: [
      { item: 'outline', done: true },
      { item: 'examples', done: false },
    ],
  },
  { id: 'ship', title: 'Ship it', done: false, priority: 3, due: '2026-11-20', assignee: { name: 'bob', team: 'ops' } },
  { id: 'repo', title: 'Set up the repo', done: true, priority: 1, due: '2026-10-01', assignee: null },
  { id: 'issues', title: 'Answer issues', done: false, priority: 1 },
]);
await db.add('docs', 'tags', ['docs', 'writing']); // tags is a set
await db.add('ship', 'tags', ['release']);
await db.add('issues', 'tags', ['support', 'docs']);
await db.inc('docs', 'votes', 4); // votes is a counter
await db.inc('ship', 'votes', 3);
// #endregion data

// #region equality
await db.Task.select({ done: false }).fetch(); // docs, issues, ship
await db.Task.select({ priority: { $eq: 1 } }).fetch(); // issues, repo
await db.Task.select({ priority: { $ne: 1 } }).fetch(); // docs, ship
// #endregion equality
assert.deepEqual(ids(await db.Task.select({ done: false }).fetch()), ['docs', 'issues', 'ship']);
assert.deepEqual(ids(await db.Task.select({ priority: { $eq: 1 } }).fetch()), ['issues', 'repo']);
assert.deepEqual(ids(await db.Task.select({ priority: { $ne: 1 } }).fetch()), ['docs', 'ship']);

// #region in
await db.Task.select({ priority: { $in: [2, 3] } }).fetch(); // docs, ship
await db.Task.select({ priority: { $nin: [2, 3] } }).fetch(); // issues, repo
await db.Task.select({ id: { $in: ['docs', 'repo'] } }).fetch(); // docs, repo: by id
// #endregion in
assert.deepEqual(ids(await db.Task.select({ priority: { $in: [2, 3] } }).fetch()), ['docs', 'ship']);
assert.deepEqual(ids(await db.Task.select({ priority: { $nin: [2, 3] } }).fetch()), ['issues', 'repo']);
assert.deepEqual(ids(await db.Task.select({ id: { $in: ['docs', 'repo'] } }).fetch()), ['docs', 'repo']);

// #region compare
await db.Task.select({ priority: { $gte: 2 } }).fetch(); // docs, ship
await db.Task.select({ due: { $lt: '2026-12-01' } }).fetch(); // repo, ship: ISO dates compare as strings
await db.Task.select({ votes: { $gt: 3 } }).fetch(); // docs: a counter reads as a number
await db.Task.select({ due: { $gt: 0 } }).fetch(); // nothing: a string never compares with a number
// #endregion compare
assert.deepEqual(ids(await db.Task.select({ priority: { $gte: 2 } }).fetch()), ['docs', 'ship']);
assert.deepEqual(ids(await db.Task.select({ due: { $lt: '2026-12-01' } }).fetch()), ['repo', 'ship']);
assert.deepEqual(ids(await db.Task.select({ votes: { $gt: 3 } }).fetch()), ['docs']);
assert.deepEqual(ids(await db.Task.select({ due: { $gt: 0 } }).fetch()), []);

// #region exists
await db.Task.select({ due: { $exists: false } }).fetch(); // issues
await db.Task.select({ assignee: { $exists: true } }).fetch(); // docs, repo, ship: null counts as present
await db.Task.select({ assignee: { $type: 'object' } }).fetch(); // docs, ship
await db.Task.select({ assignee: null }).fetch(); // repo
// #endregion exists
assert.deepEqual(ids(await db.Task.select({ due: { $exists: false } }).fetch()), ['issues']);
assert.deepEqual(ids(await db.Task.select({ assignee: { $exists: true } }).fetch()), ['docs', 'repo', 'ship']);
assert.deepEqual(ids(await db.Task.select({ assignee: { $type: 'object' } }).fetch()), ['docs', 'ship']);
assert.deepEqual(ids(await db.Task.select({ assignee: null }).fetch()), ['repo']);

// #region arrays
await db.Task.select({ tags: 'docs' }).fetch(); // docs, issues: the array holds the value
await db.Task.select({ tags: { $all: ['docs', 'writing'] } }).fetch(); // docs
await db.Task.select({ tags: { $size: 1 } }).fetch(); // ship
await db.Task.select({ tags: ['docs', 'support'] }).fetch(); // issues: the whole array, in order
// #endregion arrays
assert.deepEqual(ids(await db.Task.select({ tags: 'docs' }).fetch()), ['docs', 'issues']);
assert.deepEqual(ids(await db.Task.select({ tags: { $all: ['docs', 'writing'] } }).fetch()), ['docs']);
assert.deepEqual(ids(await db.Task.select({ tags: { $size: 1 } }).fetch()), ['ship']);
assert.deepEqual(ids(await db.Task.select({ tags: ['docs', 'support'] }).fetch()), ['issues']);

// #region elem-match
await db.Task.select({ checklist: { $elemMatch: { item: 'examples', done: false } } }).fetch(); // docs
await db.Task.select({ tags: { $elemMatch: { $regex: '^rel' } } }).fetch(); // ship
// #endregion elem-match
assert.deepEqual(ids(await db.Task.select({ checklist: { $elemMatch: { item: 'examples', done: false } } }).fetch()), [
  'docs',
]);
assert.deepEqual(ids(await db.Task.select({ tags: { $elemMatch: { $regex: '^rel' } } }).fetch()), ['ship']);

// #region regex
await db.Task.select({ title: { $regex: '^write', $options: 'i' } }).fetch(); // docs
await db.Task.select({ title: /it$/ }).fetch(); // nothing: a RegExp as a plain value is equality
await db.Task.select({ title: { $regex: /it$/ } }).fetch(); // ship
// #endregion regex
assert.deepEqual(ids(await db.Task.select({ title: { $regex: '^write', $options: 'i' } }).fetch()), ['docs']);
assert.deepEqual(ids(await db.Task.select({ title: /it$/ }).fetch()), []);
assert.deepEqual(ids(await db.Task.select({ title: { $regex: /it$/ } }).fetch()), ['ship']);

// #region dotted
await db.Task.select({ 'assignee.name': 'ada' }).fetch(); // docs
await db.Task.select({ 'assignee.team': { $in: ['core', 'ops'] } })
  .order('assignee.name')
  .fetch(); // docs, ship
await db.Task.select({ 'checklist.0.item': 'outline' }).fetch(); // docs: an index reaches into an array
// #endregion dotted
assert.deepEqual(ids(await db.Task.select({ 'assignee.name': 'ada' }).fetch()), ['docs']);
assert.deepEqual(
  ids(
    await db.Task.select({ 'assignee.team': { $in: ['core', 'ops'] } })
      .order('assignee.name')
      .fetch(),
  ),
  ['docs', 'ship'],
);
assert.deepEqual(ids(await db.Task.select({ 'checklist.0.item': 'outline' }).fetch()), ['docs']);

// #region logical
await db.Task.select({ $or: [{ priority: 3 }, { tags: 'support' }] }).fetch(); // issues, ship
await db.Task.select({ $and: [{ done: false }, { priority: { $lt: 3 } }] }).fetch(); // docs, issues
await db.Task.select({ $nor: [{ done: true }, { tags: 'docs' }] }).fetch(); // ship
await db.Task.select({ $not: { priority: { $gte: 2 } } }).fetch(); // issues, repo
// #endregion logical
assert.deepEqual(ids(await db.Task.select({ $or: [{ priority: 3 }, { tags: 'support' }] }).fetch()), [
  'issues',
  'ship',
]);
assert.deepEqual(ids(await db.Task.select({ $and: [{ done: false }, { priority: { $lt: 3 } }] }).fetch()), [
  'docs',
  'issues',
]);
assert.deepEqual(ids(await db.Task.select({ $nor: [{ done: true }, { tags: 'docs' }] }).fetch()), ['ship']);
assert.deepEqual(ids(await db.Task.select({ $not: { priority: { $gte: 2 } } }).fetch()), ['issues', 'repo']);

// #region mod
await db.Task.select({ votes: { $mod: [2, 0] } }).fetch(); // docs: 4 votes, an even number
// #endregion mod
assert.deepEqual(ids(await db.Task.select({ votes: { $mod: [2, 0] } }).fetch()), ['docs']);

// #region malformed
try {
  db.Task.select({ priority: { $in: 2 } });
} catch (error) {
  console.log(error.name); // 'TypeError': refused at select(), before anything is read
}
// #endregion malformed
assert.throws(() => db.Task.select({ priority: { $in: 2 } }), { name: 'TypeError' });
await db.close();
