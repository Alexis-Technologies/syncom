// RxDB's side of the "Coming from RxDB" code group of docs/guide/import-export.md, run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
import { createRxDatabase, addRxPlugin } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { RxDBJsonDumpPlugin } from 'rxdb/plugins/json-dump';

addRxPlugin(RxDBJsonDumpPlugin);
const tasks = {
  schema: {
    version: 0,
    primaryKey: 'id',
    type: 'object',
    properties: { id: { type: 'string', maxLength: 100 }, title: { type: 'string' } },
  },
};
const board = await createRxDatabase({ name: 'board', storage: getRxStorageMemory() });
await board.addCollections({ tasks });
await board.tasks.insert({ id: 'docs', title: 'Write the docs' });

// #region export
const dump = await board.exportJSON(); // the live documents of every collection

const copy = await createRxDatabase({ name: 'copy', storage: getRxStorageMemory() });
await copy.addCollections({ tasks }); // the same collections, the same schemas
await copy.importJSON(dump); // inserted as new writes
// #endregion export
assert.equal((await copy.tasks.findOne('docs').exec()).title, 'Write the docs');
await board.close();
await copy.close();
