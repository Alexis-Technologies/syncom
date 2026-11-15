// RxDB's side of the Installation page's "Coming from RxDB" code group (docs/guide/install.md), run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
// #region plugins
import { addRxPlugin, createRxDatabase } from 'rxdb';
import { RxDBQueryBuilderPlugin } from 'rxdb/plugins/query-builder';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';

addRxPlugin(RxDBQueryBuilderPlugin); // for every database of the process, from here on

const board = await createRxDatabase({ name: 'board', storage: getRxStorageMemory() });
// #endregion plugins
await board.addCollections({
  tasks: {
    schema: {
      version: 0,
      primaryKey: 'id',
      type: 'object',
      properties: { id: { type: 'string', maxLength: 100 }, done: { type: 'boolean' } },
      required: ['id'],
    },
  },
});
await board.tasks.insert({ id: 'a', done: false });
assert.equal((await board.tasks.find().where('done').eq(false).exec()).length, 1);
await board.close();
