// The Cleanup page (docs/guide/cleanup.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';
import { createMesh, settle, memoryEngine } from '@alexify/syncom/testing';

const DAY = 24 * 60 * 60 * 1000;
const board = await createDatabase({ path: 'board', schema: { entities: { Task: {} } } });
const task = await board.Task.insert({ title: 'Old task', done: true });
await board.Task.delete(task.id);

// #region run
import { cleanup } from '@alexify/syncom/cleanup';

const sweeper = cleanup(board, { minimumDeletedTime: 31 * DAY }); // 31 days is also the default
console.log(await sweeper.run()); // { folded: 0, dropped: 0, skipped: 1 }: deleted too recently
// #endregion run
assert.deepEqual(await sweeper.run(), { folded: 0, dropped: 0, skipped: 1 });

// #region later
// A test can move the clock instead of waiting a month.
const aMonthLater = cleanup(board, { now: () => Date.now() + 32 * DAY });
console.log(await aMonthLater.run()); // { folded: 1, dropped: 0, skipped: 0 }
console.log(await board.Task.get(task.id)); // null: still deleted
// #endregion later
assert.deepEqual(await aMonthLater.run(), { folded: 0, dropped: 0, skipped: 0 }, 'folded once');
assert.equal(await board.Task.get(task.id), null);

// #region revive
await board.set(task.id, { $type: 'Task', title: 'Old task, back', done: false }); // a write above the delete
console.log(await board.Task.get(task.id)); // { $type: 'Task', title: 'Old task, back', done: false }
// #endregion revive
assert.equal((await board.Task.get(task.id)).title, 'Old task, back');

// #region schedule
sweeper.start(); // a sweep every runEach ms (five minutes by default) until stop() or close()
sweeper.stop();
// #endregion schedule
await board.close();

// #region await-sync
const mesh = await createMesh(['server', 'laptop'], [['laptop', 'server']], {
  createStorage: (name, options) => createDatabase({ ...options, engine: memoryEngine(), path: name }),
});
const laptop = mesh.get('laptop');
await settle(mesh.storages);

const link = mesh.links.get('mem://server');
link.disconnect(); // the server is out of reach
const id = await laptop.insert({ title: 'Deleted offline' });
await laptop.delete(id);

const sweep = cleanup(laptop, { minimumDeletedTime: 0 }); // fold as soon as it is safe
console.log(await sweep.run()); // { folded: 0, dropped: 0, skipped: 1 }: the server has not seen the delete

await link.reconnect();
await settle(mesh.storages);
console.log(await sweep.run()); // { folded: 1, dropped: 0, skipped: 0 }: acknowledged, safe to fold
// #endregion await-sync
assert.deepEqual(await sweep.run(), { folded: 0, dropped: 0, skipped: 0 });
assert.equal(await mesh.get('server').get(id), null);
await mesh.close();
