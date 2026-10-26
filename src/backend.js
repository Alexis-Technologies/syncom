'use strict';

// The storage backend contract and the adapters that ship with it. No
// requires on purpose: this file is reached from the browser bundle, and
// scripts/size.js fails on any import that is not a relative file.
//
// A backend is an `fsi` — five functions over "a directory and a file name":
// `read`, `write`, `exists`, `remove`, `list`. `node:fs` and OPFS are the two
// defaults (src/fsi.js, src/fsi.browser.js); `@alexify/syncom/idb`,
// `@alexify/syncom/memory` (tests, SSR, benchmarks) and the `layered()`
// combinator of `@alexify/syncom/layered` are subpaths. An adapter may add
// `sync(dir, name)` — fsync — which `open({ durable: true })` calls after
// every write, `create(dir, name, content)` — exclusive — which the lock
// prefers, and `append(dir, name, content)` — at the end of the file, made
// when absent — which the log's journal prefers to a file per group.

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

// The same adapter with every write followed by its `sync`: what `durable`
// means on a backend that can fsync.
const withSync = (fsi) => {
  const wrapped = {
    read: (dir, name) => fsi.read(dir, name),
    exists: (dir, name) => fsi.exists(dir, name),
    remove: (dir, name) => fsi.remove(dir, name),
    list: (dir) => fsi.list(dir),
    sync: (dir, name) => fsi.sync(dir, name),
    async write(dir, name, content, options) {
      await fsi.write(dir, name, content, options);
      await fsi.sync(dir, name);
    },
  };
  if (typeof fsi.create === 'function') {
    wrapped.create = async (dir, name, content) => {
      await fsi.create(dir, name, content);
      await fsi.sync(dir, name);
    };
  }
  if (typeof fsi.append === 'function') {
    wrapped.append = async (dir, name, content) => {
      await fsi.append(dir, name, content);
      await fsi.sync(dir, name);
    };
  }
  return wrapped;
};

module.exports = { isFsi, checkFsi, withSync };
