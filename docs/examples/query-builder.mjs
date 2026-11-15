// The Query builder page (docs/guide/query-builder.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';

const db = await createDatabase({
  path: 'board',
  schema: { entities: { Task: { index: ['done'], refs: { assignee: 'Member' } }, Member: {} } },
});
await db.Member.insert({ id: 'ada', name: 'Ada Lovelace' });
await db.Task.bulkInsert([
  { id: 't1', title: 'Write the docs', done: false, priority: 2, due: '2026-12-01', assignee: 'ada' },
  { id: 't2', title: 'Ship it', done: false, priority: 3, due: '2026-11-20' },
  { id: 't3', title: 'Set up the repo', done: true, priority: 1, due: '2026-10-01' },
  { id: 't4', title: 'Answer issues', done: false, priority: 2, due: '2026-11-25', assignee: 'ada' },
]);

// #region chain
const rows = await db.Task.select({ done: false, priority: { $gte: 2 } })
  .desc('priority')
  .order('due')
  .limit(2)
  .projection(['title', 'due'])
  .fetch();
console.log(rows);
// [ { id: 't2', title: 'Ship it', due: '2026-11-20' },
//   { id: 't4', title: 'Answer issues', due: '2026-11-25' } ]
// #endregion chain
assert.deepEqual(rows, [
  { id: 't2', title: 'Ship it', due: '2026-11-20' },
  { id: 't4', title: 'Answer issues', due: '2026-11-25' },
]);

// #region reuse
const open = db.Task.select({ done: false });
const soonest = open.order('due').limit(1); // a new cursor
const urgent = open.desc('priority').limit(1); // another one; `open` is unchanged
console.log((await soonest.one()).id, (await urgent.one()).id, await open.count()); // t2 t2 3
// #endregion reuse
assert.equal((await soonest.one()).id, 't2');
assert.equal((await urgent.one()).id, 't2');
assert.equal(await open.count(), 3);

// #region compose
const find = ({ done, minPriority, assignee } = {}) => {
  const query = {};
  if (done !== undefined) query.done = done;
  if (minPriority !== undefined) query.priority = { $gte: minPriority };
  if (assignee !== undefined) query.assignee = assignee;
  return db.Task.select(query).order('due');
};
console.log((await find({ done: false, assignee: 'ada' }).fetch()).map((row) => row.id)); // [ 't4', 't1' ]
// #endregion compose
assert.deepEqual(
  (await find({ done: false, assignee: 'ada' }).fetch()).map((row) => row.id),
  ['t4', 't1'],
);
assert.deepEqual(
  (await find({ minPriority: 3 }).fetch()).map((row) => row.id),
  ['t2'],
);

// #region filter
const long = await db.Task.select({ done: false })
  .filter((row) => row.title.split(' ').length > 2)
  .fetch();
console.log(long.map((row) => row.title)); // [ 'Write the docs' ]
// #endregion filter
assert.deepEqual(
  long.map((row) => row.title),
  ['Write the docs'],
);

// #region populate
const withPeople = await db.Task.select({ assignee: 'ada' }).order('due').populate(['assignee']).fetch();
console.log(withPeople[0].assignee); // { name: 'Ada Lovelace', $type: 'Member', id: 'ada' }
// #endregion populate
assert.deepEqual(withPeople[0].assignee, { name: 'Ada Lovelace', $type: 'Member', id: 'ada' });
await db.close();
