// The Versions and history page (docs/guide/versions.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
// #region history
import { createDatabase, memoryEngine } from '@alexify/syncom/all';

const board = await createDatabase({
  engine: memoryEngine(),
  schema: { entities: { Task: { index: ['done'] } } },
});
const task = await board.Task.insert({ title: 'Draft the plan', done: false });
await board.Task.update(task.id, { title: 'Plan the release' });
await board.inc(task.id, 'votes', 1);

const { versions, complete, exact } = await board.history(task.id);
for (const version of versions) console.log(version.eventId, version.type, version.fields, version.data);
// mw….3 inc   [ 'votes' ]                  { title: 'Plan the release', done: false, '$type': 'Task', votes: 1 }
// mw….2 set   [ 'title' ]                  { title: 'Plan the release', done: false, '$type': 'Task' }
// mw….1 write [ 'title', 'done', '$type' ] { title: 'Draft the plan', done: false, '$type': 'Task' }
console.log(complete, exact); // true true: every op this node applied to the record, as it held them

console.log(await board.Task.get(task.id, { at: versions[2].eventId })); // { title: 'Draft the plan', … }
console.log(await board.Task.get(task.id, { at: versions[1].ts })); // by stamp: { title: 'Plan the release', … }
// #endregion history
assert.equal(versions.length, 3);
assert.deepEqual(
  versions.map((version) => version.type),
  ['inc', 'set', 'write'],
);
assert.equal(complete, true);
assert.equal(exact, true);
assert.equal((await board.Task.get(task.id, { at: versions[2].eventId })).title, 'Draft the plan');
assert.equal((await board.Task.get(task.id, { at: versions[1].ts })).title, 'Plan the release');
assert.equal((await board.Task.get(task.id, { at: versions[1].ts })).votes, undefined);

// #region vector
const seen = structuredClone(board.vector); // this node's version vector, now
await board.Task.update(task.id, { done: true });
console.log((await board.Task.get(task.id, { at: { vector: seen } })).done); // false
// #endregion vector
assert.equal((await board.Task.get(task.id, { at: { vector: seen } })).done, false);

// #region tag
await board.tag('v1'); // the whole database, as it is now
await board.Task.update(task.id, { title: 'Release 1.0' });
const later = await board.Task.insert({ title: 'Plan 1.1', done: false });

const v1 = board.at('v1');
console.log((await v1.get(task.id)).title); // 'Plan the release'
console.log(await v1.get(later.id)); // null: not there yet
console.log(await v1.collection('Task').count({ done: true })); // 1, queried as of v1
console.log((await board.Task.get(task.id, { at: { tag: 'v1' } })).title); // the same read, by `at`
console.log(board.tags().map((tag) => tag.name)); // [ 'v1' ]
// #endregion tag
assert.equal((await v1.get(task.id)).title, 'Plan the release');
assert.equal(await v1.get(later.id), null);
assert.equal(await v1.collection('Task').count({ done: true }), 1);
assert.equal(await v1.has(later.id), false);

// #region diff
console.log(await board.diff(task.id, { tag: 'v1' })); // from v1 to now
// [ { action: 'put', field: 'title', value: 'Release 1.0' } ]
await board.restore(task.id, { tag: 'v1' }); // new ops that lead back
console.log((await board.Task.get(task.id)).title); // 'Plan the release'
await board.applyPatches(task.id, [{ action: 'inc', field: 'votes', value: 2 }]); // patches by hand
// #endregion diff
assert.deepEqual(await board.diff(task.id, versions[0].eventId, { tag: 'v1' }), [
  { action: 'put', field: 'done', value: true },
]);
assert.equal((await board.Task.get(task.id)).title, 'Plan the release');
assert.equal((await board.Task.get(task.id)).votes, 3);
assert.equal((await board.history(task.id)).versions[0].type, 'inc', 'a restore is a version of its own');
await board.untag('v1');

// #region commit
board.on('commit', ({ op, seq, txn, source, before, after, kinds, changes }) => {
  console.log(op.type, changes); // what this node's own write changed, in the write API's terms
  // set [ { action: 'put', field: 'done', value: false } ]
});
await board.Task.update(task.id, { done: false });
// #endregion commit
board.off('commit');

// #region blame
console.log(await board.lastEditorOf(task.id, 'title')); // { origin: '<node id>', ts: 1794… }
console.log(await board.editorsOf(task.id)); // [ '<node id>' ]: every node whose writes the record carries
await board.updateText(task.id, 'notes', 'Ship it');
console.log(await board.editorOf(task.id, 'notes', 0)); // who typed the character at 0, and when
// #endregion blame
assert.equal((await board.lastEditorOf(task.id, 'title')).origin, board.nodeId);
assert.deepEqual(await board.editorsOf(task.id), [board.nodeId]);
assert.equal((await board.editorOf(task.id, 'notes', 0)).origin, board.nodeId);

// #region gone
const before = board.log.lastEventId;
await board.purge(later.id);
try {
  await board.Task.get(later.id, { at: before });
} catch (error) {
  if (error.code !== 'HISTORY_GONE') throw error;
  console.log(error.reason); // 'scrubbed': the purge took the payload; 'compacted' when retention dropped it
}
// #endregion gone
await assert.rejects(board.Task.get(later.id, { at: before }), { code: 'HISTORY_GONE', reason: 'scrubbed' });
await board.close();
