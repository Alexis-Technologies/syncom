'use strict';

// The storage backend contract and the adapters that ship with it. No
// requires on purpose: this file is reached from the browser bundle, and
// scripts/size.js fails on any import that is not a relative file.
//
// A backend is an `fsi` — five functions over "a directory and a file name":
// `read`, `write`, `exists`, `remove`, `list`. `node:fs` and OPFS are the two
// defaults (src/fsi.js, src/fsi.browser.js); `@alexify/syncom/idb` is a
// third; `createMemoryFsi()` is the one for tests, SSR and benchmarks. An
// adapter may add `sync(dir, name)` — fsync — which `open({ durable: true })`
// calls after every write.

const METHODS = ['read', 'write', 'exists', 'remove', 'list'];

// The name of the first method an adapter lacks, or null.
const missingFsiMethod = (value) => {
  if (typeof value !== 'object' || value === null) return METHODS[0];
  for (const name of METHODS) if (typeof value[name] !== 'function') return name;
  return null;
};

/** Whether `value` has the five functions of the backend contract. */
const isFsi = (value) => missingFsiMethod(value) === null;

// What the constructors call: the contract, refused with the method's name.
const checkFsi = (value, label) => {
  const missing = missingFsiMethod(value);
  if (missing !== null) throw new TypeError(`${label}: adapter has no ${missing}()`);
  return value;
};

const notFound = (key) => Object.assign(new Error(`ENOENT: no such file, ${key}`), { code: 'ENOENT' });

/**
 * A backend in memory: a Map of `dir/name` to content. Nothing survives the
 * process, and two storages opened over one of them share it — a mesh in
 * one process, a node that must not touch the disk.
 */
const createMemoryFsi = () => {
  const files = new Map();
  const keyOf = (dir, name) => `${dir}/${name}`;
  return {
    async read(dir, name) {
      const key = keyOf(dir, name);
      if (!files.has(key)) throw notFound(key);
      return files.get(key);
    },
    async write(dir, name, content) {
      files.set(keyOf(dir, name), String(content));
    },
    async exists(dir, name) {
      return files.has(keyOf(dir, name));
    },
    async remove(dir, name) {
      files.delete(keyOf(dir, name));
    },
    // Files directly under `dir`, sorted; a directory is only ever implied.
    async list(dir) {
      const prefix = `${dir}/`;
      const names = [];
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (!rest.includes('/')) names.push(rest);
      }
      return names.sort();
    },
    get size() {
      return files.size;
    },
    dump() {
      return Object.fromEntries(files);
    },
  };
};

// The same adapter with every write followed by its `sync`: what `durable`
// means on a backend that can fsync.
const withSync = (fsi) => ({
  read: (dir, name) => fsi.read(dir, name),
  exists: (dir, name) => fsi.exists(dir, name),
  remove: (dir, name) => fsi.remove(dir, name),
  list: (dir) => fsi.list(dir),
  sync: (dir, name) => fsi.sync(dir, name),
  async write(dir, name, content, options) {
    await fsi.write(dir, name, content, options);
    await fsi.sync(dir, name);
  },
});

module.exports = { isFsi, checkFsi, createMemoryFsi, withSync };
