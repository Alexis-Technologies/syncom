'use strict';

// The files engine over every fsi that ships: memory, node:fs, the IndexedDB
// file store (fake-indexeddb), `atRest` and `layered` — the engine contract
// suite over each, plus what the files engine alone promises: nothing on disk
// changes (its layout is the one every database had).

const { describe, it } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
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

describe('files engine over memory()', () => {
  runEngineTests({ create: () => filesEngine(memory()), root: vroot });
  it('should follow the backend in its capabilities: memory has create and append', () => {
    const engine = filesEngine(memory());
    assert.strictEqual(engine.name, 'files');
    assert.strictEqual(engine.capabilities.exclusiveCreate, true);
    assert.strictEqual(engine.capabilities.append, true);
    assert.strictEqual(engine.capabilities.atomicBatch, false);
    assert.strictEqual(engine.capabilities.indexes, false);
    assert.strictEqual(isFsi(engine.fsi), true);
  });
  it('should make a database the directory, the files where they always were', async () => {
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
  it('should refuse what is no fsi in filesEngine()', () => {
    assert.throws(() => filesEngine({ read() {} }), { name: 'ArgumentError', message: /adapter has no write\(\)/ });
    assert.strictEqual(isEngine(filesEngine(memory())), true);
  });
});

describe('files engine over node:fs', () => {
  runEngineTests({ create: () => filesEngine(nodeFsi), root: createTemp, afterEach: cleanupTemp });
});

describe('files engine over the IndexedDB file store', () => {
  runEngineTests({
    create: () => filesEngine(createIdbFsi({ indexedDB: new IDBFactory(), name: 'app' })),
    root: vroot,
  });
  it('should report the capabilities no create and no append', () => {
    const engine = filesEngine(createIdbFsi({ indexedDB: new IDBFactory(), name: 'app' }));
    assert.strictEqual(engine.capabilities.exclusiveCreate, false);
    assert.strictEqual(engine.capabilities.append, false);
  });
});

describe('files engine over atRest(memory())', () => {
  runEngineTests({ create: () => filesEngine(atRest(memory(), { key: KEY })), root: vroot });
});

describe('files engine over layered([memory(), memory()])', () => {
  runEngineTests({ create: () => filesEngine(layered([memory(), memory()])), root: vroot });
});

// What the files engine alone must get right: a name is a file, so the order
// is the ids' (not the backend's listing) and a name stays inside the directory.
describe('files engine: names that become files', () => {
  const stored = (data) => ({
    data,
    meta: { clock: {}, base: 0, deleted: 0 },
    encrypted: false,
    timestamp: 1,
    block: null,
  });

  it('should answer ids and a tag’s copies in id order whatever order the backend lists in', async () => {
    const base = memory();
    const fsi = {
      ...base,
      async list(dir) {
        return (await base.list(dir)).reverse();
      },
    };
    const db = await filesEngine(fsi).open('/order', { logger: null });
    const ids = ['a', 'a-b', 'b', 'a.b', 'Z', 'z', 'a_1'];
    const rows = [];
    for (const id of ids) rows.push({ id, stored: stored({ id }) });
    await db.write({ records: rows });
    const sorted = ids.slice().sort();
    assert.deepStrictEqual(await db.records.ids(), sorted);
    const paged = [];
    let after = null;
    for (;;) {
      const page = await db.records.ids({ after, limit: 2 });
      if (page.length === 0) break;
      for (const id of page) paged.push(id);
      after = page[page.length - 1];
    }
    assert.deepStrictEqual(paged, sorted, 'paging by the last id skips none');
    for (const id of ids) await db.copies.put('v1', id, '{}');
    assert.deepStrictEqual(await db.copies.ids('v1'), sorted);
    await db.close();
  });

  it('should refuse a name that would leave the directory before it reaches the backend', async () => {
    const db = await filesEngine(memory()).open('/names', { logger: null });
    await assert.rejects(() => db.kv.get('..', 'x'), TypeError);
    await assert.rejects(() => db.kv.put('', '../x', 'v'), TypeError);
    await assert.rejects(() => db.kv.put('', 'a/b', 'v'), TypeError);
    await assert.rejects(() => db.kv.list('a\\b'), TypeError);
    await assert.rejects(() => db.kv.has('', ''), TypeError);
    await assert.rejects(() => db.pieces.get('id', '../x'), TypeError);
    await assert.rejects(() => db.copies.get('../t', 'id'), TypeError);
    await assert.rejects(() => db.write({ kv: { put: [['', 'a/b', 'v', undefined]] } }), TypeError);
    await assert.rejects(() => db.write({ records: [{ id: '../x', text: '{}' }] }), TypeError);
    await assert.rejects(() => db.write({ copies: { put: [['..', 'r', '{}']] } }), TypeError);
    await db.kv.put('tags/v1/index', 'catalog.json', '{}');
    assert.strictEqual(await db.kv.get('tags/v1/index', 'catalog.json'), '{}', 'a namespace is a path of keys');
    await db.close();
  });
});

describe('files engine: remove(path) says what it could not sweep', () => {
  it('should fail remove(path) rather than leave files behind when a directory cannot be listed', async () => {
    const base = memory();
    const fsi = {
      ...base,
      async list(dir) {
        if (dir === '/sweep/data') throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
        return base.list(dir);
      },
    };
    const engine = filesEngine(fsi);
    const db = await engine.open('/sweep', { logger: null });
    await db.kv.put('', 'node.json', '{}');
    await db.close();
    await assert.rejects(engine.remove('/sweep'), { code: 'EIO' });
    const gone = await filesEngine(base).open('/missing', { logger: null });
    await gone.close();
    await filesEngine(base).remove('/missing');
  });

  it('should sweep a tag’s two directories by its name alone in remove(path), ignoring a name that leaves the path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syncom-tags-'));
    try {
      const dbPath = path.join(root, 'db');
      const victim = path.join(root, 'victim');
      await nodeFsi.write(dbPath, 'node.json', '{"id":"n"}');
      await nodeFsi.write(dbPath, 'tags.json', JSON.stringify({ tags: [{ name: '../victim' }, { name: 'ok' }] }));
      await nodeFsi.write(`${dbPath}/tags/ok/data`, 'r.json', '{}');
      await nodeFsi.write(`${victim}/data`, 'r.json', '{}');
      await filesEngine(nodeFsi).remove(dbPath);
      assert.strictEqual(await nodeFsi.exists(`${victim}/data`, 'r.json'), true, 'a neighbour is not swept');
      assert.strictEqual(await nodeFsi.exists(`${dbPath}/tags/ok/data`, 'r.json'), false, 'the tag named is');
      assert.strictEqual(await nodeFsi.exists(dbPath, 'node.json'), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
