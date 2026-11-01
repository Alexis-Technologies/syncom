'use strict';

// The files engine over every fsi that ships: memory, node:fs, the IndexedDB
// file store (fake-indexeddb), `atRest` and `layered` — the engine contract
// suite over each, plus what the files engine alone promises: nothing on disk
// changes (its layout is the one every database had).

const test = require('node:test');
const assert = require('node:assert');
const { IDBFactory } = require('fake-indexeddb');
const nodeFsi = require('../src/fsi.js');
const { filesEngine, DIRS } = require('../src/files/files.js');
const { isEngine, isFsi } = require('../src/index.js');
const { memory } = require('../src/memory/memory.js');
const { layered } = require('../src/layered/layered.js');
const { atRest } = require('../src/encryption/encryption.js');
const { createIdbFsi } = require('../src/idb/idb.js');
const { runEngineTests } = require('./suites/engine.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');

const KEY = new Uint8Array(32).fill(7);
let n = 0;
const vroot = async () => `/engine-${Date.now()}-${++n}`;

test('files engine over memory()', async (t) => {
  await runEngineTests(t, { create: () => filesEngine(memory()), root: vroot });
  await t.test('capabilities follow the backend: memory has create and append', () => {
    const engine = filesEngine(memory());
    assert.strictEqual(engine.name, 'files');
    assert.strictEqual(engine.capabilities.exclusiveCreate, true);
    assert.strictEqual(engine.capabilities.append, true);
    assert.strictEqual(engine.capabilities.atomicBatch, false);
    assert.strictEqual(engine.capabilities.indexes, false);
    assert.strictEqual(isFsi(engine.fsi), true);
  });
  await t.test('a database is the directory: the files are where they always were', async () => {
    const fsi = memory();
    const db = await filesEngine(fsi).open('app', { logger: null });
    await db.kv.put('', 'node.json', '{"id":"n"}');
    await db.kv.put('index', 'catalog.json', '{}');
    await db.write({
      records: [{ id: 'r', text: '{"data":{}}', pieces: { put: [['r~1.json', '{}']] } }],
      kv: { put: [['blockchain', 'h.json', '{}', undefined]] },
      copies: { put: [['v1', 'r', '{}']] },
    });
    assert.deepStrictEqual(Object.keys(fsi.dump()).sort(), [
      'app/blockchain/h.json',
      'app/data/r.json',
      'app/data/r~1.json',
      'app/index/catalog.json',
      'app/node.json',
      'app/tags/v1/data/r.json',
    ]);
    assert.deepStrictEqual(DIRS.slice(0, 3), ['', 'keys', 'blockchain']);
  });
  await t.test('filesEngine() refuses what is no fsi', () => {
    assert.throws(() => filesEngine({ read() {} }), { name: 'TypeError', message: /adapter has no write\(\)/ });
    assert.strictEqual(isEngine(filesEngine(memory())), true);
  });
});

test('files engine over node:fs', async (t) => {
  await runEngineTests(t, { create: () => filesEngine(nodeFsi), root: createTemp, afterEach: cleanupTemp });
});

test('files engine over the IndexedDB file store', async (t) => {
  await runEngineTests(t, {
    create: () => filesEngine(createIdbFsi({ indexedDB: new IDBFactory(), name: 'app' })),
    root: vroot,
  });
  await t.test('capabilities: no create, no append', () => {
    const engine = filesEngine(createIdbFsi({ indexedDB: new IDBFactory(), name: 'app' }));
    assert.strictEqual(engine.capabilities.exclusiveCreate, false);
    assert.strictEqual(engine.capabilities.append, false);
  });
});

test('files engine over atRest(memory())', async (t) => {
  await runEngineTests(t, { create: () => filesEngine(atRest(memory(), { key: KEY })), root: vroot });
});

test('files engine over layered([memory(), memory()])', async (t) => {
  await runEngineTests(t, { create: () => filesEngine(layered([memory(), memory()])), root: vroot });
});
