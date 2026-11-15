// The Performance tips page (docs/guide/performance-tips.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';

// #region open
const db = await createDatabase({
  path: 'board',
  schema: {
    entities: {
      Task: { index: [['done', 'title']] }, // a compound key: equality on done, then sorted by title
    },
  },
});
// #endregion open

// One transaction: one group in the op log, one write set for the engine.
const writes = db.stats().engine.writes;
let groups = db.stats().log.open;
// #region transact
await db.transact(async (tx) => {
  for (const title of ['Draft the agenda', 'Book the room', 'Send the invite']) {
    await tx.insert({ $type: 'Task', title, done: false });
  }
});
// #endregion transact
await db.flush();
assert.equal(db.stats().log.open - groups, 1);
assert.equal(db.stats().engine.writes - writes, 1);
assert.equal(await db.Task.count({}), 3);

// The same three inserts awaited one by one: three groups in the log.
groups = db.stats().log.open;
for (const title of ['One', 'Two', 'Three']) await db.Task.insert({ title, done: true });
assert.equal(db.stats().log.open - groups, 3);

// #region bulk
const rows = [];
for (let i = 0; i < 500; i++) rows.push({ title: `Imported task ${i}`, done: false });
const { success, error } = await db.Task.bulkInsert(rows);
console.log(success.length, error.length); // 500 0
// #endregion bulk
assert.equal(success.length, 500);
assert.equal(error.length, 0);
await assert.rejects(
  () => db.Task.bulkInsert(Array.from({ length: 10_001 }, () => ({ title: 'x', done: false }))),
  TypeError,
);

// #region pipeline
const { id } = await db.Task.insert({ title: 'Count the votes', done: false });
const pending = [];
for (let i = 0; i < 100; i++) pending.push(db.inc(id, 'votes', 1)); // not awaited one by one
await Promise.all(pending); // every write has landed, in the order it was made
console.log((await db.Task.get(id)).votes); // 100
// #endregion pipeline
assert.equal((await db.Task.get(id)).votes, 100);

// #region defer
const notes = await createDatabase({ path: 'notes', defer: 100 }); // 16 ms by default
const note = await notes.insert({ title: 'Meeting notes' });
for (const ch of 'hello') await notes.push(note, 'body', ch); // five ops in the log
console.log(notes.stats().deferred); // 1: one record waits for its window
await notes.flush(); // land it now: one record file, one chain block
console.log(notes.stats().deferred); // 0
// #endregion defer
assert.equal(notes.stats().deferred, 0);
assert.equal((await notes.get(note)).body, 'hello');
await notes.close();

// #region explain
const page = db.Task.select({ done: false }).order('title').limit(20);
const plan = page.explain();
console.log(plan.scan, plan.index, plan.sortedByIndex); // index [ 'done', 'title' ] true
// #endregion explain
assert.equal(plan.scan, 'index');
assert.deepEqual(plan.index, ['done', 'title']);
assert.equal(plan.sortedByIndex, true);

// #region covered
const titles = db.Task.select({ done: false }).order('title').projection(['done', 'title']);
console.log(titles.explain().covered); // true: answered from the index, no record read
// #endregion covered
assert.equal(titles.explain().covered, true);

// #region advisor
import { indexAdvisor } from '@alexify/syncom/inspect';

const advisor = indexAdvisor(db);
await db.Task.select({ owner: 'ada' }).order('title').fetch(); // run your app's queries
await db.Task.select({ owner: 'bob' }).order('title').fetch();
console.log(advisor.suggest()); // [ { entity: 'Task', index: [ 'owner', 'title' ], queries: 2 } ]
advisor.stop();
// #endregion advisor
assert.deepEqual(advisor.suggest(), [{ entity: 'Task', index: ['owner', 'title'], queries: 2 }]);

const render = (rows) => rows.length;
let rendered = 0;
// #region watch
const open = db.Task.select({ done: false }).order('title').limit(20);
const stop = open.watch((rows) => render(rows)); // now, and again after every write that changes the rows
// #endregion watch
const again = db.Task.select({ done: false })
  .order('title')
  .limit(20)
  .watch(() => rendered++);
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(db.stats().query.live, 1, 'two watchers of one query share one live run');
assert.ok(rendered >= 1);
again();
stop();

// #region cache
const big = await createDatabase({ path: 'big', cache: { max: 20_000 } }); // 5000 by default
console.log(big.stats().cache); // { size: 0, max: 20000, pinned: 0 }
// #endregion cache
assert.equal(big.stats().cache.max, 20_000);
await big.close();

// #region hub
const hub = await createDatabase({
  path: 'hub',
  chain: false, // no audit chain: no block per landing, and nothing to verify on a cold read
});
console.log(hub.stats().chain); // null
// #endregion hub
assert.equal(hub.stats().chain, null);
await assert.rejects(() => hub.validate(), { code: 'NO_CHAIN' });
await hub.close();

// #region lazy
const laptop = await createDatabase({ path: 'laptop', integrity: 'lazy' }); // keeps the chain, trusts the files
// #endregion lazy
assert.notEqual(laptop.stats().chain, null);
await laptop.close();

// #region retention
const server = await createDatabase({
  path: 'server',
  sync: { retention: { ops: 2000 } }, // 10 000 by default
});
// #endregion retention
for (let i = 0; i < 300; i++) {
  await server.transact(async (tx) => {
    for (let k = 0; k < 10; k++) await tx.insert({ n: i * 10 + k });
  });
}
await server.flush();
const { log } = server.stats();
assert.ok(log.floor > 1, 'the oldest segments were dropped');
assert.ok(log.length < 3000, `the log keeps about retention.ops entries, not all 3000 (${log.length})`);
await server.close();

// #region measure
const before = db.stats();
await db.Task.update(id, { done: true });
await db.flush();
const after = db.stats();
console.log(after.commits); // { fast, queued, coalesced }: how local writes were made
console.log(after.engine.writes - before.engine.writes); // write sets the engine took
// #endregion measure
assert.equal(after.engine.writes - before.engine.writes, 1);

await db.close();
