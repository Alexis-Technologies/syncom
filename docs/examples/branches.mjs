// The Branches page (docs/guide/branches.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';

const schema = { entities: { Task: {} } };
const board = await createDatabase({ path: 'board', schema });
const task = await board.Task.insert({ title: 'Plan the release' });
const before = board.log.lastEventId;
await board.tag('v1');

// #region branch
import { branch, merge, branchInfo, drop } from '@alexify/syncom/branch';

const draft = await branch(board, { path: 'board-draft', schema }); // a new database, at board's present
await draft.Task.update(task.id, { title: 'Plan the release, reworked' }); // a database like any other
await board.inc(task.id, 'votes', 1); // the parent moves on meanwhile

console.log(await merge(draft, { into: board })); // { ops: 1, pages: 1, joined: false }
console.log(await board.Task.get(task.id));
// { title: 'Plan the release, reworked', '$type': 'Task', votes: 1 }: both sides kept
await merge(board, { into: draft }); // and the parent's news the other way
// #endregion branch
assert.deepEqual(await board.Task.get(task.id), { title: 'Plan the release, reworked', $type: 'Task', votes: 1 });
assert.deepEqual(await draft.Task.get(task.id), await board.Task.get(task.id));
assert.deepEqual(await merge(draft, { into: board }), { ops: 0, pages: 0, joined: false }, 'nothing left to hand over');

// #region from
const atTag = await branch(board, { path: 'board-v1', from: { tag: 'v1' }, schema });
const atVersion = await branch(board, { path: 'board-before', from: { at: before }, schema });
console.log((await atTag.Task.get(task.id)).title); // 'Plan the release'
// #endregion from
assert.equal((await atTag.Task.get(task.id)).title, 'Plan the release');
assert.equal((await atVersion.Task.get(task.id)).title, 'Plan the release');

// #region info
console.log(await branchInfo(draft));
// { parent: '<board's node id>', forkedAt: { eventId, vector, ts, tag: null, at: null }, createdAt }
console.log(await branchInfo(board)); // null: board is no branch
await drop(draft); // closed, and its files removed
// #endregion info
assert.equal(await branchInfo(board), null);
assert.equal((await branchInfo(atTag)).forkedAt.tag, 'v1');
await assert.rejects(branch(board, { path: 'board-v1', schema }), { code: 'ALX_ERR_BRANCH_EXISTS' });
await assert.rejects(drop(board), TypeError);
await drop(atTag);
await drop(atVersion);
await board.close();
