// RxDB's side of the Encryption page's "Coming from RxDB" code group (docs/guide/encryption.md),
// run by `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
// #region fields
import { createRxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { wrappedKeyEncryptionCryptoJsStorage } from 'rxdb/plugins/encryption-crypto-js';

// The storage is wrapped, the database gets a password, the schema lists the fields to encrypt.
const board = await createRxDatabase({
  name: 'board',
  storage: wrappedKeyEncryptionCryptoJsStorage({ storage: getRxStorageMemory() }),
  password: 'correct horse battery',
});
await board.addCollections({
  tasks: {
    schema: {
      version: 0,
      primaryKey: 'id',
      type: 'object',
      properties: {
        id: { type: 'string', maxLength: 100 },
        title: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['id', 'title'],
      encrypted: ['note'],
    },
  },
});
await board.tasks.insert({ id: 'review', title: 'Salary review', note: 'Ask for 10%' });
// #endregion fields
const doc = await board.tasks.findOne('review').exec();
assert.equal(doc.note, 'Ask for 10%');
await board.close();
