'use strict';

// `atRest(engine, options)`: the engine contract over an engine whose every
// value is ciphertext — the records, their pieces, the copies, the kv texts,
// the log's entries and index — read back with the key and refused without it.

const test = require('node:test');
const assert = require('node:assert');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const { createDatabase, memoryEngine, filesEngine } = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');
const { idbEngine } = require('../src/idb/idb.js');
const { atRest } = require('../src/encryption/encryption.js');
const { runEngineTests, stored } = require('./suites/engine.js');

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 1);
const OTHER = new Uint8Array(32).fill(9);
const PREFIX = 'enc1:';

let n = 0;
const vroot = async () => `/sealed-${++n}`;

test('an engine encrypted at rest', async (t) => {
  await t.test('the contract over the engine in memory', async (t2) => {
    await runEngineTests(t2, { create: () => atRest(memoryEngine(), { key: KEY }), root: vroot });
  });
  await t.test('the contract over the engine in IndexedDB', async (t2) => {
    const fresh = () => atRest(idbEngine({ indexedDB: new IDBFactory(), IDBKeyRange, channel: null }), { key: KEY });
    await runEngineTests(t2, { create: fresh, root: vroot });
  });

  await t.test(
    'names and capabilities: the engine’s, without indexes; the files engine is wrapped at its backend',
    () => {
      const inner = memoryEngine();
      const engine = atRest(inner, { key: KEY });
      assert.strictEqual(engine.name, 'at-rest:memory');
      assert.strictEqual(engine.capabilities.atomicBatch, inner.capabilities.atomicBatch);
      assert.strictEqual(engine.capabilities.exclusiveCreate, true);
      assert.strictEqual(engine.capabilities.indexes, false);
      assert.throws(() => atRest(filesEngine(memory()), { key: KEY }), {
        name: 'TypeError',
        message: /filesEngine\(atRest/,
      });
      assert.throws(() => atRest(inner), { name: 'TypeError', message: /key|password/ });
    },
  );

  await t.test(
    'a database over atRest(engine) reads nothing from the plain engine and the plain engine nothing of it: every value is enc1',
    async () => {
      const inner = memoryEngine();
      const options = { path: 'vault', logger: false, defer: 0, lock: false };
      const db = await createDatabase({ ...options, engine: atRest(inner, { key: KEY }) });
      const id = await db.insert({ title: 'Secret', $type: 'Note' });
      await db.push(id, 'body', 's'.repeat(3000));
      await db.tag('v1');
      await db.update(id, { title: 'Still secret' });
      await db.flush();
      assert.strictEqual(await db.validate(), true, 'the chain lives in sealed kv values');
      await db.close();
      // Inside: ciphertext everywhere, the keys in the clear.
      const plain = await inner.open('vault');
      const sealed = (text) => typeof text === 'string' && text.startsWith(PREFIX) && !text.includes('ecret');
      assert.ok(sealed(await plain.kv.get('', 'node.json')), 'node.json');
      assert.ok(sealed(await plain.kv.get('index', 'catalog.json')), 'the catalog');
      assert.ok(sealed(await plain.records.raw(id)), 'the record');
      await assert.rejects(() => plain.records.get(id), { code: 'INTEGRITY' }, 'no record to the plain engine');
      assert.deepStrictEqual(await plain.records.ids(), [id], 'the id in the clear');
      assert.ok(sealed(await plain.copies.get('v1', id)), 'the tag’s copy');
      const loaded = await plain.log.load();
      assert.ok(loaded.entries.length > 0);
      for (const entry of loaded.entries) {
        assert.strictEqual(typeof entry.seq, 'number', 'the seq in the clear');
        assert.ok(sealed(entry.e), 'the entry sealed');
        assert.strictEqual(entry.op, undefined);
      }
      assert.strictEqual(typeof loaded.index.floor, 'number', 'the floor in the clear');
      assert.ok(sealed(loaded.index.e), 'the index sealed');
      for (const key of await plain.kv.list('blockchain')) {
        assert.ok(sealed(await plain.kv.get('blockchain', key)), key);
      }
      // The key reads it all back, through another wrapper over the same engine.
      const again = await createDatabase({ ...options, engine: atRest(inner, { key: KEY }) });
      assert.strictEqual(again.nodeId, db.nodeId);
      assert.strictEqual((await again.get(id)).title, 'Still secret');
      assert.strictEqual((await again.get(id)).body.length, 3000);
      assert.deepStrictEqual((await again.at('v1').get(id)).title, 'Secret');
      assert.strictEqual(await again.validate(), true);
      assert.deepStrictEqual(await again.list(), [id], 'the catalog, rebuilt from sealed records');
      await again.purge(id);
      await again.close();
      // Another key opens nothing; the plain engine opens nothing of it either.
      await assert.rejects(() => createDatabase({ ...options, engine: atRest(inner, { key: OTHER }) }), {
        code: 'DECRYPT_FAILED',
        reason: 'key',
      });
      // The plain engine opens nothing of it: the first file it reads (the keys, node.json) is no file of its own.
      await assert.rejects(() => createDatabase({ ...options, engine: inner }));
      // And a plain database is refused by the wrapper as not encrypted.
      const open = await createDatabase({ ...options, path: 'open', engine: inner });
      await open.insert({ a: 1 });
      await open.close();
      await assert.rejects(() => createDatabase({ ...options, path: 'open', engine: atRest(inner, { key: KEY }) }), {
        code: 'DECRYPT_FAILED',
        reason: 'plain',
      });
    },
  );

  await t.test('a ciphertext moved to the same place in another database does not open', async () => {
    const inner = memoryEngine();
    const engine = atRest(inner, { key: KEY });
    const base = { engine, logger: false, defer: 0, lock: false };
    const a = await createDatabase({ ...base, path: 'tenant-a' });
    const id = await a.insert({ owner: 'a', balance: 100 });
    await a.close();
    const b = await createDatabase({ ...base, path: 'tenant-b' });
    await b.insert({ owner: 'b' });
    await b.close();
    // The record's ciphertext of tenant-a over the same id in tenant-b: bound to its database, it does not open there.
    const rawA = await inner.open('tenant-a');
    const rawB = await inner.open('tenant-b');
    await rawB.write({ records: [{ id, text: await rawA.records.raw(id) }] });
    const wrappedB = await engine.open('tenant-b');
    await assert.rejects(wrappedB.records.get(id), { code: 'DECRYPT_FAILED' });
    const wrappedA = await engine.open('tenant-a');
    assert.deepStrictEqual((await wrappedA.records.get(id)).data, { owner: 'a', balance: 100 });
    await wrappedA.close();
    await wrappedB.close();
    await rawA.close();
    await rawB.close();
  });

  await t.test('a scrub rewrites the sealed entries; a reopen replays the unsealed tail', async () => {
    const inner = memoryEngine();
    const engine = atRest(inner, { key: KEY });
    const options = {
      path: 'log',
      engine,
      logger: false,
      defer: 0,
      lock: false,
      sync: { log: { rollAfter: 2 }, retention: { ops: 6 } },
    };
    const db = await createDatabase(options);
    const ids = [];
    for (let i = 0; i < 12; i++) ids.push(await db.insert({ n: i, secret: `s${i}` }));
    await db.flush();
    assert.ok(db.stats().log.floor > 1, 'compacted');
    await db.purge(ids[11]);
    const { floor, next, length } = db.stats().log;
    await db.close();
    const plain = await inner.open('log');
    for (const entry of (await plain.log.load()).entries) {
      assert.ok(typeof entry.e === 'string' && entry.e.startsWith('enc1:'), 'the medium holds ciphertext');
    }
    // The copies the wrapper sealed were swapped at the scrub: decrypted, the purged payload is gone.
    const opened = await engine.open('log');
    const text = JSON.stringify((await opened.log.load()).entries);
    assert.ok(text.includes('"s10"') && !text.includes('"s11"'), 'the purged payload is gone once decrypted');
    await opened.close();
    const again = await createDatabase(options);
    const reopened = again.stats().log;
    assert.deepStrictEqual([reopened.floor, reopened.next, reopened.length], [floor, next, length]);
    assert.deepStrictEqual(await again.get(ids[10]), { n: 10, secret: 's10' });
    assert.strictEqual(await again.get(ids[11]), null);
    await again.close();
  });

  await t.test('a write set that the engine refuses lands nothing, sealed or not', async () => {
    const inner = memoryEngine();
    const engine = atRest(inner, { key: KEY });
    const db = await engine.open('/p');
    const stop = { records: [{ id: 'a', stored: stored({ n: 1 }) }], kv: { put: [['', 'x', 'y', undefined]] } };
    await db.write(stop);
    assert.deepStrictEqual((await db.records.get('a')).data, { n: 1 });
    assert.strictEqual(await db.kv.get('', 'x'), 'y');
    const raw = await inner.open('/p');
    assert.ok((await raw.kv.get('', 'x')).startsWith(PREFIX));
  });
});
