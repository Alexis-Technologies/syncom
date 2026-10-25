'use strict';

// Who wrote what (src/blame.js, the plugins' `editors`, the text plugin's
// `editorOf`): read from a record's metadata, the same on every node.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');
const { createMesh, settle } = require('./utils/mesh.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

test('lastEditorOf, editorsOf and editorOf name the node and the stamp, by kind, the same on every node', async (t) => {
  const createStorage = (t2, name, options) => {
    const storage = syncom.open({ path: `/${name}`, fsi: memory(), logger: false, defer: 0, ...options });
    t2.after(async () => (await storage).close().catch(() => {}));
    return storage;
  };
  const mesh = await createMesh(t, ['A', 'B'], [['A', 'B']], createStorage);
  const a = mesh.get('A');
  const b = mesh.get('B');
  const id = await a.insert({ title: 'a', n: 1 });
  await a.inc(id, 'hits', 2);
  await a.add(id, 'tags', ['x']);
  await a.splice(id, 'body', 0, 0, 'hello');
  await a.treeMove(id, 'outline', 'r');
  await settle([a, b]);
  await tick();
  await b.update(id, { title: 'b' });
  await b.inc(id, 'hits', 1);
  await b.add(id, 'tags', ['y']);
  await b.push(id, 'body', '!');
  await b.treeMove(id, 'outline', 'c', 'r');
  await b.mark(id, 'body', 0, 2, 'bold', true);
  await settle([a, b]);
  for (const storage of [a, b]) {
    const title = await storage.lastEditorOf(id, 'title');
    assert.strictEqual(title.origin, b.nodeId, 'the register: its last writer');
    assert.ok(Number.isInteger(title.ts));
    assert.strictEqual((await storage.lastEditorOf(id, 'n')).origin, a.nodeId);
    assert.strictEqual((await storage.lastEditorOf(id, 'hits')).origin, b.nodeId, 'the counter: the newest increment');
    assert.strictEqual(await storage.lastEditorOf(id, 'tags'), null, 'a set keeps no stamps');
    assert.strictEqual((await storage.lastEditorOf(id, 'body')).origin, b.nodeId, 'the text: the newest run or mark');
    assert.strictEqual((await storage.lastEditorOf(id, 'outline')).origin, b.nodeId, 'the tree: the newest move');
    assert.strictEqual(await storage.lastEditorOf(id, 'absent'), null);
    assert.deepStrictEqual(await storage.editorsOf(id), [a.nodeId, b.nodeId].sort());
    assert.deepStrictEqual(await storage.editorOf(id, 'body', 0), await a.editorOf(id, 'body', 0));
    assert.strictEqual((await storage.editorOf(id, 'body', 0)).origin, a.nodeId, 'typed by A');
    assert.strictEqual((await storage.editorOf(id, 'body', 5)).origin, b.nodeId, 'typed by B');
    assert.strictEqual(await storage.editorOf(id, 'body', 99), null);
    assert.strictEqual(await storage.editorOf(id, 'title', 0), null);
  }
  // Through a Record; what is not there; arguments.
  const record = await a.record(id);
  assert.strictEqual((await record.lastEditorOf('title')).origin, b.nodeId);
  assert.deepStrictEqual(await record.editorsOf(), [a.nodeId, b.nodeId].sort());
  assert.strictEqual((await record.editorOf('body', 5)).origin, b.nodeId);
  assert.strictEqual(await a.lastEditorOf('absent', 'title'), null);
  assert.deepStrictEqual(await a.editorsOf('absent'), []);
  await a.delete(id);
  assert.strictEqual(await a.lastEditorOf(id, 'title'), null);
  assert.deepStrictEqual(await a.editorsOf(id), []);
  await assert.rejects(() => a.lastEditorOf('bad id!', 'title'), { code: 'INVALID_ID' });
  await assert.rejects(() => a.lastEditorOf(id, 7), TypeError);
  await assert.rejects(() => a.editorOf(id, 'body', -1), TypeError);
  // A list: the inserter of an element; a counter a single node bumped twice names it once.
  const list = await a.insert({});
  await a.push(list, 'items', [1, 2]);
  await a.inc(list, 'count', 1);
  await a.inc(list, 'count', 1);
  assert.strictEqual((await a.editorOf(list, 'items', 1)).origin, a.nodeId);
  assert.deepStrictEqual(await a.editorsOf(list), [a.nodeId]);
});
