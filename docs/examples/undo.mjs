// The Undo and redo page (docs/guide/undo.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase, memoryEngine } from '@alexify/syncom/all';
import { createMesh, settle } from '@alexify/syncom/testing';

const mesh = await createMesh(['laptop', 'phone'], [['phone', 'laptop']], {
  createStorage: (name, options) =>
    createDatabase({ ...options, engine: memoryEngine(), schema: { entities: { Task: {} } } }),
});
const [laptop, phone] = [mesh.get('laptop'), mesh.get('phone')];
const board = laptop;
const task = await board.Task.insert({ title: 'Draft the plan', done: false });
await settle(mesh.storages);

// #region basic
import { createUndo } from '@alexify/syncom/undo';

const undo = createUndo(board); // this node's own writes, from now on
await board.Task.update(task.id, { title: 'Plan the release' });
await board.inc(task.id, 'votes', 1); // within 500 ms of the update: the same step

console.log(await undo.undo()); // { applied: 2, skipped: 0 }
console.log(await board.Task.get(task.id)); // { title: 'Draft the plan', done: false, '$type': 'Task' }
console.log(await undo.redo()); // { applied: 2, skipped: 0 }
console.log(await board.Task.get(task.id)); // { title: 'Plan the release', done: false, '$type': 'Task', votes: 1 }
undo.mark(); // the next write starts a new step
console.log(undo.canUndo, undo.canRedo, undo.size); // true false { undo: 1, redo: 0 }
// #endregion basic
assert.deepEqual(await board.Task.get(task.id), { title: 'Plan the release', done: false, $type: 'Task', votes: 1 });
assert.deepEqual(undo.size, { undo: 1, redo: 0 });

// #region conflict
await board.Task.update(task.id, { done: true }); // the laptop ticks the task...
await board.inc(task.id, 'votes', 5); // ...and votes
await settle(mesh.storages);
await phone.Task.update(task.id, { done: false }); // the phone unticks it
await phone.inc(task.id, 'votes', 10); // and votes too
await settle(mesh.storages);

console.log(await undo.undo()); // { applied: 1, skipped: 1 }
console.log(await board.Task.get(task.id));
// { title: 'Plan the release', done: false, '$type': 'Task', votes: 11 }:
// the phone's `done` is left alone, the laptop's 5 votes are taken back, the phone's 10 stay
// #endregion conflict
assert.deepEqual(await board.Task.get(task.id), {
  title: 'Plan the release',
  done: false,
  $type: 'Task',
  votes: 11,
});

// #region group
await undo.group(async () => {
  await board.Task.update(task.id, { title: 'Release 1.0' });
  await new Promise((resolve) => setTimeout(resolve, 600)); // longer than the merge interval...
  await board.Task.update(task.id, { done: true });
}); // ...still one step
await undo.undo(); // both changes go back together
// #endregion group
assert.equal((await board.Task.get(task.id)).title, 'Plan the release');
assert.equal((await board.Task.get(task.id)).done, false);
undo.stop();

// #region editor
await board.updateText(task.id, 'notes', 'Ship on Monday');
let caret = null; // the editor's caret, kept as a cursor token before each edit
const editorUndo = createUndo(board, {
  trackedSources: ['editor'], // the editor's transactions alone
  paths: ['notes'], // its field alone: a title change elsewhere is not undone here
  onPush: ({ step }) => {
    step.meta.caret ??= caret; // where the caret was when the step began
  },
  onPop: async ({ step }) => {
    const at = await board.position(task.id, 'notes', step.meta.caret);
    console.log('put the caret back at', at?.index); // put the caret back at 7
  },
});

caret = await board.cursor(task.id, 'notes', 7);
await board.transact((tx) => tx.splice(task.id, 'notes', 7, 0, ', late'), { source: 'editor' });
await board.Task.update(task.id, { title: 'Not the editor’s' }); // not tracked
await editorUndo.undo(); // takes back ', late', leaves the title
// #endregion editor
assert.equal((await board.Task.get(task.id)).notes, 'Ship on Monday');
assert.equal(await board.index(task.id, 'notes', caret), 7);
assert.equal((await board.Task.get(task.id)).title, 'Not the editor’s');
editorUndo.stop();
await mesh.close();
