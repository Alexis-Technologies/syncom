// The IndexedDB performance page (docs/guide/slow-indexeddb.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory, with fake-indexeddb
// standing in for the browser's IndexedDB (Node has none). The assertions count IndexedDB's readwrite
// transactions: how many a pattern of writes costs is syncom's doing, whatever implementation runs them.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';

const counts = { log: 0, writeSets: 0 };
const transaction = globalThis.IDBDatabase.prototype.transaction;
globalThis.IDBDatabase.prototype.transaction = function (stores, mode, ...rest) {
  if (mode === 'readwrite') {
    const names = [].concat(stores);
    if (names.length === 1 && names[0] === 'log') counts.log++;
    else if (names.includes('records')) counts.writeSets++;
  }
  return transaction.call(this, stores, mode, ...rest);
};
const since = () => {
  const start = { ...counts };
  return () => ({ log: counts.log - start.log, writeSets: counts.writeSets - start.writeSets });
};

// #region open
import { createDatabase } from '@alexify/syncom/all';
import { idbEngine } from '@alexify/syncom/idb';

const engine = idbEngine({ name: 'board' });
const db = await createDatabase({
  path: 'board',
  engine,
  schema: { entities: { Task: { index: ['done'] } } },
});
// #endregion open

// #region typing
const { id } = await db.Task.insert({ title: 'Plan the launch', done: false });
for (const ch of 'agenda') await db.push(id, 'notes', ch); // six writes, each awaited
await db.flush(); // or wait for the window to pass
// #endregion typing
assert.equal((await db.Task.get(id)).notes, 'agenda');

// Six awaited keystrokes: a log group each, and the record lands far fewer times than it was written.
let cost = since();
for (const ch of ' and dates') await db.push(id, 'notes', ch);
await db.flush();
let spent = cost();
assert.equal(spent.log, 10);
assert.ok(spent.writeSets <= 3, `the window merged the record's landings (${spent.writeSets} write sets)`);

// The same keystrokes with no window: a write set per write.
const eager = await createDatabase({ path: 'eager', engine, defer: 0 });
const draft = await eager.insert({ title: 'Draft' });
cost = since();
for (const ch of ' and dates') await eager.push(draft, 'notes', ch);
spent = cost();
assert.equal(spent.log, 10);
assert.equal(spent.writeSets, 10);
await eager.close();

// #region batch
const rows = [];
for (let i = 0; i < 200; i++) rows.push({ title: `Imported task ${i}`, done: false });
await db.Task.bulkInsert(rows); // one transaction of syncom's: one log group, one write set
// #endregion batch
await db.flush();
cost = since();
await db.Task.bulkInsert(rows.map((row) => ({ ...row })));
await db.flush();
spent = cost();
assert.deepEqual(spent, { log: 1, writeSets: 1 });

cost = since();
await db.transact(async (tx) => {
  for (let i = 0; i < 50; i++) await tx.insert({ $type: 'Task', title: `Step ${i}`, done: false });
});
await db.flush();
assert.deepEqual(cost(), { log: 1, writeSets: 1 });

// #region relaxed
const relaxed = idbEngine({ name: 'drafts', durability: 'relaxed' }); // 'default', 'relaxed' or 'strict'
const drafts = await createDatabase({ path: 'drafts', engine: relaxed });
// #endregion relaxed
await drafts.insert({ title: 'Kept with relaxed durability' });
await drafts.close();
await relaxed.destroy();

// Queries read the catalog in memory: an indexed count touches no store.
let reads = 0;
const get = globalThis.IDBObjectStore.prototype.get;
globalThis.IDBObjectStore.prototype.get = function (...args) {
  reads++;
  return get.apply(this, args);
};
// #region catalog
const openTasks = await db.Task.count({ done: false }); // answered by the catalog in memory
// #endregion catalog
assert.equal(openTasks, 451);
assert.equal(reads, 0);
globalThis.IDBObjectStore.prototype.get = get;

await db.close();
await engine.destroy();
