'use strict';

// The IndexedDB backend under fake-indexeddb: the shared fsi suite, then the
// ways a real browser misbehaves — a failing put, a database the browser
// closed under us, a close() of our own.

const test = require('node:test');
const assert = require('node:assert');
const { IDBFactory } = require('fake-indexeddb');
const { createIdbFsi } = require('../idb.js');
const { runFsiTests } = require('./suites/fsi.js');

test('createIdbFsi', async (t) => {
  const fsi = createIdbFsi({ indexedDB: new IDBFactory() });
  t.after(() => fsi.close());
  let n = 0;
  await runFsiTests(t, fsi, {
    getRoot: async () => `idb-${n++}`,
    joinPath: (root, ...parts) => [root, ...parts].join('/'),
  });

  await t.test('an empty database lists nothing; a read of a missing file is NotFoundError', async () => {
    const fresh = createIdbFsi({ indexedDB: new IDBFactory(), name: 'other', store: 'blobs' });
    assert.deepStrictEqual(await fresh.list('anything'), []);
    const error = await fresh.read('a', 'b').catch((e) => e);
    assert.strictEqual(error.name, 'NotFoundError');
    assert.strictEqual(error.code, 'ENOENT');
    await fresh.write('a', 'n', 42);
    assert.strictEqual(await fresh.read('a', 'n'), '42', 'content is kept as text');
    await fresh.close();
    await fresh.close();
    assert.strictEqual(await fresh.read('a', 'n'), '42', 'a closed backend reopens on the next call');
    await fresh.close();
  });

  await t.test('a database another tab deletes is let go, and recreated on the next call', async () => {
    const factory = new IDBFactory();
    const backend = createIdbFsi({ indexedDB: factory, name: 'shared' });
    await backend.write('d', 'f', 'x');
    // Our connection hears versionchange and closes; otherwise this blocks.
    await new Promise((resolve, reject) => {
      const req = factory.deleteDatabase('shared');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked: the backend did not let go'));
    });
    assert.strictEqual(await backend.exists('d', 'f'), false, 'gone with the database');
    await backend.write('d', 'f', 'y');
    assert.strictEqual(await backend.read('d', 'f'), 'y');
    await backend.close();
  });

  await t.test('a request that fails, a transaction that errors or aborts: the call rejects', async () => {
    const settle = (req, outcome) => {
      queueMicrotask(() => (outcome === 'fail' ? req.onerror?.() : req.onsuccess?.()));
      return req;
    };
    let outcome = 'abort';
    const db = {
      objectStoreNames: { contains: () => true },
      transaction: () => {
        const tx = { error: outcome === 'error' ? new Error('io') : null };
        tx.objectStore = () => ({
          put: () => settle({}, outcome === 'fail' ? 'fail' : 'ok'),
          get: () => settle({ result: { content: 'x' }, error: new Error('request failed') }, outcome),
        });
        if (outcome !== 'fail') {
          queueMicrotask(() => queueMicrotask(() => (outcome === 'error' ? tx.onerror?.() : tx.onabort?.())));
        }
        return tx;
      },
      close() {},
    };
    const backend = createIdbFsi({ indexedDB: { open: () => settle({ result: db }, 'ok') } });
    await assert.rejects(() => backend.write('d', 'f', 'x'), /transaction aborted/);
    outcome = 'error';
    await assert.rejects(() => backend.read('d', 'f'), /io/);
    outcome = 'fail';
    await assert.rejects(() => backend.read('d', 'f'), /request failed/);
    await backend.close();
  });

  await t.test('no indexedDB is a TypeError at creation; an open that fails rejects every call', async () => {
    assert.throws(() => createIdbFsi({ indexedDB: null }), { name: 'TypeError', message: /no indexedDB/ });
    assert.throws(() => createIdbFsi({ indexedDB: {} }), TypeError);
    const failing = createIdbFsi({
      indexedDB: {
        open: () => {
          const req = {};
          queueMicrotask(() => req.onerror?.());
          req.error = new Error('quota');
          return req;
        },
      },
    });
    await assert.rejects(() => failing.exists('a', 'b'), /quota/);
    await assert.rejects(() => failing.read('a', 'b'), /quota/, 'and tries again');
    await failing.close();
  });
});
