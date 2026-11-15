// The Query optimizer page (docs/guide/query-optimizer.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
// #region open
import { createDatabase } from '@alexify/syncom/all';

const schema = {
  entities: {
    // A field, and a compound key: tasks of a board in rank order.
    Task: { index: ['done', ['boardId', 'rank']] },
  },
};
const db = await createDatabase({ path: 'board', schema });
// #endregion open
for (let i = 0; i < 20; i++) {
  await db.Task.insert({
    boardId: `b${i % 4}`,
    rank: i,
    done: i % 3 === 0,
    title: `Task ${i}`,
    owner: i % 2 === 1 ? 'ada' : 'lin',
  });
}

// #region explain
const plan = db.Task.select({ boardId: 'b1', rank: { $gte: 10 } })
  .order('rank')
  .limit(4)
  .explain();
console.log(plan);
// {
//   scan: 'index', index: [ 'boardId', 'rank' ], prefix: [ 'b1' ], in: null,
//   range: { field: 'rank', lower: { value: 10, inclusive: true }, upper: null },
//   desc: false, sortedByIndex: true, covered: false, residual: false,
//   narrow: [], estimate: 2, sealed: 0,
//   uses: { equalities: [ 'boardId' ], ranges: [ 'rank' ], order: [ 'rank' ] }
// }
// #endregion explain
assert.equal(plan.scan, 'index');
assert.deepEqual(plan.index, ['boardId', 'rank']);
assert.deepEqual(plan.prefix, ['b1']);
assert.deepEqual(plan.range, { field: 'rank', lower: { value: 10, inclusive: true }, upper: null });
assert.equal(plan.sortedByIndex, true);
assert.equal(plan.residual, false);
assert.equal(plan.estimate, 2);

// #region in
db.Task.select({ boardId: { $in: ['b1', 'b2'] } }).explain();
// scan: 'index', in: { field: 'boardId', values: [ 'b1', 'b2' ] }: one scan per board
// #endregion in
assert.deepEqual(db.Task.select({ boardId: { $in: ['b1', 'b2'] } }).explain().in, {
  field: 'boardId',
  values: ['b1', 'b2'],
});

// #region residual
db.Task.select({ done: true, owner: 'ada' }).explain();
// scan: 'index', index: [ 'done' ], residual: true: owner is tested on each record the index yields
// #endregion residual
const residual = db.Task.select({ done: true, owner: 'ada' }).explain();
assert.deepEqual([residual.scan, residual.index, residual.residual], ['index', ['done'], true]);

// #region unserved
db.Task.select({ boardId: 'b1' }).order('title').explain();
// scan: 'index', sortedByIndex: false: the board's tasks are read, then sorted by title
db.Task.select({ owner: 'ada' }).explain();
// scan: 'collection', estimate: 20: owner has no index, every task is a candidate
// #endregion unserved
const sortAfter = db.Task.select({ boardId: 'b1' }).order('title').explain();
assert.deepEqual([sortAfter.scan, sortAfter.sortedByIndex], ['index', false]);
const scan = db.Task.select({ owner: 'ada' }).explain();
assert.deepEqual([scan.scan, scan.estimate], ['collection', 20]);

// #region covered
const doneOnly = db.Task.select({ done: true }).projection(['done']);
console.log(doneOnly.explain().covered); // true: done is indexed, so no record is read
// #endregion covered
assert.equal(doneOnly.explain().covered, true);
assert.equal(db.Task.select({ done: true }).explain().covered, false);

// #region advisor
import { indexAdvisor } from '@alexify/syncom/inspect';

const advisor = indexAdvisor(db);
// ... the app runs its queries ...
await db.Task.select({ owner: 'ada' }).order('rank').limit(5).fetch();
await db.Task.select({ owner: 'lin' }).order('rank').limit(5).fetch();
await db.Task.select({ boardId: 'b1' }).order('title').fetch();
await db.Task.select({ boardId: 'b2', rank: { $gte: 3 } })
  .order('rank')
  .fetch(); // served by ['boardId', 'rank']

console.log(advisor.suggest());
// [
//   { entity: 'Task', index: [ 'owner', 'rank' ], queries: 2 },
//   { entity: 'Task', index: [ 'boardId', 'title' ], queries: 1 }
// ]
advisor.stop();
// #endregion advisor
assert.deepEqual(advisor.suggest(), [
  { entity: 'Task', index: ['owner', 'rank'], queries: 2 },
  { entity: 'Task', index: ['boardId', 'title'], queries: 1 },
]);
await db.close();

// #region add-index
const reopened = await createDatabase({
  path: 'board',
  schema: { entities: { Task: { index: ['done', ['boardId', 'rank'], ['owner', 'rank']] } } },
});
console.log(reopened.Task.select({ owner: 'ada' }).order('rank').limit(5).explain().sortedByIndex); // true
// #endregion add-index
const served = reopened.Task.select({ owner: 'ada' }).order('rank').limit(5).explain();
assert.deepEqual([served.scan, served.index, served.sortedByIndex], ['index', ['owner', 'rank'], true]);
assert.equal((await reopened.Task.select({ owner: 'ada' }).order('rank').limit(5).fetch()).length, 5);
await reopened.close();
