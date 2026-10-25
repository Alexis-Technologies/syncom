'use strict';

// A backend in memory (@alexify/syncom/memory): `memory()` is a Map of
// `dir/name` to content behind the five functions of the contract, plus the
// exclusive `create` the lock prefers, `size` and `dump()`. Nothing survives
// the process, and two storages opened over one of them share it — a mesh in
// one process, a node that must not touch the disk, a test, a benchmark. The
// top layer of a `layered()` backend, as a rule. No requires.

const notFound = (key) => Object.assign(new Error(`ENOENT: no such file, ${key}`), { code: 'ENOENT' });

/** A backend in memory: a Map of `dir/name` to content. */
const memory = () => {
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
    // Exclusive create, like the node half's: EEXIST when the file is there.
    async create(dir, name, content) {
      const key = keyOf(dir, name);
      if (files.has(key)) throw Object.assign(new Error(`EEXIST: file already exists, ${key}`), { code: 'EEXIST' });
      files.set(key, String(content));
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

module.exports = { memory };
