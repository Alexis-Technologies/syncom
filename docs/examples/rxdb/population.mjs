// RxDB's side of the "Coming from RxDB" code group of docs/guide/population.md, run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
import { createRxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';

const board = await createRxDatabase({ name: 'board', storage: getRxStorageMemory() });
const id = { type: 'string', maxLength: 100 };
// #region schema
await board.addCollections({
  persons: {
    schema: { version: 0, primaryKey: 'id', type: 'object', properties: { id, name: { type: 'string' } } },
  },
  tasks: {
    schema: {
      version: 0,
      primaryKey: 'id',
      type: 'object',
      properties: {
        id,
        title: { type: 'string' },
        assignee: { type: 'string', ref: 'persons' }, // the reference is declared in the JSON schema
      },
    },
  },
});
await board.persons.insert({ id: 'ada', name: 'Ada' });
const task = await board.tasks.insert({ id: 'docs', title: 'Write the docs', assignee: 'ada' });
const person = await task.populate('assignee'); // an RxDocument of persons, or null
// #endregion schema
assert.equal(person.name, 'Ada');
await board.close();
