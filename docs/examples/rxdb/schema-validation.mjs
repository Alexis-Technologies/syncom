// RxDB's side of the Schema validation page's "Coming from RxDB" code group (docs/guide/schema-validation.md),
// run by `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
// #region validate
import { createRxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';

// The validation wraps the storage; the JSON schema of the collection is what it checks.
const board = await createRxDatabase({
  name: 'board',
  storage: wrappedValidateAjvStorage({ storage: getRxStorageMemory() }),
});
await board.addCollections({
  tasks: {
    schema: {
      version: 0,
      primaryKey: 'id',
      type: 'object',
      properties: {
        id: { type: 'string', maxLength: 100 },
        title: { type: 'string', minLength: 1 },
        done: { type: 'boolean', default: false },
      },
      required: ['id', 'title'],
    },
  },
});

await board.tasks.insert({ id: 'empty', title: '' }).catch((error) => console.log(error.code)); // VD2
// #endregion validate
const refused = await board.tasks.insert({ id: 'empty', title: '' }).catch((error) => error);
assert.equal(refused.code, 'VD2');
await board.close();
