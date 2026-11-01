'use strict';

// Files land at once here (`defer: 0`): what these tests read of the disk is the engine's, not the window's — the window has tests of its own (storage.defer, storage.group).

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { runTagTests } = require('./suites/tags.js');
const { memory } = require('../src/memory/memory.js');

test('Tags (node)', async (t) => {
  // The same name within one subtest reopens the same directory.
  const dirs = new Map();
  await runTagTests(t, assert, async (t2, name, options = {}) => {
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

test('a tag read while the window lays the record reads as the tag: the copy first, never the new file', async () => {
  // The record's file read for the tag is held until the window's flush has
  // laid the tag's copy and the new file (or 50 ms, whichever comes first):
  // a read of the file as it is would hand the tag the record as it is now.
  const base = memory();
  let gate = null;
  const fsi = {
    ...base,
    async read(dir, name) {
      if (gate === null || dir !== '/tags-race/data' || name !== gate.name) return base.read(dir, name);
      const held = gate;
      gate = null;
      await Promise.race([held.written, new Promise((resolve) => setTimeout(resolve, 50))]);
      return base.read(dir, name);
    },
    async write(dir, name, content) {
      await base.write(dir, name, content);
      if (gate !== null && dir === '/tags-race/data' && name === gate.name) gate.wrote();
    },
  };
  const storage = await syncom.open({ path: '/tags-race', fsi, logger: false, defer: 1000 });
  try {
    const id = await storage.insert({ title: 'a' });
    await storage.tag('v1');
    await storage.update(id, { title: 'b' });
    let wrote;
    gate = { name: `${id}.json`, written: new Promise((resolve) => (wrote = resolve)), wrote: () => wrote() };
    const read = storage.diff(id, { tag: 'v1' });
    const flushed = storage.flush();
    assert.deepStrictEqual(await read, [{ action: 'put', field: 'title', value: 'b' }]);
    await flushed;
    assert.deepStrictEqual((await storage.get(id, { at: { tag: 'v1' } })).title, 'a');
  } finally {
    await storage.close();
  }
});
