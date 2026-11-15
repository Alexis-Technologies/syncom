// The Vector search page (docs/guide/vector-search.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
// #region store
import { createDatabase } from '@alexify/syncom/all';

const db = await createDatabase({
  path: 'docs',
  schema: { entities: { Doc: { index: ['lang'] } } },
});

// The vectors come from your embedding model; three numbers stand in for hundreds here.
await db.Doc.insert({ title: 'Cats', lang: 'en', embedding: [0.9, 0.1, 0.0] });
await db.Doc.insert({ title: 'Kittens', lang: 'en', embedding: [0.8, 0.2, 0.1] });
await db.Doc.insert({ title: 'Dogs', lang: 'en', embedding: [0.1, 0.9, 0.0] });
await db.Doc.insert({ title: 'Chats', lang: 'fr', embedding: [0.9, 0.1, 0.05] });
await db.Doc.insert({ title: 'Draft', lang: 'en' }); // no vector yet: skipped by every search
// #endregion store

// #region nearest
const question = [1, 0, 0]; // the embedding of what the user typed

const hits = await db.Doc.select().nearest('embedding', question, 2);
console.log(hits.map(({ distance, row }) => [row.title, distance.toFixed(3)]));
// [ [ 'Cats', '0.006' ], [ 'Chats', '0.008' ] ]: nearest first, by cosine distance
// #endregion nearest
assert.deepEqual(
  hits.map(({ row }) => row.title),
  ['Cats', 'Chats'],
);

// #region filter
const english = await db.Doc.select({ lang: 'en' }).projection(['title']).nearest('embedding', question, 2);
console.log(english.map(({ row }) => row)); // [ { id, title: 'Cats' }, { id, title: 'Kittens' } ]
// #endregion filter
assert.deepEqual(
  english.map(({ row }) => row.title),
  ['Cats', 'Kittens'],
);
assert.deepEqual(Object.keys(english[0].row).sort(), ['id', 'title']);

// #region distance
await db.Doc.select().nearest('embedding', question, 3, { distance: 'euclidean' });
await db.Doc.select().nearest('embedding', question, 3, { distance: 'dot' }); // the largest product first
// #endregion distance
const euclid = await db.Doc.select({ lang: 'en' }).nearest('embedding', question, 3, { distance: 'euclidean' });
assert.deepEqual(
  euclid.map(({ row }) => row.title),
  ['Cats', 'Kittens', 'Dogs'],
);
assert.equal(euclid[1].distance, 0.3);

// #region custom
import { cosine } from '@alexify/syncom/search';

// Your own measure: any function of two vectors, smaller is nearer.
const firstTwo = (a, b) => cosine(a.slice(0, 2), b.slice(0, 2));
await db.Doc.select().nearest('embedding', question, 2, { distance: firstTwo });
// #endregion custom
assert.equal((await db.Doc.select().nearest('embedding', question, 2, { distance: firstTwo })).length, 2);

// #region prefilter
import { euclidean } from '@alexify/syncom/search';

// A reference point chosen once; every record keeps its distance to it in an indexed field.
const reference = [0, 0, 1];
const notes = await createDatabase({
  path: 'notes',
  schema: { entities: { Note: { index: ['fromReference'] } } },
});
const addNote = (title, embedding) =>
  notes.Note.insert({ title, embedding, fromReference: euclidean(embedding, reference) });
await addNote('Cats', [0.9, 0.1, 0.0]);
await addNote('Kittens', [0.8, 0.2, 0.1]);
await addNote('Dogs', [0.1, 0.9, 0.0]);

// Only a record whose distance to the reference is within `radius` of the question's can be within
// `radius` of the question: the index narrows, nearest() measures what is left.
const radius = 0.5;
const center = euclidean(question, reference);
const close = await notes.Note.select({
  fromReference: { $gte: center - radius, $lte: center + radius },
}).nearest('embedding', question, 2, { distance: 'euclidean' });
// #endregion prefilter
assert.deepEqual(
  close.map(({ row }) => row.title),
  ['Cats', 'Kittens'],
);
assert.equal(
  notes.Note.select({ fromReference: { $gte: center - radius, $lte: center + radius } }).explain().scan,
  'index',
);
await notes.close();

// k and the vector are bounded: k ≤ 1000, a vector of 1 to 4096 finite numbers.
await assert.rejects(db.Doc.select().nearest('embedding', question, 1001), TypeError);
await assert.rejects(db.Doc.select().nearest('embedding', [], 1), TypeError);
await db.close();
