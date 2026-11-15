// The App state page (docs/guide/state.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createMesh, settle, memoryEngine } from '@alexify/syncom/testing';

// #region create
import { createDatabase } from '@alexify/syncom/all';
import { createState } from '@alexify/syncom/state';

const board = await createDatabase({ path: 'board' });
const settings = createState(board, 'settings');

await settings.set('theme', 'dark');
await settings.set('filters/done', false);
console.log(await settings.get('theme')); // 'dark'
console.log(await settings.get()); // { theme: 'dark', filters: { done: false } }
// #endregion create
assert.equal(await settings.get('theme'), 'dark');
assert.deepEqual(await settings.get(), { theme: 'dark', filters: { done: false } });

// #region update
await settings.set('opened', (count) => (count ?? 0) + 1); // computed from the value as it is
await settings.delete('filters/done');
console.log(await settings.get()); // { theme: 'dark', opened: 1 }
// #endregion update
assert.equal(await settings.get('opened'), 1);
assert.equal(await settings.get('filters/done'), undefined);

// #region observe
const stop = settings.observe('theme', (theme) => console.log('theme is now', theme));
await settings.set('theme', 'light'); // theme is now light
stop();
// #endregion observe
const themes = [];
const stopAgain = settings.observe('theme', (theme) => themes.push(theme));
await settings.set('theme', 'dark');
await new Promise((resolve) => setTimeout(resolve, 10));
stopAgain();
assert.deepEqual(themes, ['dark']);

// #region record
console.log(settings.id); // 'state.settings': a record like any other
console.log(await board.get('state.settings')); // { theme: 'dark', opened: 1 }
// #endregion record
assert.equal(settings.id, 'state.settings');
assert.equal((await board.get('state.settings')).theme, 'dark');

// #region local
const ui = createState(board, 'ui', { local: true }); // this node's alone: never an op, never synced
await ui.set('sidebar/width', 320);
console.log(await ui.get()); // { sidebar: { width: 320 } }
// #endregion local
assert.deepEqual(await ui.get(), { sidebar: { width: 320 } });
assert.equal(await board.get('state.ui'), null);
await board.close();

// #region peers
const mesh = await createMesh(['laptop', 'phone'], [['phone', 'laptop']], {
  createStorage: (name, options) => createDatabase({ ...options, engine: memoryEngine(), path: name }),
});
const onLaptop = createState(mesh.get('laptop'), 'settings');
const onPhone = createState(mesh.get('phone'), 'settings');

await onLaptop.set('theme', 'light'); // the first write makes the record...
await settle(mesh.storages); // ...and both nodes have it

await Promise.all([onLaptop.set('theme', 'dark'), onPhone.set('language', 'uk')]); // at the same time
await settle(mesh.storages);
console.log(await onPhone.get()); // { theme: 'dark', language: 'uk' }: both writes kept
// #endregion peers
assert.deepEqual(await onLaptop.get(), { theme: 'dark', language: 'uk' });
assert.deepEqual(await onPhone.get(), { theme: 'dark', language: 'uk' });
await mesh.close();

// The first write of a state makes its record whole: two nodes that make it at the same time keep one of the two.
const race = await createMesh(['laptop', 'phone'], [['phone', 'laptop']], {
  createStorage: (name, options) => createDatabase({ ...options, engine: memoryEngine(), path: name }),
});
const a = createState(race.get('laptop'), 'settings');
const b = createState(race.get('phone'), 'settings');
await Promise.all([a.set('theme', 'dark'), b.set('language', 'uk')]);
await settle(race.storages);
assert.equal(Object.keys(await a.get()).length, 1);
assert.deepEqual(await a.get(), await b.get());
await race.close();
