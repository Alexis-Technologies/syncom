// RxDB's side of the "Coming from RxDB" code group of docs/guide/local.md, run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
import { createRxDatabase, addRxPlugin } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { RxDBLocalDocumentsPlugin } from 'rxdb/plugins/local-documents';

addRxPlugin(RxDBLocalDocumentsPlugin);
// #region basics
const board = await createRxDatabase({
  name: 'board',
  storage: getRxStorageMemory(),
  localDocuments: true, // opted in per database (or per collection)
});

await board.upsertLocal('layout', { sidebar: 320, theme: 'dark' });
const layout = await board.getLocal('layout'); // an RxLocalDocument
console.log(layout.get('sidebar')); // 320
await layout.remove();
// #endregion basics
assert.equal(await board.getLocal('layout'), null);
await board.close();
