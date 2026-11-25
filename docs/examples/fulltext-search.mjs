// The Full-text search page (docs/guide/fulltext-search.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
// #region open
import { createDatabase } from '@alexify/syncom/all';
import { createSearch } from '@alexify/syncom/search';

const db = await createDatabase({
  path: 'notes',
  schema: {
    entities: {
      Note: { index: ['boardId'], search: ['title', 'body'] },
    },
  },
  search: createSearch(),
});
// #endregion open

// #region search
await db.Note.insert({ boardId: 'b1', title: 'Quick brown fox', body: 'Jumps over the lazy dog' });
await db.Note.insert({ boardId: 'b1', title: 'Crème brûlée', body: 'A dessert' });
await db.Note.insert({ boardId: 'b2', title: 'Fox hunting', body: 'An old sport' });

const hits = await db.Note.select({ $text: 'fox' }).fetch();
console.log(hits.map((row) => row.title)); // [ 'Fox hunting', 'Quick brown fox' ]: best first
// #endregion search
const titles = (rows) => rows.map((row) => row.title);
assert.deepEqual(titles(hits), ['Fox hunting', 'Quick brown fox']);

// #region fuzzy
await db.Note.select({ $text: 'creme brulee' }).fetch(); // Crème brûlée: accents and case are ignored
await db.Note.select({ $text: 'quikc' }).fetch(); // Quick brown fox: a typo still matches
// #endregion fuzzy
assert.deepEqual(titles(await db.Note.select({ $text: 'creme brulee' }).fetch()), ['Crème brûlée']);
assert.deepEqual(titles(await db.Note.select({ $text: 'quikc' }).fetch()), ['Quick brown fox']);

// #region combine
await db.Note.select({ $text: 'fox', boardId: 'b1' }).fetch(); // Quick brown fox: the equality narrows
await db.Note.select({ $text: 'fox' }).order('title').fetch(); // every match, sorted by title instead
await db.Note.select({ $text: 'fox' }).one(); // the best match alone
await db.Note.count({ $text: 'fox' }); // 2
// #endregion combine
assert.deepEqual(titles(await db.Note.select({ $text: 'fox', boardId: 'b1' }).fetch()), ['Quick brown fox']);
assert.deepEqual(titles(await db.Note.select({ $text: 'fox' }).order('title').fetch()), [
  'Fox hunting',
  'Quick brown fox',
]);
assert.equal((await db.Note.select({ $text: 'fox' }).one()).title, 'Fox hunting');
assert.equal(await db.Note.count({ $text: 'fox' }), 2);

// #region watch
const stop = db.Note.select({ $text: 'dessert' }).watch((rows) => {
  console.log(rows.map((row) => row.title));
});
// [ 'Crème brûlée' ]
await db.Note.insert({ boardId: 'b3', title: 'Dessert menu', body: 'Pie' });
// [ 'Dessert menu', 'Crème brûlée' ]
// #endregion watch
await new Promise((resolve) => setTimeout(resolve, 30));
assert.deepEqual(titles(await db.Note.select({ $text: 'dessert' }).fetch()), ['Dessert menu', 'Crème brûlée']);
stop();

// A query that is not a string, or a `$text` below the top level, is refused at select().
assert.throws(() => db.Note.select({ $and: [{ $text: 'fox' }] }), TypeError);
await db.close();

// #region strict
const strict = await createDatabase({
  path: 'strict',
  schema: { entities: { Note: { search: ['title'] } } },
  search: createSearch({ minOverlap: 0.6 }),
});
await strict.Note.insert({ title: 'Quick brown fox' });
await strict.Note.select({ $text: 'quick' }).fetch(); // [ Quick brown fox ]
await strict.Note.select({ $text: 'quikc' }).fetch(); // []: too few trigrams in common now
// #endregion strict
assert.equal((await strict.Note.select({ $text: 'quick' }).fetch()).length, 1);
assert.equal((await strict.Note.select({ $text: 'quikc' }).fetch()).length, 0);
await strict.close();

// An entity with search fields and no index to feed them to is refused at open.
await assert.rejects(
  createDatabase({ path: 'unindexed', schema: { entities: { Note: { search: ['title'] } } } }),
  TypeError,
);

// #region own-index
// A TextIndex of your own: whole words, scored by how many of the query's words a record holds.
const words = (text) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u);

const exactWords = () => {
  const held = new Map(); // id → the record's words
  return {
    put(id, text) {
      held.set(id, new Set(words(text)));
    },
    remove(id) {
      held.delete(id);
    },
    query(text) {
      const found = [];
      for (const [id, has] of held) {
        let score = 0;
        for (const word of words(text)) {
          if (has.has(word)) score++;
        }
        if (score > 0) found.push({ id, score });
      }
      // Every match, best first, ties by id.
      return found.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    },
  };
};

const exact = await createDatabase({
  path: 'exact',
  schema: { entities: { Note: { search: ['title'] } } },
  search: exactWords,
});
await exact.Note.insert({ title: 'Quick brown fox' });
await exact.Note.insert({ title: 'Quick fix' });
await exact.Note.select({ $text: 'quick fox' }).fetch(); // [ Quick brown fox, Quick fix ]
await exact.Note.select({ $text: 'quikc' }).fetch(); // []: no typos here
// #endregion own-index
assert.deepEqual(titles(await exact.Note.select({ $text: 'quick fox' }).fetch()), ['Quick brown fox', 'Quick fix']);
assert.deepEqual(await exact.Note.select({ $text: 'quikc' }).fetch(), []);
await exact.close();
