// RxDB's side of the Vector search page's "Coming from RxDB" code group (docs/guide/vector-search.md), run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare.
import assert from 'node:assert/strict';
import { createRxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';

const db = await createRxDatabase({ name: 'docs', storage: getRxStorageMemory() });
await db.addCollections({
  docs: {
    schema: {
      version: 0,
      primaryKey: 'id',
      type: 'object',
      properties: {
        id: { type: 'string', maxLength: 100 },
        title: { type: 'string' },
        lang: { type: 'string' },
        embedding: { type: 'array', items: { type: 'number' } },
      },
      required: ['id', 'title', 'lang', 'embedding'],
    },
  },
});
await db.docs.bulkInsert([
  { id: 'cats', title: 'Cats', lang: 'en', embedding: [0.9, 0.1, 0.0] },
  { id: 'kittens', title: 'Kittens', lang: 'en', embedding: [0.8, 0.2, 0.1] },
  { id: 'dogs', title: 'Dogs', lang: 'en', embedding: [0.1, 0.9, 0.0] },
  { id: 'chats', title: 'Chats', lang: 'fr', embedding: [0.9, 0.1, 0.05] },
]);
const question = [1, 0, 0];

// #region nearest
import { cosineSimilarity } from 'rxdb/plugins/vector';

// Read the candidates, measure each one, keep the best: the search is your code.
const docs = await db.docs.find({ selector: { lang: 'en' } }).exec();
const hits = docs
  .map((doc) => ({ similarity: cosineSimilarity(question, doc.embedding), doc }))
  .sort((a, b) => b.similarity - a.similarity) // a similarity: larger is nearer
  .slice(0, 2);
// #endregion nearest
assert.deepEqual(
  hits.map(({ doc }) => doc.title),
  ['Cats', 'Kittens'],
);
await db.close();
