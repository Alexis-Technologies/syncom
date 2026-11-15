// The Sharding page (docs/guide/sharding.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';

// #region by-path
import { createDatabase } from '@alexify/syncom/all';

const schema = { entities: { Task: { index: ['done'] } } };

// One database per team: its own directory, log, catalog and sync.
const boards = new Map();
for (const team of ['design', 'platform', 'sales']) {
  boards.set(team, await createDatabase({ path: `boards/${team}`, schema }));
}
await boards.get('design').Task.insert({ title: 'New logo', done: false });
await boards.get('sales').Task.insert({ title: 'Call the printer', done: false });

// A question across teams is a query per database, combined by you.
let open = 0;
for (const board of boards.values()) open += await board.Task.count({ done: false });
console.log(open); // 2
// #endregion by-path
assert.equal(open, 2);
assert.equal(await boards.get('platform').Task.count({}), 0);
for (const board of boards.values()) await board.close();
