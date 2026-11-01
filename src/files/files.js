'use strict';

// The files engine (@alexify/syncom/files): the engine contract of
// src/engine.js over an fsi — "a directory and a file name" — which is what
// every database was until the engines. Nothing on disk changes: a kv
// namespace is a directory under the path and a key a file in it, a record
// is `data/<id>.json`, its pieces `data/<id>~<n>.json`, a tag's copies
// `tags/<tag>/data/<id>.json`; the op log keeps its journals and segments
// under `log/` (src/files/journal.js). `createDatabase({ fsi })` opens through
// this engine, so node:fs, OPFS, the IndexedDB file store, memory, `layered`
// and `atRest` keep working as they are. Requires backend.js, engine.js,
// shape.js, errors.js and journal.js only.

const { checkFsi } = require('../backend.js');
const { capabilitiesOf } = require('../engine.js');
const { isRecordId } = require('../shape.js');
const { SyncomError } = require('../errors.js');
const { createJournalStore } = require('./journal.js');

const DATA = 'data';
const TAGS = 'tags';
const TAGS_FILE = 'tags.json';
const RECORD = '.json';

// The directories a database writes under its path, besides a tag's two;
// `remove(path)` empties them (fsi lists files, not directories, and no
// backend has rmdir, so the empty directories stay).
const DIRS = [
  '',
  'keys',
  'blockchain',
  'index',
  'data',
  'log',
  'log/open',
  'log/corrupt',
  'remote',
  'tags/.pending/data',
];

const unreadable = (id, cause) =>
  new SyncomError('INTEGRITY', `Storage record ${id} is unreadable`, { id, cause, reason: 'unreadable' });

// A directory under `path`: the path itself for the root namespace.
const dirOf = (path, ns) => (ns === '' ? path : `${path}/${ns}`);

// The tag names a database holds, read from tags.json (null when unreadable).
const tagNames = async (fsi, path) => {
  if (!(await fsi.exists(path, TAGS_FILE))) return [];
  let parsed;
  try {
    parsed = JSON.parse(await fsi.read(path, TAGS_FILE));
  } catch {
    return null;
  }
  const names = [];
  const tags = parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.tags) ? parsed.tags : [];
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    if (tag !== null && typeof tag === 'object' && typeof tag.name === 'string') names.push(tag.name);
  }
  return names;
};

// Every file of a directory removed; an absent directory is nothing.
const emptyDir = async (fsi, dir, keep = null) => {
  let names = [];
  try {
    names = await fsi.list(dir);
  } catch {
    return;
  }
  for (let i = 0; i < names.length; i++) if (names[i] !== keep) await fsi.remove(dir, names[i]);
};

const openDb = (fsi, path, capabilities, logger) => {
  const data = `${path}/${DATA}`;
  // The op log's medium: the journals and segments under log/ (src/log.js owns the log).
  const log = createJournalStore(fsi, `${path}/log`, { logger });
  const copiesDir = (tag) => `${path}/${TAGS}/${tag}/${DATA}`;
  const recordFile = (id) => `${id}${RECORD}`;

  const kv = {
    async get(ns, key) {
      const dir = dirOf(path, ns);
      if (!(await fsi.exists(dir, key))) return null;
      return fsi.read(dir, key);
    },
    has: (ns, key) => fsi.exists(dirOf(path, ns), key),
    list: (ns) => fsi.list(dirOf(path, ns)),
    put: (ns, key, value, options) => fsi.write(dirOf(path, ns), key, value, options),
    remove: (ns, key) => fsi.remove(dirOf(path, ns), key),
  };
  if (typeof fsi.create === 'function') kv.create = (ns, key, value) => fsi.create(dirOf(path, ns), key, value);

  const records = {
    /** The stored record — `{ data, meta, encrypted, timestamp, block, gen? }` — or null; a file that does not parse is INTEGRITY. */
    async get(id) {
      const text = await records.raw(id);
      if (text === null) return null;
      try {
        return JSON.parse(text);
      } catch (cause) {
        throw unreadable(id, cause);
      }
    },
    /** The record's text as the medium holds it, or null. */
    async raw(id) {
      if (!(await fsi.exists(data, recordFile(id)))) return null;
      return fsi.read(data, recordFile(id));
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
      const names = await fsi.list(data);
      const ids = [];
      for (let i = 0; i < names.length && ids.length < limit; i++) {
        const name = names[i];
        if (!name.endsWith(RECORD)) continue;
        const id = name.slice(0, -RECORD.length);
        // A record's file, never one of its pieces (`<id>~<n>.json`).
        if (!isRecordId(id) || (after !== null && id <= after)) continue;
        ids.push(id);
      }
      return ids;
    },
  };

  const pieces = {
    /** A piece's text by the name the record's meta holds (`<id>~<n>.json`), or null. */
    async get(id, name) {
      if (!(await fsi.exists(data, name))) return null;
      return fsi.read(data, name);
    },
  };

  const copies = {
    async get(tag, id) {
      const dir = copiesDir(tag);
      if (!(await fsi.exists(dir, recordFile(id)))) return null;
      return fsi.read(dir, recordFile(id));
    },
    has: (tag, id) => fsi.exists(copiesDir(tag), recordFile(id)),
    /** The ids a tag holds copies of, in id order. */
    async ids(tag) {
      const names = await fsi.list(copiesDir(tag));
      const ids = [];
      for (let i = 0; i < names.length; i++) {
        if (names[i].endsWith(RECORD)) ids.push(names[i].slice(0, -RECORD.length));
      }
      return ids;
    },
    put: (tag, id, text) => fsi.write(copiesDir(tag), recordFile(id), text),
    remove: (tag, id) => fsi.remove(copiesDir(tag), recordFile(id)),
    /** Every copy of the tag removed. */
    drop: (tag) => emptyDir(fsi, copiesDir(tag)),
  };

  // One write set, in the order a crash is safest in: the kv puts first (a
  // chain block before the records it names), then each record — the pieces
  // it makes, its file, the pieces it drops — then the copies and the kv
  // removals. Not atomic: a file system has no transactions.
  const write = async (batch) => {
    const puts = batch.kv?.put;
    if (puts !== undefined) {
      for (let i = 0; i < puts.length; i++) {
        const [ns, key, value, options] = puts[i];
        await fsi.write(dirOf(path, ns), key, value, options);
      }
    }
    const rows = batch.records;
    if (rows !== undefined) {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const made = row.pieces?.put;
        if (made !== undefined) for (let k = 0; k < made.length; k++) await fsi.write(data, made[k][0], made[k][1]);
        await fsi.write(data, recordFile(row.id), typeof row.text === 'string' ? row.text : JSON.stringify(row.stored));
        const dropped = row.pieces?.remove;
        if (dropped !== undefined) for (let k = 0; k < dropped.length; k++) await fsi.remove(data, dropped[k]);
      }
    }
    const removed = batch.remove;
    if (removed !== undefined) for (let i = 0; i < removed.length; i++) await fsi.remove(data, recordFile(removed[i]));
    const copied = batch.copies?.put;
    if (copied !== undefined) {
      for (let i = 0; i < copied.length; i++) {
        await fsi.write(copiesDir(copied[i][0]), recordFile(copied[i][1]), copied[i][2]);
      }
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
        for (let i = 0; i < tags.length; i++) dirs.push(`${TAGS}/${tags[i]}/${DATA}`, `${TAGS}/${tags[i]}/index`);
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
