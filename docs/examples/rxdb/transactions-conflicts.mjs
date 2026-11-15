// RxDB's side of the "Coming from RxDB" code groups of docs/guide/transactions-conflicts.md, run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
import { createRxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';

const board = await createRxDatabase({ name: 'board', storage: getRxStorageMemory() });
const schema = {
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 100 },
    title: { type: 'string' },
    done: { type: 'boolean' },
    assignee: { type: ['string', 'null'] },
  },
  required: ['id', 'title', 'done'],
};

// #region conflict
await board.addCollections({
  tasks: {
    schema,
    // Runs on the client when the server's document differs from the one this client last saw.
    conflictHandler: {
      isEqual: (a, b) => a.title === b.title && a.done === b.done && a.assignee === b.assignee,
      resolve: async ({ realMasterState, newDocumentState }) => ({
        ...realMasterState,
        done: realMasterState.done || newDocumentState.done, // keep a close from either side
      }),
    },
  },
});
// #endregion conflict

await board.tasks.insert({ id: 'docs', title: 'Write the docs', done: false, assignee: null });

// #region claim
const task = await board.tasks.findOne('docs').exec();
const after = await task.incrementalModify((data) => {
  if (data.assignee === null) data.assignee = 'ada'; // re-run on the latest state if another write came first
  return data;
});
const claimed = after.assignee === 'ada';
// #endregion claim
assert.equal(claimed, true);
await board.close();
