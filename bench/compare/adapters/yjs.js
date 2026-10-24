'use strict';

/**
 * Yjs 13: one `Y.Doc`, a top-level `Y.Map` of records, each record a nested
 * `Y.Map`, so concurrent edits of different fields merge (what syncom's
 * per-field registers do). A record is read with `toJSON()`. Yjs has no
 * counter type — a number in a `Y.Map` is last-writer-wins — so the counter
 * scenario leaves it out. A replica syncs the way y-protocols does it:
 * the replica's state vector, the update the source computes against it.
 *
 * On disk: y-leveldb, the official LevelDB persistence — every update the
 * document emits is stored with `storeUpdate`, and the write waits for it.
 */

const { createRequire } = require('node:module');

const local = createRequire(require.resolve('../package.json'));

const DOC = 'todos';

const wrap = (Y, doc, persist, close) => {
  const todos = doc.getMap('todos');
  let next = 0;
  let pending = null;
  if (persist) doc.on('update', (update) => (pending = persist(update)));
  const flush = () => {
    const wait = pending;
    pending = null;
    return wait;
  };
  const write = (fn) => {
    doc.transact(fn);
    return flush();
  };
  const insertOne = (record) => {
    const id = `t${next++}`;
    todos.set(id, new Y.Map(Object.entries(record)));
    return id;
  };
  return {
    doc,
    insert: (record) => {
      let id;
      const wait = write(() => (id = insertOne(record)));
      return wait ? wait.then(() => id) : id;
    },
    get: (id) => todos.get(id)?.toJSON() ?? null,
    update: (id, patch) =>
      write(() => {
        const map = todos.get(id);
        for (const key of Object.keys(patch)) map.set(key, patch[key]);
      }),
    bulk: async (records) => {
      const ids = [];
      await write(() => {
        for (const record of records) ids.push(insertOne(record));
      });
      return ids;
    },
    flush,
    close,
    text: () => {
      const text = doc.getText('text');
      return { insert: (index, chars) => write(() => text.insert(index, chars)), read: () => text.toString() };
    },
  };
};

const memory = {
  variant: 'Y.Doc, a Y.Map per record',
  open: async () => {
    const Y = local('yjs');
    return wrap(Y, new Y.Doc(), null, async () => {});
  },
  text: (store) => store.text(),
};

const disk = {
  variant: 'y-leveldb',
  open: async (dir) => {
    const Y = local('yjs');
    const { LeveldbPersistence } = local('y-leveldb');
    const persistence = new LeveldbPersistence(dir);
    const doc = new Y.Doc();
    const stored = await persistence.getYDoc(DOC);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(stored));
    return wrap(
      Y,
      doc,
      (update) => persistence.storeUpdate(DOC, update),
      () => persistence.destroy(),
    );
  },
};

// Sync step 1 and 2 of y-protocols: the replica sends its state vector, the
// source answers with what the replica lacks.
const replicate = async (source, replica) => {
  const Y = local('yjs');
  const vector = Y.encodeStateVector(replica.doc);
  const update = Y.encodeStateAsUpdate(source.doc, vector);
  Y.applyUpdate(replica.doc, update);
  await replica.flush();
};

module.exports = {
  id: 'yjs',
  name: 'Yjs',
  package: 'yjs',
  url: 'https://github.com/yjs/yjs',
  lines: {
    memory: { ...memory, openReplica: (dir) => memory.open(dir), replicate },
    disk: { ...disk, openReplica: (dir) => disk.open(dir), replicate },
  },
};
