// The Health and maintenance page (docs/guide/health.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createDatabase } from '@alexify/syncom/all';

const board = await createDatabase({ path: 'board', schema: { entities: { Task: {} } } });
const task = await board.Task.insert({ title: 'Ship it', done: false });

// #region stats
const { queue, held, inflight, deferred, log, cache, lock, engine } = board.stats();
console.log(queue, inflight, held); // 0 0 1: nothing waits on the queue or the disk; one record file lags the log
console.log(deferred); // 1: within the deferred window (16 ms by default), it lands with the next flush
console.log(log.appendFailures, log.droppedTs); // 0 0: every append landed, nothing was dropped
console.log(cache, lock.lost, engine.failures); // { size: 1, max: 5000, pinned: 1 } false 0
// #endregion stats
assert.equal(queue, 0);
assert.equal(log.appendFailures, 0);
assert.equal(lock.lost, false);
assert.equal(engine.failures, 0);
assert.equal(typeof cache.max, 'number');

// #region flush
await board.flush(); // the writes in flight, then the deferred record files
console.log(board.stats().deferred, board.stats().held); // 0 0
// #endregion flush
assert.equal(board.stats().deferred, 0);
assert.equal(board.stats().held, 0);

// #region quota
console.log(await board.quota()); // { usage: null, quota: 613498261504 }: the files engine knows the volume
console.log(await board.persist()); // true: in Node.js there is nothing to ask for
// #endregion quota
const room = await board.quota();
assert.equal(room.usage, null);
assert.equal(typeof room.quota, 'number');
assert.equal(await board.persist(), true);

// #region compact
for (const letter of 'olleh') await board.splice(task.id, 'notes', 0, 0, letter); // typed backwards: five runs
await board.push(task.id, 'steps', ['write', 'test', 'ship']);
for (let i = 0; i < 20; i++) await board.move(task.id, 'steps', 0, 2); // reordered over and over

console.log(await board.compact(task.id)); // 3: a write of the registers, one op per list and text
console.log(await board.Task.get(task.id)); // reads exactly as before
// { title: 'Ship it', done: false, '$type': 'Task', notes: 'hello', steps: [ 'ship', 'write', 'test' ] }
// #endregion compact
assert.deepEqual(await board.Task.get(task.id), {
  title: 'Ship it',
  done: false,
  $type: 'Task',
  notes: 'hello',
  steps: ['ship', 'write', 'test'],
});
await board.close();

// A record file torn or edited behind syncom's back.
const file = `board/data/${task.id}.json`;
const stored = JSON.parse(readFileSync(file, 'utf8'));
stored.data.title = 'Edited on disk';
writeFileSync(file, JSON.stringify(stored));

// #region repair
const reopened = await createDatabase({ path: 'board', schema: { entities: { Task: {} } } });
try {
  await reopened.Task.get(task.id);
} catch (error) {
  if (error.code !== 'INTEGRITY') throw error;
  // look at the file first: it is evidence. Then rebuild the record from this node's log.
  console.log(await reopened.repair(task.id)); // { ops: 30, alive: true }: the entries it replayed
}
console.log((await reopened.Task.get(task.id)).title); // 'Ship it'
// #endregion repair
assert.equal((await reopened.Task.get(task.id)).title, 'Ship it');
await assert.rejects(reopened.repair('never-written'), { code: 'UNRECOVERABLE' });
await reopened.close();
