// The Local documents page (docs/guide/local.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createMesh, settle, memoryEngine } from '@alexify/syncom/testing';

// #region basics
import { createDatabase } from '@alexify/syncom/all'; // the local plugin is in /all

const board = await createDatabase({ path: 'board', schema: { entities: { Task: {} } } });

await board.local.set('layout', { sidebar: 320, theme: 'dark' });
console.log(await board.local.get('layout')); // { sidebar: 320, theme: 'dark' }
console.log(await board.local.list()); // [ 'layout' ]
await board.local.delete('layout');
console.log(await board.local.get('layout')); // null
// #endregion basics
assert.equal(await board.local.get('layout'), null);

// #region plugin
import { createDatabase as createCore } from '@alexify/syncom';
import { local } from '@alexify/syncom/local';

const lean = await createCore({ path: 'lean', plugins: [local] }); // the core alone, with the plugin
await lean.local.set('draft', 'Half a sentence');
// #endregion plugin
assert.equal(await lean.local.get('draft'), 'Half a sentence');
await lean.close();

// #region collection
await board.Task.local.set('filter', { done: false });
console.log(await board.Task.local.list()); // [ 'filter' ]
console.log(await board.local.list()); // [ 'Task.filter' ]: the same store, under the collection's prefix
// #endregion collection
assert.deepEqual(await board.local.list(), ['Task.filter']);

// #region function
await Promise.all([
  board.local.set('opened', (count) => (count ?? 0) + 1),
  board.local.set('opened', (count) => (count ?? 0) + 1),
]);
console.log(await board.local.get('opened')); // 2: the changes of one key go one at a time
// #endregion function
assert.equal(await board.local.get('opened'), 2);

// #region observe
const stop = board.local.observe('draft', (value) => console.log('draft:', value));
await board.local.set('draft', 'Buy milk'); // draft: Buy milk
await board.local.delete('draft'); // draft: null
stop();

board.on('local', ({ key, value }) => console.log(key, value)); // every local write of this instance
// #endregion observe
const heard = [];
const stopAgain = board.local.observe('draft', (value) => heard.push(value));
await board.local.set('draft', 'x');
await board.local.delete('draft');
stopAgain();
assert.deepEqual(heard, ['x', null]);
board.off('local');
await board.close();

// #region closed
const closed = await board.local.set('late', 1).catch((error) => error);
console.log(closed.code); // ALX_ERR_CLOSED
// #endregion closed
assert.equal(closed.code, 'ALX_ERR_CLOSED');

// #region peers
const mesh = await createMesh(['laptop', 'phone'], [['phone', 'laptop']], {
  createStorage: (name, options) => createDatabase({ ...options, engine: memoryEngine(), path: name }),
});
await mesh.get('laptop').local.set('window', { width: 1440 });
await mesh.get('laptop').insert({ title: 'a record syncs' });
await settle(mesh.storages);
console.log(await mesh.get('phone').list()); // [ '…' ]: the record arrived
console.log(await mesh.get('phone').local.get('window')); // null: the local document did not
// #endregion peers
assert.equal((await mesh.get('phone').list()).length, 1);
assert.equal(await mesh.get('phone').local.get('window'), null);
await mesh.close();
