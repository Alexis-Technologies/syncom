// RxDB's side of the Query optimizer page's "Coming from RxDB" code group (docs/guide/query-optimizer.md), run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
import { createRxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';

const db = await createRxDatabase({ name: 'board', storage: getRxStorageMemory() });
await db.addCollections({
  tasks: {
    schema: {
      version: 0,
      primaryKey: 'id',
      type: 'object',
      properties: {
        id: { type: 'string', maxLength: 100 },
        boardId: { type: 'string', maxLength: 20 },
        rank: { type: 'number', minimum: 0, maximum: 1000, multipleOf: 1 },
      },
      required: ['id', 'boardId', 'rank'],
      indexes: [['boardId', 'rank']],
    },
  },
});

// #region explain
const query = db.tasks.find({
  selector: { boardId: 'b1', rank: { $gte: 10 } },
  sort: [{ rank: 'asc' }],
  limit: 4,
});
const plan = query.getPreparedQuery().queryPlan;
console.log(plan.index, plan.sortSatisfiedByIndex, plan.selectorSatisfiedByIndex);
// [ '_deleted', 'boardId', 'rank', 'id' ] true true
// #endregion explain
assert.deepEqual(plan.index, ['_deleted', 'boardId', 'rank', 'id']);
assert.equal(plan.sortSatisfiedByIndex, true);
await db.close();
