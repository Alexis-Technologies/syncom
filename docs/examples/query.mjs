// The Query page (docs/guide/query.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

// #region data
const db = await createDatabase({
  path: 'board',
  schema: { entities: { Task: { index: ['done', ['done', 'due']] } } },
});
await db.Task.bulkInsert([
  { id: 't1', title: 'Write the docs', done: false, due: '2026-12-01', priority: 3 },
  { id: 't2', title: 'Ship it', done: false, due: '2026-11-20', priority: 5 },
  { id: 't3', title: 'Set up the repo', done: true, due: '2026-10-01', priority: 1 },
  { id: 't4', title: 'Answer issues', done: false, priority: 0 },
]);
// #endregion data

// #region find
const open = await db.Task.select({ done: false }).fetch(); // every match, as plain objects
const first = await db.Task.select({ done: false }).order('title').one(); // the first match, or null
const count = await db.Task.count({ done: false }); // how many match
console.log(open.length, first.title, count); // 3 'Answer issues' 3
console.log(first); // { title: 'Answer issues', done: false, priority: 0, $type: 'Task', id: 't4' }
// #endregion find
assert.equal(open.length, 3);
assert.deepEqual(first, { title: 'Answer issues', done: false, priority: 0, $type: 'Task', id: 't4' });
assert.equal(count, 3);

// #region sort
const byPriority = await db.Task.select({ done: false }).desc('priority').limit(2).fetch();
console.log(byPriority.map((row) => row.title)); // [ 'Ship it', 'Write the docs' ]

const byDue = await db.Task.select({ done: false }).order('due').fetch();
console.log(byDue.map((row) => row.due)); // [ undefined, '2026-11-20', '2026-12-01' ]: missing values first
// #endregion sort
assert.deepEqual(
  byPriority.map((row) => row.title),
  ['Ship it', 'Write the docs'],
);
assert.deepEqual(
  byDue.map((row) => row.due),
  [undefined, '2026-11-20', '2026-12-01'],
);

// #region page
const pages = [];
let page = await db.Task.select().order('title').limit(3).page();
pages.push(page.rows.map((row) => row.id));
while (page.next !== null) {
  page = await db.Task.select().order('title').limit(3).after(page.next).page();
  pages.push(page.rows.map((row) => row.id));
}
console.log(pages); // [ [ 't4', 't3', 't2' ], [ 't1' ] ]
// #endregion page
assert.deepEqual(pages, [['t4', 't3', 't2'], ['t1']]);

// #region stream
let total = 0;
for await (const row of db.Task.select().order('title')) total += row.priority;
console.log(total); // 9
// #endregion stream
assert.equal(total, 9);

// #region watch
const stop = db.Task.select({ done: false })
  .order('due')
  .watch((rows) =>
    console.log(
      'open:',
      rows.map((row) => row.id),
    ),
  );
// open: [ 't4', 't2', 't1' ]   (right away)
await db.Task.update('t2', { done: true });
// open: [ 't4', 't1' ]         (after the write lands)
stop();
// #endregion watch
await tick();

// #region watch-count
const seen = [];
const stopCount = db.Task.select({ done: false }).watchCount((n) => seen.push(n));
await db.Task.insert({ id: 't5', title: 'Plan the release', done: false, priority: 0 });
// #endregion watch-count
await tick();
stopCount();
assert.deepEqual(seen, [2, 3]);

// #region write
const result = await db.Task.select({ done: false, priority: { $lt: 1 } }).update({ $set: { stale: true } });
console.log(result); // { matched: 2, written: 2 }
await db.Task.select({ stale: true }).delete({ data: { reason: 'low priority' } });
// #endregion write
assert.deepEqual(result, { matched: 2, written: 2 });
assert.deepEqual((await db.Task.select().fetch()).map((row) => row.id).sort(), ['t1', 't2', 't3']);

// #region aggregate
console.log(await db.Task.distinct('done')); // [ false, true ]
console.log(await db.Task.countBy('done')); // [ { value: false, count: 1 }, { value: true, count: 2 } ]
// #endregion aggregate
assert.deepEqual(await db.Task.distinct('done'), [false, true]);
assert.deepEqual(await db.Task.countBy('done'), [
  { value: false, count: 1 },
  { value: true, count: 2 },
]);

// #region position
import { between } from '@alexify/syncom/order';

const top = between(); // a key with room on both sides
const bottom = between(top); // a key after it
await db.Task.update('t2', { position: top });
await db.Task.update('t3', { position: bottom });
await db.Task.update('t1', { position: between(top, bottom, { jitter: 4 }) }); // dropped between the two
const ordered = await db.Task.select().order('position').fetch();
console.log(ordered.map((row) => row.id)); // [ 't2', 't1', 't3' ]
// #endregion position
assert.deepEqual(
  ordered.map((row) => row.id),
  ['t2', 't1', 't3'],
);

// #region matches
const urgent = db.Task.select({ done: false, priority: { $gte: 3 } });
console.log(urgent.matches({ title: 'Draft', done: false, priority: 4 })); // true, nothing read
// #endregion matches
assert.equal(urgent.matches({ title: 'Draft', done: false, priority: 4 }), true);

// #region explain
const plan = db.Task.select({ done: false }).order('due').limit(10).explain();
console.log(plan.scan, plan.index, plan.sortedByIndex); // 'index' [ 'done', 'due' ] true
// #endregion explain
assert.equal(plan.scan, 'index');
assert.deepEqual(plan.index, ['done', 'due']);
assert.equal(plan.sortedByIndex, true);
await db.close();
