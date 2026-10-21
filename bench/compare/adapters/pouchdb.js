'use strict';

/**
 * PouchDB 9: a document per record; `put` inserts, an update is `get` then
 * `put` with the revision (how PouchDB updates), a batch is `bulkDocs`. A
 * document is last-writer-wins by revision, with conflicts kept for the
 * application, so the counter scenario leaves it out. A replica is a second
 * database and `PouchDB.replicate(source, replica)` — the CouchDB
 * replication protocol, in process.
 *
 * In memory: pouchdb-adapter-memory. On disk: the Node default, LevelDB
 * (leveldown, a native addon; on Apple Silicon it builds from source).
 */

const { createRequire } = require('node:module');

const local = createRequire(require.resolve('../package.json'));

let names = 0;

const pouch = () => {
  const PouchDB = local('pouchdb');
  PouchDB.plugin(local('pouchdb-adapter-memory'));
  return PouchDB;
};

const wrap = (db) => {
  let next = 0;
  return {
    db,
    insert: async (record) => {
      const id = `t${next++}`;
      await db.put({ _id: id, ...record });
      return id;
    },
    get: (id) => db.get(id).catch(() => null),
    update: async (id, patch) => {
      const doc = await db.get(id);
      await db.put({ ...doc, ...patch });
    },
    bulk: async (records) => {
      const docs = records.map((record) => ({ _id: `t${next++}`, ...record }));
      await db.bulkDocs(docs);
      return docs.map((doc) => doc._id);
    },
    close: () => db.close(),
  };
};

const line = (memory, variant) => {
  const open = async (dir) => {
    const PouchDB = pouch();
    return wrap(memory ? new PouchDB(`todos-${++names}`, { adapter: 'memory' }) : new PouchDB(dir));
  };
  return {
    variant,
    open,
    openReplica: open,
    replicate: async (source, replica) => {
      await pouch().replicate(source.db, replica.db);
    },
  };
};

module.exports = {
  id: 'pouchdb',
  name: 'PouchDB',
  package: 'pouchdb',
  url: 'https://github.com/pouchdb/pouchdb',
  lines: {
    memory: line(true, 'pouchdb-adapter-memory'),
    disk: line(false, 'LevelDB (Node default)'),
  },
};
