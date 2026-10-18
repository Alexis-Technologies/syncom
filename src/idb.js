'use strict';

// An fsi over IndexedDB — the `@alexify/syncom/idb` subpath, for browsers
// where OPFS is unavailable or unwanted (a worker without it, a profile
// that evicts it, a test that wants a mock). No requires: it ships to the
// browser on its own.
//
// One object store, `files`, keyed by `[dir, name]`, with an index on `dir`:
// a directory listing is one `getAllKeys(dir)` on the index, and every other
// call is one request on the store. A write resolves on the transaction's
// `complete`, which is when IndexedDB considers it durable.

const NOT_FOUND = 'NotFoundError';

const request = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const completion = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });

const notFound = (dir, name) =>
  Object.assign(new Error(`${NOT_FOUND}: no such file, ${dir}/${name}`), { name: NOT_FOUND, code: 'ENOENT' });

/**
 * `createIdbFsi({ name = 'syncom', store = 'files', indexedDB })` — the
 * database is opened lazily on the first call and reopened after the
 * browser closes it (`versionchange`); `close()` closes it. `indexedDB`
 * defaults to the global one; a test passes its own factory.
 */
const createIdbFsi = ({ name = 'syncom', store = 'files', indexedDB = globalThis.indexedDB } = {}) => {
  if (!indexedDB || typeof indexedDB.open !== 'function') {
    throw new TypeError('createIdbFsi: no indexedDB — pass one, or use the OPFS backend');
  }
  let opening = null;

  const open = () => {
    opening ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: ['dir', 'name'] }).createIndex('dir', 'dir');
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab upgrades or deletes the database: let go, and the
        // next call opens it again.
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        opening = null;
        reject(req.error);
      };
    });
    return opening;
  };

  // One transaction per call; `fn` makes the request on the store.
  const run = async (mode, fn) => {
    const db = await open();
    const tx = db.transaction(store, mode);
    const completed = completion(tx);
    completed.catch(() => {});
    const value = await request(fn(tx.objectStore(store)));
    await completed;
    return value;
  };

  return {
    async read(dir, name) {
      const row = await run('readonly', (files) => files.get([dir, name]));
      if (row === undefined) throw notFound(dir, name);
      return row.content;
    },
    async write(dir, name, content) {
      await run('readwrite', (files) => files.put({ dir, name, content: String(content) }));
    },
    async exists(dir, name) {
      return (await run('readonly', (files) => files.getKey([dir, name]))) !== undefined;
    },
    async remove(dir, name) {
      await run('readwrite', (files) => files.delete([dir, name]));
    },
    async list(dir) {
      const keys = await run('readonly', (files) => files.index('dir').getAllKeys(dir));
      return keys.map((key) => key[1]).sort();
    },
    async close() {
      if (opening === null) return;
      const db = await opening.catch(() => null);
      opening = null;
      db?.close();
    },
  };
};

module.exports = { createIdbFsi };
