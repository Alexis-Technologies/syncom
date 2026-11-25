'use strict';

// The IndexedDB backend under fake-indexeddb: the shared fsi suite, then the
// ways a real browser misbehaves — a failing put, a database the browser
// closed under us, a close() of our own.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const { createIdbFsi } = require('../src/idb/idb.js');
const { runFsiTests } = require('./suites/fsi.js');

describe('createIdbFsi', () => {
  const fsi = createIdbFsi({ indexedDB: new IDBFactory() });
  after(() => fsi.close());
  let n = 0;
  runFsiTests(fsi, {
    getRoot: async () => `idb-${n++}`,
    joinPath: (root, ...parts) => [root, ...parts].join('/'),
  });

  it('should list nothing in an empty database and reject a read of a missing file with NotFoundError', async () => {
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

  it('should let go of a database another tab deletes and recreate it on the next call', async () => {
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

  it('should reject the call on a request that fails, a transaction that errors or aborts', async () => {
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

  it('should throw a TypeError at creation without indexedDB, and reject every call when the open fails', async () => {
    assert.throws(() => createIdbFsi({ indexedDB: null }), { name: 'ArgumentError', message: /no indexedDB/ });
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
