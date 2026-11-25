// The Text and rich text page (docs/guide/text.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
// #region type
import { createDatabase, memoryEngine } from '@alexify/syncom/all';

const board = await createDatabase({
  engine: memoryEngine(),
  schema: { entities: { Task: {} } },
});
const { id } = await board.Task.insert({ title: 'Write the release notes' });

await board.splice(id, 'notes', 0, 0, 'Ship on Friday'); // the first write makes `notes` a text
await board.push(id, 'notes', '.'); // append
await board.splice(id, 'notes', 8, 6, 'Monday'); // replace 6 characters at index 8
console.log((await board.Task.get(id)).notes); // 'Ship on Monday.'
// #endregion type
assert.equal((await board.Task.get(id)).notes, 'Ship on Monday.');

// #region update-text
const ops = await board.updateText(id, 'notes', 'Ship on Monday, after the review.');
console.log(ops); // 1: one splice for the one place that changed
// #endregion update-text
assert.equal(ops, 1);
assert.equal((await board.Task.get(id)).notes, 'Ship on Monday, after the review.');

// #region marks
await board.updateText(id, 'notes', 'Ship on Monday');
await board.mark(id, 'notes', 0, 4, 'bold', true); // 'Ship' in bold
await board.splice(id, 'notes', 4, 0, 'ped'); // typed at the end of the range: bold too
await board.mark(id, 'notes', 11, 17, 'link', 'https://example.com/plan', { expand: 'none' });
await board.push(id, 'notes', '!'); // typed after the link: not part of it
console.log(await board.spans(id, 'notes'));
// [ { type: 'text', text: 'Shipped', marks: { bold: true } },
//   { type: 'text', text: ' on ', marks: {} },
//   { type: 'text', text: 'Monday', marks: { link: 'https://example.com/plan' } },
//   { type: 'text', text: '!', marks: {} } ]
// #endregion marks
assert.deepEqual(await board.spans(id, 'notes'), [
  { type: 'text', text: 'Shipped', marks: { bold: true } },
  { type: 'text', text: ' on ', marks: {} },
  { type: 'text', text: 'Monday', marks: { link: 'https://example.com/plan' } },
  { type: 'text', text: '!', marks: {} },
]);
assert.equal((await board.Task.get(id)).notes, 'Shipped on Monday!', 'the field still reads as the plain string');

// #region comments
const question = await board.mark(id, 'notes', 11, 17, 'comment', { by: 'ada', text: 'Which Monday?' }, { many: true });
await board.mark(id, 'notes', 11, 17, 'comment', { by: 'lin', text: 'The 14th.' }, { many: true });
await board.unmarkById(id, 'notes', question); // resolve Ada's comment, keep Lin's
await board.unmark(id, 'notes', 0, 7, 'bold'); // take the bold off by name
console.log((await board.spans(id, 'notes'))[1].marks.comment); // the span 'Monday'
// [ { id: '…', value: { by: 'lin', text: 'The 14th.' } } ]
// #endregion comments
const comments = (await board.spans(id, 'notes'))[1].marks.comment;
assert.equal(comments.length, 1);
assert.deepEqual(comments[0].value, { by: 'lin', text: 'The 14th.' });
assert.equal((await board.spans(id, 'notes'))[0].marks.bold, undefined);

// #region blocks
await board.updateText(id, 'body', 'Release\nShip it.');
await board.splitBlock(id, 'body', 0, { type: 'heading', attrs: { level: 1 } }); // a heading starts at 0
await board.splitBlock(id, 'body', 9, { type: 'paragraph' }); // a paragraph after the line break
await board.insertEmbed(id, 'body', 14, { type: 'image', attrs: { src: 'ship.png' } }); // an inline image
console.log(JSON.stringify((await board.Task.get(id)).body)); // "￼Release\n￼Ship￼ it."
console.log(await board.blocks(id, 'body'));
// [ { index: 0, type: 'heading', parents: [], attrs: { level: 1 },
//     spans: [ { type: 'text', text: 'Release\n', marks: {} } ] },
//   { index: 9, type: 'paragraph', parents: [], attrs: {},
//     spans: [ { type: 'text', text: 'Ship', marks: {} },
//              { type: 'embed', value: { type: 'image', parents: [], attrs: { src: 'ship.png' }, isEmbed: true }, marks: {} },
//              { type: 'text', text: ' it.', marks: {} } ] } ]
await board.updateBlock(id, 'body', 9, { type: 'paragraph', parents: ['blockquote'] }); // the paragraph, quoted
await board.joinBlock(id, 'body', 9); // or joined to the heading: the marker goes
// #endregion blocks
assert.equal((await board.Task.get(id)).body, '￼Release\nShip￼ it.');
assert.deepEqual(await board.block(id, 'body', 0), {
  type: 'heading',
  parents: [],
  attrs: { level: 1 },
  isEmbed: false,
});
assert.equal((await board.blocks(id, 'body')).length, 1);

// #region cursor
await board.updateText(id, 'notes', 'Ship on Monday');
const caret = await board.cursor(id, 'notes', 5); // before the 'o' of 'on'
await board.splice(id, 'notes', 0, 0, 'We '); // someone types in front of it
console.log(await board.index(id, 'notes', caret)); // 8: it moved with the text
// #endregion cursor
assert.equal(await board.index(id, 'notes', caret), 8);
const after = await board.cursor(id, 'notes', 8, { side: 'after' });
await board.splice(id, 'notes', 8, 0, '__');
assert.equal(await board.index(id, 'notes', after), 8, "side 'after': text typed at the cursor lands after it");
assert.equal(await board.index(id, 'notes', caret), 10, "side 'before': text typed at the cursor pushes it right");

// #region handle
const handle = await board.openText(id, 'draft');
handle.insert(0, 'Hello');
handle.insert(5, ' world', { bold: true });
console.log(handle.toString()); // 'Hello world', at once, no promise per keystroke
const stopObserving = handle.observe((delta, { local }) => {
  if (!local) console.log('another writer:', delta); // a peer's change, in the handle's indices
});
await handle.flushed; // logged: the two inserts as one transaction
await board.splice(id, 'draft', 0, 0, '>> '); // a write through the database...
// another writer: [ { insert: '>> ' } ]           ...reaches the handle as a delta
// #endregion handle
assert.equal((await board.Task.get(id)).draft, '>> Hello world');
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(handle.toString(), '>> Hello world');
stopObserving();
await handle.close();

// #region delta
const stop = board.observe(id, 'draft', (changes) => {
  const delta = board.toDelta(changes, 'draft'); // null: a reset, read the field again
  console.log(delta); // [ { retain: 3 }, { insert: 'Oh, ' } ]
});
await board.splice(id, 'draft', 3, 0, 'Oh, ');
stop();

const seen = (await board.Task.get(id)).draft; // the text an editor made its delta over
await board.applyDelta(id, 'draft', [{ retain: 3 }, { delete: 4 }, { insert: 'Hi ', attributes: { italic: true } }], {
  expect: seen,
});
try {
  await board.applyDelta(id, 'draft', [{ insert: '!' }], { expect: seen }); // made over an old text
} catch (error) {
  console.log(error.code); // ALX_ERR_STALE: nothing was written
}
// #endregion delta
assert.equal((await board.Task.get(id)).draft, '>> Hi Hello world');
await assert.rejects(board.applyDelta(id, 'draft', [{ insert: '!' }], { expect: seen }), { code: 'ALX_ERR_STALE' });

// #region surrogate
await board.updateText(id, 'summary', 'Ship 🚀 it');
try {
  await board.splice(id, 'summary', 6, 0, '!'); // between the two halves of the emoji
} catch (error) {
  console.log(error.code); // ALX_ERR_SURROGATE
}
// #endregion surrogate
await assert.rejects(board.splice(id, 'summary', 6, 0, '!'), { code: 'ALX_ERR_SURROGATE' });
await board.close();

// #region concurrent
import { createMesh, settle } from '@alexify/syncom/testing';

const mesh = await createMesh(
  ['server', 'laptop', 'phone'],
  [
    ['laptop', 'server'],
    ['phone', 'server'],
  ],
  { createStorage: (name, options) => createDatabase({ ...options, engine: memoryEngine() }) },
);
const [server, laptop, phone] = ['server', 'laptop', 'phone'].map((name) => mesh.get(name));
const note = await server.insert({ title: 'Release' });
await server.updateText(note, 'notes', 'Ship on Friday.');
await settle(mesh.storages);

await laptop.sync.stop();
await phone.sync.stop();
await laptop.splice(note, 'notes', 14, 0, ' morning'); // types after 'Friday'
await phone.splice(note, 'notes', 8, 6, 'Monday'); // replaces 'Friday'
await laptop.sync.start();
await phone.sync.start();
await settle(mesh.storages);
console.log((await phone.get(note)).notes); // 'Ship on Monday morning.' on every node
// #endregion concurrent
assert.equal((await phone.get(note)).notes, 'Ship on Monday morning.');
assert.equal((await laptop.get(note)).notes, 'Ship on Monday morning.');
assert.equal((await server.get(note)).notes, 'Ship on Monday morning.');
await mesh.close();
