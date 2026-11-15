// The Devtools page (docs/guide/devtools.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase, memoryEngine } from '@alexify/syncom/all';

const board = await createDatabase({ engine: memoryEngine(), schema: { entities: { Task: {} } } });
const task = await board.Task.insert({ title: 'Ship it', done: false });
await board.inc(task.id, 'votes', 2);
await board.add(task.id, 'tags', ['docs']);
await board.updateText(task.id, 'notes', 'Friday');
await board.Task.update(task.id, { done: true });

// #region inspect
import { inspect } from '@alexify/syncom/inspect';

const report = await inspect(board, task.id);
console.log(report.reading); // the record as get() reads it, without the lens or the read hooks
// { title: 'Ship it', done: true, '$type': 'Task', votes: 2, tags: [ 'docs' ], notes: 'Friday' }
for (const field of report.fields) console.log(field.field, field.kind);
// $type register, done register, notes text, tags set, title register, votes counter
console.log(report.fields.find((field) => field.field === 'done').stamp); // [ 1794…, '<node id>' ]: who set it, when
for (const entry of report.log) console.log(entry.seq, entry.type, entry.field, entry.signed);
// 1 write null true, 2 inc votes true, 3 add tags true, 4 splice notes true, 5 set null true
// #endregion inspect
assert.deepEqual(report.reading, {
  title: 'Ship it',
  done: true,
  $type: 'Task',
  votes: 2,
  tags: ['docs'],
  notes: 'Friday',
});
assert.deepEqual(
  report.fields.map((field) => [field.field, field.kind]),
  [
    ['$type', 'register'],
    ['done', 'register'],
    ['notes', 'text'],
    ['tags', 'set'],
    ['title', 'register'],
    ['votes', 'counter'],
  ],
);
assert.deepEqual(
  report.log.map((entry) => entry.type),
  ['write', 'inc', 'add', 'splice', 'set'],
);
assert.equal(report.fields.find((field) => field.field === 'done').stamp[1], board.nodeId);

// #region anonymize
import { anonymize } from '@alexify/syncom/inspect';

const page = await board.snapshot();
const safe = anonymize({ report, page }, { keys: false }); // field names kept, every other string hashed
console.log(safe.report.reading);
// { title: '~a158…', done: true, '$type': '~bd34…', votes: 2, tags: [ '~971a…' ], notes: '~2b65…' }
// #endregion anonymize
assert.equal(safe.report.reading.done, true, 'numbers and booleans stay');
assert.equal(safe.report.reading.votes, 2);
assert.match(safe.report.reading.title, /^~[0-9a-f]{16}$/);
assert.notEqual(safe.report.id, task.id);
assert.equal(safe.page.records.length, 1);

// #region salt
const salt = 'shared-with-no-one';
const a = anonymize(task.id, { salt });
const b = anonymize({ id: task.id }, { salt, keys: false });
console.log(a === b.id); // true: the same string reads the same in both copies
// #endregion salt
assert.equal(a, b.id);
assert.notEqual(anonymize(task.id), anonymize(task.id), 'without a salt, each call takes a fresh one');
await board.close();
