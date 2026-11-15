// RxDB's side of the "Coming from RxDB" code group of docs/guide/cleanup.md, run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
import { createRxDatabase, addRxPlugin } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { RxDBCleanupPlugin } from 'rxdb/plugins/cleanup';
import { RxDBLeaderElectionPlugin } from 'rxdb/plugins/leader-election';

addRxPlugin(RxDBCleanupPlugin);
addRxPlugin(RxDBLeaderElectionPlugin);
const DAY = 24 * 60 * 60 * 1000;

// #region run
const board = await createRxDatabase({
  name: 'board',
  storage: getRxStorageMemory(),
  cleanupPolicy: {
    minimumDeletedTime: 31 * DAY, // how long a deleted document stays
    runEach: 5 * 60 * 1000, // the leader runs a cleanup this often
    awaitReplicationsInSync: true, // and only while every replication is in sync
  },
});
// #endregion run
await board.addCollections({
  tasks: {
    schema: {
      version: 0,
      primaryKey: 'id',
      type: 'object',
      properties: { id: { type: 'string', maxLength: 100 }, title: { type: 'string' } },
    },
  },
});
const doc = await board.tasks.insert({ id: 'old', title: 'Old task' });
await doc.remove();
assert.equal(await board.tasks.cleanup(0), true); // purge now, whatever the age
await board.close();
