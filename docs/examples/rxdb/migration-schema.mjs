// RxDB's side of the "Coming from RxDB" code group of docs/guide/migration-schema.md, run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
import { createRxDatabase, addRxPlugin } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { RxDBMigrationSchemaPlugin } from 'rxdb/plugins/migration-schema';

addRxPlugin(RxDBMigrationSchemaPlugin);
const storage = getRxStorageMemory();
const properties = { id: { type: 'string', maxLength: 100 }, done: { type: 'boolean' } };

const first = await createRxDatabase({ name: 'board', storage });
await first.addCollections({
  tasks: {
    schema: {
      version: 0,
      primaryKey: 'id',
      type: 'object',
      properties: { ...properties, title: { type: 'string' } },
    },
  },
});
await first.tasks.insert({ id: 'docs', title: 'Write the docs', done: false });
await first.close();

// #region v2
const board = await createRxDatabase({ name: 'board', storage });
await board.addCollections({
  tasks: {
    schema: {
      version: 1, // every schema change bumps the version
      primaryKey: 'id',
      type: 'object',
      properties: { ...properties, name: { type: 'string' } },
    },
    migrationStrategies: {
      // runs once per stored document when the collection opens; the result replaces it
      1: ({ title, ...rest }) => ({ ...rest, name: title }),
    },
  },
});
// #endregion v2
const doc = await board.tasks.findOne('docs').exec();
assert.equal(doc.name, 'Write the docs');
assert.equal(doc.title, undefined);
await board.close();
