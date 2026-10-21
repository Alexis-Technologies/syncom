'use strict';

/**
 * TinyBase 10: a `MergeableStore` (the store that synchronizes), a table
 * `todos` with a row per record; `setRow` inserts, `setPartialRow` updates,
 * `getRow` reads, a batch is one `transaction`. A MergeableStore's cells are
 * last-writer-wins, so the counter scenario leaves it out. A replica syncs
 * through two `LocalSynchronizer`s — TinyBase's own sync protocol (hashes,
 * then the differing content) over an in-process message bus.
 *
 * On disk: the official file persister, `save()` awaited after every write.
 * It writes the whole store as one JSON file, which is how it persists.
 */

const { createRequire } = require('node:module');
const path = require('node:path');
const fs = require('node:fs/promises');

const local = createRequire(require.resolve('../package.json'));
const load = (name) => import(local.resolve(name));

let stores = 0;

const wrap = (store, persister) => {
  let next = 0;
  const save = persister ? () => persister.save() : () => null;
  const after = (id) => {
    const wait = save();
    return wait ? wait.then(() => id) : id;
  };
  return {
    store,
    persister,
    insert: (record) => {
      const id = `t${next++}`;
      store.setRow('todos', id, record);
      return after(id);
    },
    get: (id) => (store.hasRow('todos', id) ? store.getRow('todos', id) : null),
    update: (id, patch) => {
      store.setPartialRow('todos', id, patch);
      return save();
    },
    bulk: async (records) => {
      const ids = records.map(() => `t${next++}`);
      store.transaction(() => {
        for (let i = 0; i < records.length; i++) store.setRow('todos', ids[i], records[i]);
      });
      await save();
      return ids;
    },
    close: async () => persister?.destroy(),
  };
};

const open = async (dir, onDisk) => {
  const { createMergeableStore } = await load('tinybase');
  const store = createMergeableStore(`store-${++stores}`);
  if (!onDisk) return wrap(store, null);
  const { createFilePersister } = await load('tinybase/persisters/persister-file');
  await fs.mkdir(dir, { recursive: true });
  const persister = createFilePersister(store, path.join(dir, 'store.json'));
  await persister.load();
  return wrap(store, persister);
};

const replicate = async (source, replica) => {
  const { createLocalSynchronizer } = await load('tinybase/synchronizers/synchronizer-local');
  const want = source.store.getRowCount('todos');
  const arrived = new Promise((resolve) => {
    const check = () => {
      if (replica.store.getRowCount('todos') < want) return;
      replica.store.delListener(listener);
      resolve();
    };
    const listener = replica.store.addRowIdsListener('todos', check);
  });
  const ours = createLocalSynchronizer(source.store);
  const theirs = createLocalSynchronizer(replica.store);
  await ours.startSync();
  await theirs.startSync();
  await arrived;
  await ours.destroy();
  await theirs.destroy();
  if (replica.persister) await replica.persister.save();
};

const line = (onDisk, variant) => ({
  variant,
  open: (dir) => open(dir, onDisk),
  openReplica: (dir) => open(dir, onDisk),
  replicate,
});

module.exports = {
  id: 'tinybase',
  name: 'TinyBase',
  package: 'tinybase',
  url: 'https://github.com/tinyplex/tinybase',
  lines: {
    memory: line(false, 'MergeableStore'),
    disk: line(true, 'MergeableStore, file persister'),
  },
};
