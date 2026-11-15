// The Query cache page (docs/guide/query-cache.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';

const db = await createDatabase({
  path: 'board',
  schema: { entities: { Task: { index: ['done', 'boardId'] }, Tag: {} } },
});
await db.Task.insert({ title: 'Write the docs', done: false, boardId: 'b1' });
await db.Task.insert({ title: 'Set up the repo', done: true, boardId: 'b1' });
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

// #region shared
// Two parts of the page show the open tasks of one board.
const header = db.Task.select({ boardId: 'b1', done: false }).watch((rows) => {
  console.log('header:', rows.length);
});
const list = db.Task.select({ done: false, boardId: 'b1' }).watch((rows) => {
  console.log('list:', rows.length);
});

console.log(db.stats().query.live); // 1: one run serves both
// #endregion shared
await tick();
assert.equal(db.stats().query.live, 1);

// #region fetch
await db.Task.insert({ title: 'Ship it', done: false, boardId: 'b1' });
// header: 2, list: 2   (the run placed the new task once, for both)

// Any fetch() of the same query takes the run's rows: no record is read.
const rows = await db.Task.select({ boardId: 'b1', done: false }).fetch();
console.log(rows.length); // 2
// #endregion fetch
await tick();
assert.equal(rows.length, 2);

// #region idle
header();
list();
console.log(db.stats().query); // { cache: { entries: 1, rows: 2 }, live: 0 }

await db.Tag.insert({ name: 'docs' }); // another collection: the kept result stays valid
await db.Task.select({ boardId: 'b1', done: false }).fetch(); // read from the cache
// #endregion idle
assert.deepEqual(db.stats().query, { cache: { entries: 1, rows: 2 }, live: 0 });

// #region uncached
const late = (row) => row.title.startsWith('S');
await db.Task.select({ done: false }).filter(late).fetch(); // a function has no key: runs every time
// #endregion uncached
assert.equal(db.stats().query.cache.entries, 1);
await db.close();
