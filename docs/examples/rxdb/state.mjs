// RxDB's side of the "Coming from RxDB" code group of docs/guide/state.md, run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
import { createRxDatabase, addRxPlugin } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { RxDBStatePlugin } from 'rxdb/plugins/state';

addRxPlugin(RxDBStatePlugin);
const board = await createRxDatabase({ name: 'board', storage: getRxStorageMemory() });

// #region create
const settings = await board.addState('settings');

await settings.set('theme', () => 'dark'); // every write is a function of the value as it is
await settings.set('filters.done', () => false);
console.log(settings.get('theme')); // 'dark': read at once, from memory
// #endregion create
assert.equal(settings.get('theme'), 'dark');
assert.equal(settings.get('filters.done'), false);
await board.close();
