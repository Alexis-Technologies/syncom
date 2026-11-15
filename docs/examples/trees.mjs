// The Trees page (docs/guide/trees.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
// #region build
import { createDatabase, memoryEngine } from '@alexify/syncom/all';

const db = await createDatabase({ engine: memoryEngine() });
const docs = await db.insert({ title: 'Docs outline' });

await db.treeMove(docs, 'outline', 'guide'); // a root
await db.treeMove(docs, 'outline', 'install', 'guide'); // under 'guide', last
await db.treeMove(docs, 'outline', 'intro', 'guide', { before: 'install' }); // under 'guide', before 'install'
await db.treeMove(docs, 'outline', 'reference'); // another root, after 'guide'
console.log(JSON.stringify((await db.get(docs)).outline));
// [{"id":"guide","children":[{"id":"intro","children":[]},{"id":"install","children":[]}]},
//  {"id":"reference","children":[]}]
// #endregion build
assert.deepEqual((await db.get(docs)).outline, [
  {
    id: 'guide',
    children: [
      { id: 'intro', children: [] },
      { id: 'install', children: [] },
    ],
  },
  { id: 'reference', children: [] },
]);

// #region remove
await db.treeRemove(docs, 'outline', 'guide'); // 'guide' goes, and 'intro' and 'install' with it
console.log((await db.get(docs)).outline.length); // 1
await db.treeMove(docs, 'outline', 'guide', null, { after: 'reference' }); // back, with its children
// #endregion remove
assert.deepEqual((await db.get(docs)).outline, [
  { id: 'reference', children: [] },
  {
    id: 'guide',
    children: [
      { id: 'intro', children: [] },
      { id: 'install', children: [] },
    ],
  },
]);

// #region data
await db.update(docs, { 'outline/intro/title': 'Introduction' }); // a field of the node 'intro'
console.log((await db.get(docs)).outline[1].children[0]);
// { id: 'intro', children: [], data: { title: 'Introduction' } }
// #endregion data
assert.deepEqual((await db.get(docs)).outline[1].children[0], {
  id: 'intro',
  children: [],
  data: { title: 'Introduction' },
});

// #region errors
try {
  await db.treeMove(docs, 'outline', 'guide', 'install'); // under its own child
} catch (error) {
  console.log(error.code); // CYCLE
}
try {
  await db.treeMove(docs, 'outline', 'faq', 'guide', { after: 'reference' }); // 'reference' is not under 'guide'
} catch (error) {
  console.log(error.code); // NOT_FOUND
}
// #endregion errors
await assert.rejects(db.treeMove(docs, 'outline', 'guide', 'install'), { code: 'CYCLE' });
await assert.rejects(db.treeMove(docs, 'outline', 'faq', 'guide', { after: 'reference' }), { code: 'NOT_FOUND' });
await assert.rejects(db.update(docs, { outline: [] }), { code: 'FIELD_KIND', kind: 'tree' });
await db.close();

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
const id = await server.insert({ title: 'Docs outline' });
await server.treeMove(id, 'outline', 'guide');
await server.treeMove(id, 'outline', 'reference');
await settle(mesh.storages);

await laptop.sync.stop();
await phone.sync.stop();
await laptop.treeMove(id, 'outline', 'guide', 'reference'); // 'guide' under 'reference'
await new Promise((resolve) => setTimeout(resolve, 10)); // a moment later...
await phone.treeMove(id, 'outline', 'reference', 'guide'); // ...'reference' under 'guide'
await laptop.sync.start();
await phone.sync.start();
await settle(mesh.storages);

console.log(JSON.stringify((await phone.get(id)).outline));
// [{"id":"reference","children":[{"id":"guide","children":[]}]}]: the older move stands, on every node
// #endregion concurrent
const expected = [{ id: 'reference', children: [{ id: 'guide', children: [] }] }];
assert.deepEqual((await phone.get(id)).outline, expected);
assert.deepEqual((await laptop.get(id)).outline, expected);
assert.deepEqual((await server.get(id)).outline, expected);
await mesh.close();
