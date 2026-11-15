// RxDB's side of the "Coming from RxDB" code group of docs/guide/backup.md, run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { createRxDatabase, addRxPlugin } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { RxDBBackupPlugin } from 'rxdb/plugins/backup';

addRxPlugin(RxDBBackupPlugin);
const board = await createRxDatabase({ name: 'board', storage: getRxStorageMemory() });
await board.addCollections({
  tasks: {
    schema: {
      version: 0,
      primaryKey: 'id',
      type: 'object',
      properties: { id: { type: 'string', maxLength: 100 }, title: { type: 'string' } },
    },
  },
});
await board.tasks.insert({ id: 'one', title: 'Back me up' });

// #region write
const state = board.backup({
  live: true, // keep writing as documents change
  directory: 'board-backup', // Node.js only: a folder per document, each with a document.json
});
await state.awaitInitialBackup();
// #endregion write
assert.ok((await readdir('board-backup')).includes('tasks'));
await state.cancel();
await board.close();
