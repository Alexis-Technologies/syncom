// The Population page (docs/guide/population.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';

// #region schema
import { createDatabase } from '@alexify/syncom/all';

const board = await createDatabase({
  path: 'board',
  schema: {
    entities: {
      Person: {},
      Tag: {},
      Task: { refs: { assignee: 'Person', tags: ['Tag'] } }, // one Person, many Tags
    },
  },
});
// #endregion schema

// #region write
const ada = await board.Person.insert({ name: 'Ada' });
const docs = await board.Tag.insert({ label: 'docs' });
const urgent = await board.Tag.insert({ label: 'urgent' });
const task = await board.Task.insert({
  title: 'Write the docs',
  assignee: ada.id, // a reference is the id, stored as a string
  tags: [docs.id, urgent.id],
});
console.log(await board.Task.get(task.id)); // { title: 'Write the docs', assignee: '…', tags: [ '…', '…' ], $type: 'Task' }
// #endregion write
assert.equal((await board.Task.get(task.id)).assignee, ada.id);

// #region reference
const doc = await board.Task.document(task.id);
console.log(doc.assignee.id); // the id of Ada's record
const person = await doc.assignee.document(); // a live Document of Person
console.log(person.name); // 'Ada'
console.log(JSON.stringify({ assignee: doc.assignee })); // {"assignee":"…"}: the id again
// #endregion reference
assert.equal(doc.assignee.id, ada.id);
assert.equal(person.name, 'Ada');
assert.equal(JSON.stringify({ assignee: doc.assignee }), JSON.stringify({ assignee: ada.id }));

// #region document-populate
const tags = await doc.populate('tags'); // an array of Documents, null where one is gone
console.log(tags.map((tag) => tag.label)); // [ 'docs', 'urgent' ]
// #endregion document-populate
assert.deepEqual(
  tags.map((tag) => tag.label),
  ['docs', 'urgent'],
);

// #region cursor
const rows = await board.Task.select({}).populate(['assignee', 'tags']).fetch();
console.log(rows[0].assignee); // { name: 'Ada', $type: 'Person', id: '…' }
console.log(rows[0].tags.map((tag) => tag.label)); // [ 'docs', 'urgent' ]
// #endregion cursor
assert.deepEqual(rows[0].assignee, { id: ada.id, name: 'Ada', $type: 'Person' });

// #region missing
await board.Person.delete(ada.id);
console.log(await doc.assignee.document()); // null: the record it names is gone
console.log((await board.Task.select({}).populate(['assignee']).fetch())[0].assignee); // null
// #endregion missing
assert.equal(await doc.assignee.document(), null);
assert.equal((await board.Task.select({}).populate(['assignee']).fetch())[0].assignee, null);

// #region undeclared
const other = await board.Task.insert({ title: 'Mentions a tag', note: docs.id });
console.log(typeof (await board.Task.document(other.id)).note); // 'string': not declared, not a reference
// #endregion undeclared
assert.equal(typeof (await board.Task.document(other.id)).note, 'string');

// A Reference to a record of another collection than the declared one resolves to null.
const wrong = await board.Task.insert({ title: 'Wrong kind', assignee: docs.id });
assert.equal(await (await board.Task.document(wrong.id)).assignee.document(), null);
await board.close();
