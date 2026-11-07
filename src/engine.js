'use strict';

// The storage engine contract — what a database stores its bytes through.
// No requires on purpose: this file is reached from the browser bundle, and
// scripts/size.js fails on any import that is not a relative file.
//
// An engine is a factory of databases, one object shared by every database
// that opens through it: `engine.open(path, options)` resolves to an
// `EngineDb`, `engine.remove(path)` takes every store of that database away.
// A database is a set of stores over one `path`:
//
//   kv       small named texts beside the records — node.json, schema.json,
//            tags.json, the keys, the lock, the registry, the chain's blocks —
//            `get/has/list/put/remove` by namespace and key; `create` where the
//            medium can make a key exclusively (the lock prefers it)
//   records  the records by id: `get(id)` the stored record as the engine
//            holds it (`{ data, meta, encrypted, timestamp, block, gen?, type? }` — `type` the
//            collection of a tombstone, whose data is empty),
//            `raw(id)` its text, `getMany`, `has`, `ids({ after, limit })` in id
//            order
//   pieces   the runs of a large block beside its record, `(id, n)` → text; `getMany(id, names)` → Map, one call
//   copies   a tag's copies of records, `(tag, id)` → text
//   log      the op log's medium (src/log.js owns the log itself)
//   write    one write set — records (each with the pieces it makes and drops),
//            kv puts and removals, copies — landed whole where the medium has
//            transactions (`capabilities.atomicBatch`), in order otherwise
//
// The files engine (src/files/files.js) is the one every fsi becomes; a
// native engine (memory, IndexedDB, SQLite, MongoDB) keeps rows, indexes and
// the log in its own structures. `capabilities` says what a medium can do, so
// the core asks nothing a medium lacks.

const METHODS = ['open', 'remove'];
const STORES = ['kv', 'records', 'pieces', 'copies', 'log', 'write', 'close'];

/** The capabilities every engine declares; an engine spreads its own over these. */
const CAPABILITIES = Object.freeze({
  // Every write set lands whole or not at all.
  atomicBatch: false,
  // The engine keeps the record indexes (a `catalog` on the database).
  indexes: false,
  // Another instance over the same database hears its writes (`changes`).
  changeStream: false,
  // `kv.create` makes a key exclusively (EEXIST when it is there).
  exclusiveCreate: false,
  // How a database is held by one instance: 'kv' through a lock key, 'native' through the engine's own lease.
  lock: 'kv',
  // Several instances may open one database at once (read-only followers).
  shared: false,
  // A `blobs` store for attachments: `get(digest)`, `has`, `list()`, `put(digest, bytes)`, `remove` — bytes by their
  // SHA-256; every store checks the digest and the bytes at its door (src/blobs.js: checkDigest, checkBlobBytes
  // within MAX_BLOB_BYTES) before the medium sees them.
  blobs: false,
  // The log's medium appends a line to a journal (a file per group otherwise).
  append: false,
});

// The name of the first member an engine lacks, or null.
const missingEngineMethod = (value) => {
  if (typeof value !== 'object' || value === null) return METHODS[0];
  for (let i = 0; i < METHODS.length; i++) if (typeof value[METHODS[i]] !== 'function') return METHODS[i];
  if (typeof value.name !== 'string' || value.name.length === 0) return 'name';
  if (typeof value.capabilities !== 'object' || value.capabilities === null) return 'capabilities';
  return null;
};

/** Whether `value` is an engine: `open()`, `remove()`, a `name` and `capabilities`. */
const isEngine = (value) => missingEngineMethod(value) === null;

// What `createDatabase()` calls: the contract, refused with the member's name.
const checkEngine = (value, label) => {
  const missing = missingEngineMethod(value);
  if (missing !== null) throw new TypeError(`${label}: engine has no ${missing}`);
  return value;
};

// The name of the first store a database lacks, or null.
const missingStore = (db) => {
  if (typeof db !== 'object' || db === null) return STORES[0];
  for (let i = 0; i < STORES.length; i++) {
    const name = STORES[i];
    const member = db[name];
    const ok =
      name === 'write' || name === 'close'
        ? typeof member === 'function'
        : typeof member === 'object' && member !== null;
    if (!ok) return name;
  }
  return null;
};

// What `engine.open()` must have answered with.
const checkEngineDb = (db, label) => {
  const missing = missingStore(db);
  if (missing !== null) throw new TypeError(`${label}: the engine's database has no ${missing}`);
  return db;
};

/** The capabilities of an engine with the defaults filled in. */
const capabilitiesOf = (given) => Object.freeze({ ...CAPABILITIES, ...given });

// One namespace of a kv as a store of its own — `has/get/put/remove/list`,
// `create` where the kv has it: what the lock, the identity, the keys, the
// chain, the schema's version file, the registry and a catalog speak.
const kvNamespace = (kv, ns) => {
  const store = {
    has: (key) => kv.has(ns, key),
    get: (key) => kv.get(ns, key),
    put: (key, value, options) => kv.put(ns, key, value, options),
    remove: (key) => kv.remove(ns, key),
    list: () => kv.list(ns),
  };
  if (typeof kv.create === 'function') store.create = (key, value) => kv.create(ns, key, value);
  return store;
};

// A directory of an fsi as the same store: for what still takes an fsi — a
// `Blockchain` of its own, `loadKeys(path, { fsi })`, the lock in a test.
const fsiNamespace = (fsi, dir) => {
  const store = {
    has: (key) => fsi.exists(dir, key),
    async get(key) {
      if (!(await fsi.exists(dir, key))) return null;
      return fsi.read(dir, key);
    },
    put: (key, value, options) => fsi.write(dir, key, value, options),
    remove: (key) => fsi.remove(dir, key),
    list: () => fsi.list(dir),
  };
  if (typeof fsi.create === 'function') store.create = (key, value) => fsi.create(dir, key, value);
  return store;
};

// The kv namespaces a database writes besides a tag's (`tags/<tag>/index`):
// the one list `copyEngine` copies and the files engine sweeps — a plugin
// that writes a namespace of its own adds it here.
const KV_NAMESPACES = Object.freeze([
  '',
  'keys',
  'blockchain',
  'index',
  'remote',
  'local',
  'pipeline',
  'tombstones',
  'shared',
  'connector',
]);

// A kv key, a tag's name, a piece's name: a text that names one thing and
// nothing else — no separator, no `.`/`..`, no control character, 255 at
// most — since the files engine makes a file of it and a served engine
// (src/engines/remote.js) takes it from the other side of a port. A
// namespace is a path of such keys (`tags/<tag>/index`), or `''` for the root.
const KEY_MAX = 255;
const isKvKey = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > KEY_MAX) return false;
  if (value === '.' || value === '..') return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x2f || code === 0x5c) return false;
  }
  return true;
};
const isKvNamespace = (value) => {
  if (value === '') return true;
  if (typeof value !== 'string') return false;
  const parts = value.split('/');
  for (let i = 0; i < parts.length; i++) if (!isKvKey(parts[i])) return false;
  return true;
};
const checkKvKey = (ns, key, label) => {
  if (!isKvNamespace(ns)) throw new TypeError(`${label}: ${JSON.stringify(ns)} is not a namespace`);
  if (!isKvKey(key)) throw new TypeError(`${label}: ${JSON.stringify(key)} is not a key`);
};

// What every engine answers the same: a record the medium holds that is no
// record (INTEGRITY, `reason: 'unreadable'`, the parse error as `cause` where
// there is one), and a key `create` found held (EEXIST, as an fsi says it).
// No requires here: the error class is the caller's (src/errors.js).
const unreadableRecord = (SyncomError, id, cause = null) =>
  new SyncomError('INTEGRITY', `Record ${id} is unreadable`, { id, cause, reason: 'unreadable' });
const eexist = (key) => Object.assign(new Error(`EEXIST: key already exists, ${key}`), { code: 'EEXIST' });

module.exports = {
  CAPABILITIES,
  KV_NAMESPACES,
  isEngine,
  checkEngine,
  checkEngineDb,
  capabilitiesOf,
  kvNamespace,
  fsiNamespace,
  isKvKey,
  isKvNamespace,
  checkKvKey,
  unreadableRecord,
  eexist,
};
