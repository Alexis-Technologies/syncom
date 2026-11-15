// The Database page (docs/guide/database.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
// #region open
import { createDatabase } from '@alexify/syncom/all';

const db = await createDatabase({ path: 'board' });
const id = await db.insert({ title: 'Write the docs', done: false });
console.log(await db.get(id)); // { title: 'Write the docs', done: false }
await db.close();
// #endregion open
assert.equal(db.stats().closed, true);

// #region memory
import { memoryEngine } from '@alexify/syncom/memory';

const scratch = await createDatabase({ engine: memoryEngine(), path: 'scratch' });
// #endregion memory
await scratch.close();

// #region options
const board = await createDatabase({
  path: 'board', // where the data lives: a directory, or a path in OPFS
  schema: { entities: { Task: { index: ['done'] } } }, // the collections
  logger: false, // or a console- or pino-shaped logger
  actor: 'ada', // who writes: stamped on every operation
});
// #endregion options
assert.deepEqual(await board.get(id), { title: 'Write the docs', done: false });

// #region by-id
const taskId = await board.insert({ title: 'Ship it', done: false });
await board.has(taskId); // true
await board.update(taskId, { done: true }); // change some fields
await board.unset(taskId, 'done'); // remove a field
await board.set(taskId, { title: 'Ship it today' }); // replace the record whole
console.log(await board.get(taskId)); // { title: 'Ship it today' }
console.log(await board.list()); // every live id, sorted
await board.delete(taskId);
console.log(await board.get(taskId)); // null
// #endregion by-id
assert.equal(await board.get(taskId), null);
assert.deepEqual(await board.list(), [id]);

// #region transact
const [first, second] = await board.transact(async (tx) => {
  const a = await tx.insert({ title: 'Plan the release', done: false });
  const b = await tx.insert({ title: 'Announce it', done: false, after: a });
  await tx.update(id, { done: true });
  return [a, b];
});
// all three writes landed together, or none of them did
// #endregion transact
assert.equal((await board.get(second)).after, first);
assert.equal((await board.get(id)).done, true);

// #region rollback
await board
  .transact(async (tx) => {
    await tx.update(first, { done: true });
    throw new Error('changed my mind');
  })
  .catch(() => {});
console.log((await board.get(first)).done); // false: nothing of the transaction was written
// #endregion rollback
assert.equal((await board.get(first)).done, false);

// #region swap
const claimed = await board.swap(first, { owner: 'ada' }, { done: false });
console.log(claimed); // true: `done` was still false, so `owner` was written
console.log(await board.swap(first, { owner: 'bob' }, { owner: null })); // false: nothing written
// #endregion swap
assert.equal(claimed, true);
assert.equal((await board.get(first)).owner, 'ada');

// #region invalid-id
try {
  await board.set('task 1', { title: 'A space is not allowed in an id' });
} catch (error) {
  console.log(error.code); // 'INVALID_ID'
}
// #endregion invalid-id
await assert.rejects(() => board.set('task 1', { title: 'x' }), { name: 'TypeError', code: 'INVALID_ID' });

// #region lock
try {
  await createDatabase({ path: 'board' });
} catch (error) {
  console.log(error.code); // 'LOCKED': board is open in this process already
}
// #endregion lock
await assert.rejects(() => createDatabase({ path: 'board', logger: false }), { code: 'LOCKED' });

// #region lock-wait
const waiting = createDatabase({ path: 'board', lock: 'wait', logger: false });
await board.close(); // releases the lock
const reopened = await waiting; // opens once board is closed
// #endregion lock-wait
assert.equal((await reopened.get(first)).owner, 'ada');

// #region closed
await reopened.close();
try {
  await reopened.insert({ title: 'Too late' });
} catch (error) {
  console.log(error.code); // 'CLOSED'
}
// #endregion closed
await assert.rejects(() => reopened.insert({ title: 'x' }), { code: 'CLOSED' });

// #region get-id
let n = 0;
const counted = await createDatabase({
  path: 'counted',
  logger: false,
  getId: () => `task-${Date.now().toString(36)}-${(++n).toString(36)}`,
});
console.log(await counted.insert({ title: 'Ids sort by creation time' })); // 'task-mwi2k3c4-1'
// #endregion get-id
assert.match(await counted.insert({ title: 'x' }), /^task-[0-9a-z]+-2$/);

// #region flush
await counted.insert({ title: 'Durable in the log already' });
await counted.flush(); // the record files and their chain block are on disk too
// #endregion flush
await counted.close();

// #region drop
import { dropDatabase } from '@alexify/syncom';

await dropDatabase('counted'); // a closed database, removed with its identity
// #endregion drop
const fresh = await createDatabase({ path: 'counted', logger: false });
assert.deepEqual(await fresh.list(), []);
await fresh.close();
