'use strict';

// The files engine (`filesEngine(fsi)`, a root export): the engine contract of
// src/engine.js over an fsi — "a directory and a file name" — which is what
// every database was until the engines. Nothing on disk changes: a kv
// namespace is a directory under the path and a key a file in it, a record
// is `data/<id>.json`, its pieces `data/<id>~<n>.json`, a tag's copies
// `tags/<tag>/data/<id>.json`; the op log keeps its journals and segments
// under `log/` (src/files/journal.js). `createDatabase({ fsi })` opens through
// this engine, so node:fs, OPFS, the IndexedDB file store, memory, `layered`
// and `atRest` keep working as they are. Requires backend.js, engine.js,
// layout.js, write-set.js, shape.js, errors.js and journal.js only.

const { checkFsi } = require('../backend.js');
const { capabilitiesOf, checkKvKey, isKvKey, isKvNamespace, unreadableRecord } = require('../engine.js');
const { checkDigest, checkBlobBytes, MAX_STORED_BYTES } = require('../blobs.js');
const { toBase64, fromBase64 } = require('../crypto/pem.js');
const { DIRS, tagDirs } = require('../layout.js');
const { checkWriteSet } = require('../write-set.js');
const { isRecordId } = require('../shape.js');
const { SyncomError, typed } = require('../errors.js');
const { createJournalStore, isAbsent } = require('./journal.js');

const DATA = 'data';
const TAGS = 'tags';
const TAGS_FILE = 'tags.json';
const RECORD = '.json';
// Records of a write set written side by side, this many at a time (a file system's parallelism, bounded).
const WRITES_AT_ONCE = 8;

// The directories a database writes under its path (src/layout.js DIRS),
// besides a tag's two; `remove(path)` empties them (fsi lists files, not
// directories, and no backend has rmdir, so the empty directories stay).

// A name that becomes a file's: checked before it reaches the backend (src/engine.js isKvKey).
const named = (value, what) => {
  if (!isKvKey(value)) throw new TypeError(`filesEngine: ${JSON.stringify(value)} is not a ${what}`);
  return value;
};

const unreadable = (id, cause) => unreadableRecord(SyncomError, id, cause);

// A directory under `path`: the path itself for the root namespace.
const dirOf = (path, ns) => (ns === '' ? path : `${path}/${ns}`);
const BLOBS = 'blobs';

// The tag names a database holds, read from tags.json (null when unreadable).
// A file's text, or null where there is none: one read, not an `exists` and a read.
const readOrNull = async (fsi, dir, name) => {
  try {
    return await fsi.read(dir, name);
  } catch (error) {
    if (isAbsent(error)) return null;
    throw error;
  }
};

const tagNames = async (fsi, path) => {
  const text = await readOrNull(fsi, path, TAGS_FILE);
  if (text === null) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const names = [];
  const tags = parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.tags) ? parsed.tags : [];
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    // A name that is no kv key (a `/`, a `..`) would name a directory outside the path: not a tag's.
    const named = tag !== null && typeof tag === 'object' && typeof tag.name === 'string' && isKvKey(tag.name);
    if (named) names.push(tag.name);
  }
  return names;
};

// Every file of a directory removed; an absent directory is nothing.
const emptyDir = async (fsi, dir, keep = null) => {
  let names = [];
  try {
    names = await fsi.list(dir);
  } catch (error) {
    // A directory that is not there holds nothing; any other failure to list it is a sweep cut short, said so.
    if (isAbsent(error)) return;
    throw error;
  }
  for (let i = 0; i < names.length; i++) if (names[i] !== keep) await fsi.remove(dir, names[i]);
};

const openDb = (fsi, path, capabilities, logger) => {
  const data = `${path}/${DATA}`;
  // The op log's medium: the journals and segments under log/ (src/log.js owns the log).
  const log = createJournalStore(fsi, `${path}/log`, { logger });
  const copiesDir = (tag) => `${path}/${TAGS}/${named(tag, 'tag')}/${DATA}`;
  const recordFile = (id) => `${id}${RECORD}`;

  // A namespace and a key become a directory and a file: checked first.
  const where = (ns, key) => {
    checkKvKey(ns, key, 'filesEngine');
    return dirOf(path, ns);
  };
  const kv = {
    get: async (ns, key) => readOrNull(fsi, where(ns, key), key),
    has: async (ns, key) => fsi.exists(where(ns, key), key),
    async list(ns) {
      if (!isKvNamespace(ns)) throw new TypeError(`filesEngine: ${JSON.stringify(ns)} is not a namespace`);
      return fsi.list(dirOf(path, ns));
    },
    put: async (ns, key, value, options) => fsi.write(where(ns, key), key, value, options),
    remove: async (ns, key) => fsi.remove(where(ns, key), key),
  };
  if (typeof fsi.create === 'function') {
    kv.create = async (ns, key, value) => fsi.create(where(ns, key), key, value);
  }

  const records = {
    /** The stored record — `{ data, meta, encrypted, timestamp, block, gen? }` — or null; a file that does not parse is INTEGRITY. */
    async get(id) {
      const text = await records.raw(id);
      if (text === null) return null;
      let stored = null;
      try {
        stored = JSON.parse(text);
      } catch (cause) {
        throw unreadable(id, cause);
      }
      // A file that parses to anything but an object is as unreadable as one that does not parse.
      if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) throw unreadable(id, null);
      return stored;
    },
    /** The record's text as the medium holds it, or null. */
    async raw(id) {
      return readOrNull(fsi, data, recordFile(id));
    },
    has: (id) => fsi.exists(data, recordFile(id)),
    async getMany(ids) {
      const found = new Map();
      for (let i = 0; i < ids.length; i++) {
        const stored = await records.get(ids[i]);
        if (stored !== null) found.set(ids[i], stored);
      }
      return found;
    },
    /** Every record id the medium holds — tombstones included — in id order, after `after`, at most `limit`. */
    async ids({ after = null, limit = Infinity } = {}) {
      // The backend lists in its own order (a hash on ext4, `a-b.json` before
      // `a.json` by name): every id first, sorted, then the page.
      const names = await fsi.list(data);
      const all = [];
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (!name.endsWith(RECORD)) continue;
        const id = name.slice(0, -RECORD.length);
        // A record's file, never one of its pieces (`<id>~<n>.json`).
        if (isRecordId(id)) all.push(id);
      }
      all.sort();
      const ids = [];
      for (let i = 0; i < all.length && ids.length < limit; i++) {
        if (after === null || all[i] > after) ids.push(all[i]);
      }
      return ids;
    },
  };

  const pieces = {
    /** A piece's text by the name the record's meta holds (`<id>~<n>.json`), or null. */
    async get(id, name) {
      return readOrNull(fsi, data, named(name, 'piece'));
    },
    /** The pieces named, by name — the absent left out. */
    async getMany(id, names) {
      const found = new Map();
      for (let i = 0; i < names.length; i++) {
        const text = await readOrNull(fsi, data, named(names[i], 'piece'));
        if (text !== null) found.set(names[i], text);
      }
      return found;
    },
    /** A piece its record no longer names, removed — after the record's file (src/entries.js). */
    remove: async (id, name) => fsi.remove(data, named(name, 'piece')),
  };

  // Attachments' bytes by digest, as base64 text under blobs/: an fsi carries text. The digest is checked first —
  // it is a file name here, and a register a peer wrote names it.
  const blobsDir = `${path}/${BLOBS}`;
  const blobs = {
    async get(digest) {
      const text = await readOrNull(fsi, blobsDir, checkDigest(digest, 'blobs.get'));
      return text === null ? null : fromBase64(text);
    },
    has: async (digest) => fsi.exists(blobsDir, checkDigest(digest, 'blobs.has')),
    async list() {
      return (await fsi.list(blobsDir)).sort();
    },
    put: async (digest, bytes) =>
      fsi.write(
        blobsDir,
        checkDigest(digest, 'blobs.put'),
        toBase64(checkBlobBytes(typed, bytes, 'blobs.put', MAX_STORED_BYTES)),
      ),
    remove: async (digest) => fsi.remove(blobsDir, checkDigest(digest, 'blobs.remove')),
  };

  const copies = {
    async get(tag, id) {
      return readOrNull(fsi, copiesDir(tag), recordFile(id));
    },
    has: async (tag, id) => fsi.exists(copiesDir(tag), recordFile(id)),
    /** The ids a tag holds copies of, in id order. */
    async ids(tag) {
      const names = await fsi.list(copiesDir(tag));
      const ids = [];
      for (let i = 0; i < names.length; i++) {
        if (names[i].endsWith(RECORD)) ids.push(names[i].slice(0, -RECORD.length));
      }
      return ids.sort();
    },
    put: async (tag, id, text) => fsi.write(copiesDir(tag), recordFile(id), text),
    remove: async (tag, id) => fsi.remove(copiesDir(tag), recordFile(id)),
    /** Every copy of the tag removed. */
    drop: async (tag) => emptyDir(fsi, copiesDir(tag)),
  };

  // One write set, in the order a crash is safest in: the kv puts first (a
  // chain block before the records it names), then each record — the pieces
  // it makes, its file, the pieces it drops — then the copies and the kv
  // removals. Not atomic: a file system has no transactions.
  const write = async (batch) => {
    checkWriteSet(batch, isRecordId, 'filesEngine');
    const puts = batch.kv?.put;
    if (puts !== undefined) {
      for (let i = 0; i < puts.length; i++) {
        const [ns, key, value, options] = puts[i];
        await fsi.write(dirOf(path, ns), key, value, options);
      }
    }
    // A tag's copies before the records they keep the past of: a crash between leaves a copy, never a record without one.
    const copied = batch.copies?.put;
    if (copied !== undefined) {
      for (let i = 0; i < copied.length; i++) {
        await fsi.write(copiesDir(copied[i][0]), recordFile(copied[i][1]), copied[i][2]);
      }
    }
    // Each record in its own crash order — the pieces it makes, its file, the pieces it drops — and the records
    // a few at a time: the order between two records carries nothing, and a file system writes them side by side.
    const rows = batch.records;
    if (rows !== undefined) {
      const landRecord = async (row) => {
        const made = row.pieces?.put;
        if (made !== undefined) for (let k = 0; k < made.length; k++) await fsi.write(data, made[k][0], made[k][1]);
        await fsi.write(data, recordFile(row.id), typeof row.text === 'string' ? row.text : JSON.stringify(row.stored));
        const dropped = row.pieces?.remove;
        if (dropped !== undefined) for (let k = 0; k < dropped.length; k++) await fsi.remove(data, dropped[k]);
      };
      for (let from = 0; from < rows.length; from += WRITES_AT_ONCE) {
        const pending = [];
        for (let i = from; i < rows.length && i < from + WRITES_AT_ONCE; i++) pending.push(landRecord(rows[i]));
        await Promise.all(pending);
      }
    }
    const removed = batch.remove;
    if (removed !== undefined) for (let i = 0; i < removed.length; i++) await fsi.remove(data, recordFile(removed[i]));
    const uncopied = batch.copies?.remove;
    if (uncopied !== undefined) {
      for (let i = 0; i < uncopied.length; i++) await fsi.remove(copiesDir(uncopied[i][0]), recordFile(uncopied[i][1]));
    }
    const removals = batch.kv?.remove;
    if (removals !== undefined) {
      for (let i = 0; i < removals.length; i++) await fsi.remove(dirOf(path, removals[i][0]), removals[i][1]);
    }
  };

  return Object.freeze({
    path,
    capabilities,
    fsi,
    kv,
    records,
    pieces,
    copies,
    log,
    blobs,
    write,
    // The database never closes a backend it was handed: two databases may share one.
    close: async () => {},
  });
};

/**
 * `filesEngine(fsi)` — the engine over an fsi (the platform's by default
 * when the core builds it): `open(path)` is a database over the directory,
 * `remove(path)` empties every directory of the layout, the tags' included,
 * `branch.json` last (a removal cut short leaves a directory `drop()` still
 * takes). `engine.fsi` is the backend, for what still speaks fsi.
 */
const filesEngine = (fsi) => {
  checkFsi(fsi, 'filesEngine(fsi)');
  const capabilities = capabilitiesOf({
    exclusiveCreate: typeof fsi.create === 'function',
    append: typeof fsi.append === 'function',
    blobs: true,
  });
  return Object.freeze({
    name: 'files',
    capabilities,
    fsi,
    open: async (path, { logger = null } = {}) => openDb(fsi, path, capabilities, logger),
    async remove(path) {
      const dirs = [];
      for (let i = 0; i < DIRS.length; i++) dirs.push(DIRS[i]);
      const tags = await tagNames(fsi, path);
      if (tags !== null) {
        for (let i = 0; i < tags.length; i++) {
          const two = tagDirs(tags[i]);
          dirs.push(two[0], two[1]);
        }
      }
      for (let i = 0; i < dirs.length; i++) {
        const dir = dirs[i];
        await emptyDir(fsi, dirOf(path, dir), dir === '' ? 'branch.json' : null);
      }
      await fsi.remove(path, 'branch.json');
    },
  });
};

module.exports = { filesEngine, DIRS };
