// The IndexedDB page (docs/guide/storage-indexeddb.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory, with fake-indexeddb
// standing in for the browser's IndexedDB (Node has none).
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';

// #region open
import { createDatabase } from '@alexify/syncom/all';
import { idbEngine } from '@alexify/syncom/idb';

const engine = idbEngine({ name: 'board' });
const schema = { entities: { Task: { index: ['done'] } } };

const db = await createDatabase({ path: 'board', schema, engine });
await db.Task.insert({ title: 'Stored in IndexedDB', done: false });
// #endregion open
assert.equal(await db.Task.count({}), 1);
await db.flush(); // the record lands in IndexedDB (a write lands up to `defer` ms after it resolves)

// #region follower
// Another tab: its own engine over the same IndexedDB database, opened read-only.
const otherTab = await createDatabase({ path: 'board', schema, engine: idbEngine({ name: 'board' }), readOnly: true });
otherTab.Task.select({ done: false }).watch((rows) => console.log('open tasks:', rows.length));
// open tasks: 1   (right away)
await db.Task.insert({ title: 'Written in the first tab', done: false });
// open tasks: 2   (once the write is heard over the BroadcastChannel)
// #endregion follower
const deadline = Date.now() + 2000;
while ((await otherTab.Task.count({})) < 2 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.equal(await otherTab.Task.count({}), 2);
await assert.rejects(() => otherTab.Task.insert({ title: 'no', done: false }), { code: 'ALX_ERR_READ_ONLY' });
await otherTab.close();

// #region close
await db.close(); // the database
await engine.close(); // the connection; the next call opens it again
// #endregion close

// #region options
const tuned = idbEngine({
  name: 'board', // the IndexedDB database every path of this engine lives in
  durability: 'relaxed', // the transactions' durability hint: 'default', 'relaxed' or 'strict'
  channel: null, // no BroadcastChannel: other tabs hear nothing
});
// #endregion options
const again = await createDatabase({ path: 'board', schema, engine: tuned });
assert.equal(await again.Task.count({}), 2);
await again.close();
await tuned.close();

// #region destroy
await engine.destroy(); // deletes the IndexedDB database: every path in it
// #endregion destroy
const empty = await createDatabase({ path: 'board', schema, engine });
assert.equal(await empty.Task.count({}), 0);
await empty.close();
await engine.destroy();

// #region node
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

// Outside a browser, hand the engine an implementation of IndexedDB.
const inNode = idbEngine({ name: 'test', indexedDB, IDBKeyRange });
// #endregion node
const tested = await createDatabase({ path: 'board', schema, engine: inNode });
await tested.Task.insert({ title: 'In a Node test', done: false });
assert.equal(await tested.Task.count({}), 1);
await tested.close();
await inNode.destroy();

// #region fsi
import { createIdbFsi } from '@alexify/syncom/idb';

// The files engine over IndexedDB: every file a row of one object store.
const fsi = createIdbFsi({ name: 'board-files' });
const filed = await createDatabase({ path: 'board', schema, fsi });
// #endregion fsi
await filed.Task.insert({ title: 'A file in IndexedDB', done: false });
assert.equal(await filed.Task.count({}), 1);
await filed.close();
await fsi.close();
