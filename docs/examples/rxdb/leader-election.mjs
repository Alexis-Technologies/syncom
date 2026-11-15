// RxDB's side of the "Coming from RxDB" code group of docs/guide/leader-election.md, run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
// #region elect
import { createRxDatabase, addRxPlugin } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { RxDBLeaderElectionPlugin } from 'rxdb/plugins/leader-election';

addRxPlugin(RxDBLeaderElectionPlugin);

// Every tab opens the database; the election belongs to it.
const board = await createRxDatabase({ name: 'board', storage: getRxStorageMemory() });
board.waitForLeadership().then(() => console.log('this tab sends the reminders'));
// #endregion elect

await board.waitForLeadership();
assert.equal(board.isLeader(), true);
await board.close();
