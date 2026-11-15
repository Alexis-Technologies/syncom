// The localStorage page (docs/guide/storage-localstorage.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory. Node has no localStorage
// without a flag, so a Map stands in for it with the Web Storage calls the backend uses.
import assert from 'node:assert/strict';
import { isFsi } from '@alexify/syncom';

const items = new Map();
const localStorage = {
  getItem: (key) => (items.has(key) ? items.get(key) : null),
  setItem: (key, value) => void items.set(key, String(value)),
  removeItem: (key) => void items.delete(key),
  key: (index) => [...items.keys()][index] ?? null,
  get length() {
    return items.size;
  },
};

// #region fsi
// A backend over any Web Storage object: a file is an item named `<dir>/<name>`.
const webStorage = (storage, prefix = 'syncom:') => {
  const keyOf = (dir, name) => `${prefix}${dir}/${name}`;
  return {
    async read(dir, name) {
      const text = storage.getItem(keyOf(dir, name));
      if (text === null) throw Object.assign(new Error(`ENOENT: ${dir}/${name}`), { code: 'ENOENT' });
      return text;
    },
    async write(dir, name, content) {
      storage.setItem(keyOf(dir, name), content);
    },
    async exists(dir, name) {
      return storage.getItem(keyOf(dir, name)) !== null;
    },
    async remove(dir, name) {
      storage.removeItem(keyOf(dir, name));
    },
    async list(dir) {
      const start = `${prefix}${dir}/`;
      const names = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key.startsWith(start) && !key.slice(start.length).includes('/')) names.push(key.slice(start.length));
      }
      return names.sort();
    },
  };
};
// #endregion fsi
assert.equal(isFsi(webStorage(localStorage)), true);

// #region open
import { createDatabase } from '@alexify/syncom';

const db = await createDatabase({ path: 'board', fsi: webStorage(localStorage) });
const id = await db.insert({ title: 'An item in localStorage' });
await db.close();
// #endregion open

const again = await createDatabase({ path: 'board', fsi: webStorage(localStorage) });
assert.deepEqual(await again.get(id), { title: 'An item in localStorage' });
await again.close();
assert.ok([...items.keys()].some((key) => key.startsWith('syncom:board/data/')));
