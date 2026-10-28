'use strict';

// Files land at once here (`defer: 0`): what these tests read of the disk is the engine's, not the window's — the window has tests of its own (storage.defer, storage.group).

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { runUndoTests } = require('./suites/undo.js');

test('Undo (node)', async (t) => {
  const dirs = new Map();
  await runUndoTests(t, assert, async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    let dir = dirs.get(key);
    if (!dir) {
      dir = await createTemp();
      dirs.set(key, dir);
      t2.after(() => cleanupTemp(dir));
    }
    const storage = await syncom.open({ defer: 0, path: dir, logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  });
});

test('a commit event read late still says the record as that commit left it, in copies', async () => {
  const { memory } = require('../src/memory/memory.js');
  const syncomAll = require('../src/all/all.js');
  const storage = await syncomAll.open({ fsi: memory(), lock: false, defer: 0, logger: false });
  const events = [];
  storage.on('commit', (event) => void events.push(event));
  const id = await storage.insert({ title: 'a', tags: [] });
  await storage.update(id, { title: 'b' });
  await storage.push(id, 'body', 'hello');
  await storage.update(id, { title: 'c', nested: { deep: 1 } });
  await storage.unset(id, ['nested']);
  // Read only now, after every write.
  assert.deepStrictEqual(
    events.map((event) => event.after.title),
    ['a', 'b', 'b', 'c', 'c'],
  );
  assert.deepStrictEqual(events[1].before, { title: 'a', tags: [] });
  assert.deepStrictEqual(events[3].after.nested, { deep: 1 });
  assert.strictEqual(events[4].after.nested, undefined);
  assert.strictEqual(events[2].after.body, 'hello');
  // Copies: changing one changes nothing else.
  events[3].after.nested.deep = 99;
  assert.strictEqual(events[3].after.nested.deep, 99, 'the same copy every read');
  assert.deepStrictEqual((await storage.get(id)).title, 'c');
  assert.strictEqual(events[0].before, null, 'a new record had nothing before it');
  await storage.close();
});
