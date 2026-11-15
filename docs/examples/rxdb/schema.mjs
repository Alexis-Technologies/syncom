// RxDB's side of the Schema page's "Coming from RxDB" code group (docs/guide/schema.md), run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
import { createRxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';

// #region schema
const board = await createRxDatabase({
  name: 'board',
  storage: wrappedValidateAjvStorage({ storage: getRxStorageMemory() }), // validation is a storage wrapper
});
await board.addCollections({
  tasks: {
    schema: {
      version: 0,
      primaryKey: 'id',
      type: 'object',
      properties: {
        id: { type: 'string', maxLength: 100 },
        title: { type: 'string', minLength: 1, maxLength: 200 },
        done: { type: 'boolean', default: false },
        key: { type: 'string', maxLength: 20 },
      },
      required: ['id', 'title', 'done', 'key'],
      indexes: ['done', 'key'],
    },
  },
});
await board.tasks.insert({ id: crypto.randomUUID(), title: 'Write the docs', key: 'T-1' });
// #endregion schema
const invalid = await board.tasks.insert({ id: 'x', title: '', key: 'T-2' }).catch((error) => error);
assert.ok(invalid instanceof Error);
assert.equal((await board.tasks.find({ selector: { done: false } }).exec()).length, 1);
await board.close();
