// The Browser storage compared page (docs/guide/browser-storage.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory under Node.js: the call that
// lands in OPFS in a browser writes files here, and fake-indexeddb stands in for the browser's IndexedDB.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { memory } from '@alexify/syncom/memory';

const schema = { entities: { Task: { index: ['done'] } } };

// #region default
import { createDatabase } from '@alexify/syncom/all';

const board = await createDatabase({ path: 'board', schema }); // OPFS in a browser, no option needed
// #endregion default
await board.Task.insert({ title: 'Stored by default', done: false });
assert.equal(await board.Task.count({}), 1);

// #region indexeddb
import { idbEngine } from '@alexify/syncom/idb';

const engine = idbEngine({ name: 'board' }); // one IndexedDB database
const shared = await createDatabase({ path: 'board', schema, engine });
// #endregion indexeddb
await shared.Task.insert({ title: 'Stored in IndexedDB', done: false });
assert.equal(await shared.Task.count({}), 1);
await shared.close();
await engine.destroy(); // its BroadcastChannel would keep the process alive

// #region memory
import { memoryEngine } from '@alexify/syncom/memory';

const scratch = await createDatabase({ path: 'board', schema, engine: memoryEngine() }); // gone with the page
// #endregion memory
await scratch.close();

const showStorageFull = () => {};
// #region quota
const { usage, quota } = await board.quota(); // bytes the origin uses and may use, or null
const kept = await board.persist(); // true once the browser agrees not to evict the origin
board.on('error', (error) => {
  // The write resolved and replicates; its record could not be stored and is held in memory.
  if (error.code === 'UNPERSISTED' && error.quota) showStorageFull();
});
// #endregion quota
assert.ok(usage === null || typeof usage === 'number');
assert.ok(quota === null || typeof quota === 'number');
assert.equal(kept, true); // Node.js: a file system keeps what it is given
await board.close();

// A medium that reports itself full, the way a browser does: a QuotaExceededError.
const full = () => Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
const backend = memory();
let refuse = null; // 'log' or 'records'
const filling = {
  read: (...args) => backend.read(...args),
  exists: (...args) => backend.exists(...args),
  remove: (...args) => backend.remove(...args),
  list: (...args) => backend.list(...args),
  write: async (dir, ...rest) => {
    if (refuse === 'log' && dir.includes('/log')) throw full();
    if (refuse === 'records' && dir.endsWith('/data')) throw full();
    return backend.write(dir, ...rest);
  },
};
const tight = await createDatabase({ path: 'tight', schema, fsi: filling, defer: 0 });
const errors = [];
tight.on('error', (error) => errors.push(error));

// The record file is refused: the write resolves, is read from memory, and the error event says why.
refuse = 'records';
const kept1 = await tight.Task.insert({ title: 'Held in memory', done: false });
assert.equal((await tight.Task.get(kept1.id)).title, 'Held in memory');
assert.equal(errors.length, 1);
assert.equal(errors[0].code, 'UNPERSISTED');
assert.equal(errors[0].quota, true);

// The log is refused: nothing was written, and the write rejects with QUOTA.
refuse = 'log';
await assert.rejects(() => tight.Task.insert({ title: 'Not logged', done: false }), { code: 'QUOTA' });
refuse = null;
await tight.close();
