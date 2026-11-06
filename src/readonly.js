'use strict';

// A database that refuses every write — what `createDatabase({ readOnly })`
// opens over: a follower reads what another instance writes and lands, and
// alters nothing, not even the log's index. `refuse(what)` makes the error
// thrown (the core's READ_ONLY); the log's `append` fails its group through
// `onFail` as a medium that cannot write would, and a seal, a drop, an
// index or a scrub are nothing (the writer's log is the writer's to keep).
const readOnlyDb = (db, refuse) => {
  const no = (what) => async () => {
    throw refuse(what);
  };
  const kv = {
    get: (ns, key) => db.kv.get(ns, key),
    has: (ns, key) => db.kv.has(ns, key),
    list: (ns) => db.kv.list(ns),
    put: no('kv.put'),
    remove: no('kv.remove'),
  };
  if (typeof db.kv.create === 'function') kv.create = no('kv.create');
  const pieces = {
    get: (id, name) => db.pieces.get(id, name),
    getMany: (id, names) => db.pieces.getMany(id, names),
    remove: no('pieces.remove'),
  };
  const copies = {
    get: (tag, id) => db.copies.get(tag, id),
    has: (tag, id) => db.copies.has(tag, id),
    ids: (tag) => db.copies.ids(tag),
    put: no('copies.put'),
    remove: no('copies.remove'),
    drop: no('copies.drop'),
  };
  const log = {
    // Told it is a follower's load: a medium that tidies as it loads (the files journal) leaves the writer's files alone.
    load: () => db.log.load({ readOnly: true }),
    async append(_entries, _headers, { onFail }) {
      onFail(refuse('log.append'));
      return false;
    },
    async seal() {},
    async sealed() {},
    async drop() {},
    async saveIndex() {},
    async scrub() {},
    get journaled() {
      return db.log.journaled;
    },
    get sealedTo() {
      return db.log.sealedTo;
    },
    get open() {
      return db.log.open;
    },
    get segments() {
      return db.log.segments;
    },
    get corrupt() {
      return db.log.corrupt;
    },
    get health() {
      return db.log.health;
    },
  };
  const wrapped = {
    path: db.path,
    capabilities: db.capabilities,
    kv,
    records: db.records,
    pieces,
    copies,
    log,
    write: no('write'),
    close: () => db.close(),
  };
  if (db.fsi !== undefined) wrapped.fsi = db.fsi;
  if (db.catalog !== undefined) wrapped.catalog = { load: () => db.catalog.load(), save: async () => {} };
  if (db.changes !== undefined) wrapped.changes = db.changes;
  if (db.blobs !== undefined) {
    wrapped.blobs = {
      get: (digest) => db.blobs.get(digest),
      has: (digest) => db.blobs.has(digest),
      list: () => db.blobs.list(),
      put: no('blobs.put'),
      remove: no('blobs.remove'),
    };
  }
  return Object.freeze(wrapped);
};

module.exports = { readOnlyDb };
