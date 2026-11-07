'use strict';

// The SQLite engine (@alexify/syncom/sqlite `sqliteEngine()`): the engine
// contract of src/engine.js over one SQLite database — `node:sqlite` by
// default (Node 24+, where it needs no flag; experimental, so Node prints a warning at the require,
// which the engine does not silence: `node --no-warnings=ExperimentalWarning`,
// or give a driver), or any driver whose database has `exec(sql)` and
// `prepare(sql)` → `{ run, get, all }` (better-sqlite3, expo-sqlite,
// @capacitor-community/sqlite… every result is awaited, so a promise-returning
// one works). One file holds every database opened through the engine, each
// row keyed by the database's path `p` first; a write set is ONE transaction,
// a group of the op log one, a listing one statement over a primary-key range.
// Every statement goes through one lane, so two write sets never interleave
// their statements on the one connection. Requires engine.js and errors.js
// only — node:sqlite is required inside the factory, when no driver is given.
//
//   table    primary key        holds
//   kv       (p, ns, key)       value — the small named texts (node.json, schema.json, the keys, the lock…)
//   records  (p, id)            text — the record's JSON as the engine was handed it (an object stringified once)
//   pieces   (p, id, name)      text — the runs of a large block, by the name the record's meta holds
//   copies   (p, tag, id)       text — a tag's copies of records
//   log      (p, seq)           first, entry — an entry of the op log (JSON) and the first seq of its group
//   meta     (p, key)           value — the log's index and sealed segments, the catalog's indexes and stamp
//   catalog  (p, id)            row — the catalog's row of a record (JSON), a row at a time

const { capabilitiesOf, unreadableRecord, eexist } = require('../engine.js');
const { checkDigest, checkBlobBytes } = require('../blobs.js');
const { SyncomError, typed } = require('../errors.js');

const MEMORY = ':memory:';
const TABLES = ['kv', 'records', 'pieces', 'copies', 'log', 'meta', 'catalog', 'blobs'];
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS kv (p TEXT NOT NULL, ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (p, ns, key)) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS records (p TEXT NOT NULL, id TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (p, id)) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS pieces (p TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (p, id, name)) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS copies (p TEXT NOT NULL, tag TEXT NOT NULL, id TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (p, tag, id)) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS log (p TEXT NOT NULL, seq INTEGER NOT NULL, first INTEGER NOT NULL, entry TEXT NOT NULL, PRIMARY KEY (p, seq)) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS meta (p TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (p, key)) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS catalog (p TEXT NOT NULL, id TEXT NOT NULL, row TEXT NOT NULL, PRIMARY KEY (p, id)) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS blobs (p TEXT NOT NULL, digest TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (p, digest)) WITHOUT ROWID',
];
const SQL = {
  kvGet: 'SELECT value FROM kv WHERE p = ? AND ns = ? AND key = ?',
  kvList: 'SELECT key FROM kv WHERE p = ? AND ns = ?',
  kvPut: 'INSERT OR REPLACE INTO kv (p, ns, key, value) VALUES (?, ?, ?, ?)',
  kvInsert: 'INSERT INTO kv (p, ns, key, value) VALUES (?, ?, ?, ?)',
  kvRemove: 'DELETE FROM kv WHERE p = ? AND ns = ? AND key = ?',
  recordGet: 'SELECT text FROM records WHERE p = ? AND id = ?',
  recordMany: 'SELECT id, text FROM records WHERE p = ? AND id IN (SELECT value FROM json_each(?))',
  recordIds: 'SELECT id FROM records WHERE p = ? AND id > ? ORDER BY id LIMIT ?',
  recordPut: 'INSERT OR REPLACE INTO records (p, id, text) VALUES (?, ?, ?)',
  recordRemove: 'DELETE FROM records WHERE p = ? AND id = ?',
  pieceGet: 'SELECT text FROM pieces WHERE p = ? AND id = ? AND name = ?',
  pieceAll: 'SELECT name, text FROM pieces WHERE p = ? AND id = ?',
  piecePut: 'INSERT OR REPLACE INTO pieces (p, id, name, text) VALUES (?, ?, ?, ?)',
  pieceRemove: 'DELETE FROM pieces WHERE p = ? AND id = ? AND name = ?',
  copyGet: 'SELECT text FROM copies WHERE p = ? AND tag = ? AND id = ?',
  copyIds: 'SELECT id FROM copies WHERE p = ? AND tag = ?',
  copyPut: 'INSERT OR REPLACE INTO copies (p, tag, id, text) VALUES (?, ?, ?, ?)',
  copyRemove: 'DELETE FROM copies WHERE p = ? AND tag = ? AND id = ?',
  copyDrop: 'DELETE FROM copies WHERE p = ? AND tag = ?',
  blobGet: 'SELECT bytes FROM blobs WHERE p = ? AND digest = ?',
  blobHas: 'SELECT 1 AS held FROM blobs WHERE p = ? AND digest = ? LIMIT 1',
  pageCount: 'PRAGMA page_count',
  pageSize: 'PRAGMA page_size',
  blobList: 'SELECT digest FROM blobs WHERE p = ? ORDER BY digest',
  blobPut: 'INSERT OR REPLACE INTO blobs (p, digest, bytes) VALUES (?, ?, ?)',
  blobRemove: 'DELETE FROM blobs WHERE p = ? AND digest = ?',
  logAll: 'SELECT seq, first, entry FROM log WHERE p = ? ORDER BY seq',
  logPut: 'INSERT OR REPLACE INTO log (p, seq, first, entry) VALUES (?, ?, ?, ?)',
  logDrop: 'DELETE FROM log WHERE p = ? AND seq >= ? AND seq <= ?',
  metaGet: 'SELECT value FROM meta WHERE p = ? AND key = ?',
  metaPut: 'INSERT OR REPLACE INTO meta (p, key, value) VALUES (?, ?, ?)',
  catalogAll: 'SELECT id, row FROM catalog WHERE p = ?',
  catalogPut: 'INSERT OR REPLACE INTO catalog (p, id, row) VALUES (?, ?, ?)',
  catalogRemove: 'DELETE FROM catalog WHERE p = ? AND id = ?',
  catalogDrop: 'DELETE FROM catalog WHERE p = ?',
};
const BEGIN = 'BEGIN IMMEDIATE';
const COMMIT = 'COMMIT';
const ROLLBACK = 'ROLLBACK';

const noop = () => {};
const unreadable = (id, cause = null) => unreadableRecord(SyncomError, id, cause);

// A record's text read back: the object it parses to, or INTEGRITY.
const parsed = (id, text) => {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw unreadable(id, error);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw unreadable(id);
  return value;
};

// A driver's row for "none": `undefined` (node:sqlite, better-sqlite3) or `null`.
const none = (row) => row === undefined || row === null;

const pragmas = (file, full) => {
  const lines = [`PRAGMA synchronous = ${full ? 'FULL' : 'NORMAL'}`, 'PRAGMA busy_timeout = 5000'];
  if (file !== MEMORY) lines.unshift('PRAGMA journal_mode = WAL');
  return lines;
};

/**
 * `sqliteEngine({ file, database, driver, durable })` — the engine over SQLite:
 * `file` (`':memory:'` by default) is opened lazily through `node:sqlite`, or
 * through `driver.open(file)`; `database` is an open connection the caller
 * owns (the engine never closes it). `close()` closes a connection the engine
 * opened — the next call opens it again (a `:memory:` database starts over);
 * `destroy()` closes and deletes the file.
 */
const sqliteEngine = ({ file = MEMORY, database = null, driver = null, durable = false } = {}) => {
  if (typeof file !== 'string' || file.length === 0) throw new TypeError('sqliteEngine: file is a path or ":memory:"');
  if (driver !== null && typeof driver?.open !== 'function') throw new TypeError('sqliteEngine: driver has no open()');
  const capabilities = capabilitiesOf({ atomicBatch: true, exclusiveCreate: true, indexes: true, blobs: true });
  let connection = null;
  let opening = null;
  let statements = new Map();
  let full = durable;
  let tail = Promise.resolve();

  const openConnection = () => {
    if (database !== null) return database;
    if (driver !== null) return driver.open(file);
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(file);
  };

  const connect = () => {
    if (connection !== null) return connection;
    opening ??= (async () => {
      try {
        const conn = await openConnection();
        if (typeof conn?.exec !== 'function' || typeof conn.prepare !== 'function') {
          throw new TypeError('sqliteEngine: the database has no exec() and prepare()');
        }
        // A connection the caller gave keeps its settings: only `durable` reaches it.
        const setup = database !== null ? (full ? ['PRAGMA synchronous = FULL'] : []) : pragmas(file, full);
        for (let i = 0; i < setup.length; i++) await conn.exec(setup[i]);
        for (let i = 0; i < SCHEMA.length; i++) await conn.exec(SCHEMA[i]);
        statements = new Map();
        connection = conn;
        return conn;
      } finally {
        opening = null;
      }
    })();
    return opening;
  };

  // A prepared statement, kept for the connection's life.
  const statement = async (sql) => {
    const conn = await connect();
    let prepared = statements.get(sql);
    if (prepared === undefined) {
      prepared = await conn.prepare(sql);
      statements.set(sql, prepared);
    }
    return prepared;
  };

  // The lane every statement goes through: a transaction's statements are
  // awaited one by one, and nothing else runs on the connection between them.
  const serial = (fn) => {
    const run = tail.then(fn);
    tail = run.then(noop, noop);
    return run;
  };
  // `params` is a short fixed list of a statement's own arguments, never a data array.
  const get = (sql, params) => serial(async () => (await statement(sql)).get(...params));
  const all = (sql, params) => serial(async () => (await statement(sql)).all(...params));
  const run = (sql, params) =>
    serial(async () => {
      await (await statement(sql)).run(...params);
    });
  // `fn(tx)` runs its statements through `tx` on the lane: in one transaction,
  // whole or not at all — a COMMIT that fails (BUSY, FULL, an I/O error) is
  // rolled back too, or the connection would hold an open transaction for
  // good — or, a read, outside one.
  const over = (fn, atomic) =>
    serial(async () => {
      const conn = await connect();
      const tx = {
        run: async (sql, params) => void (await (await statement(sql)).run(...params)),
        get: async (sql, params) => (await statement(sql)).get(...params),
        all: async (sql, params) => (await statement(sql)).all(...params),
      };
      if (!atomic) return fn(tx);
      await conn.exec(BEGIN);
      let value;
      try {
        value = await fn(tx);
        await conn.exec(COMMIT);
      } catch (error) {
        try {
          await conn.exec(ROLLBACK);
        } catch {
          // The failure that got here is the one to report.
        }
        throw error;
      }
      return value;
    });
  const transaction = (fn) => over(fn, true);
  const read = (fn) => over(fn, false);

  const names = (rows, column) => {
    const out = [];
    for (let i = 0; i < rows.length; i++) out.push(rows[i][column]);
    return out.sort();
  };

  const openDb = (p, logger) => {
    const kv = {
      get: async (ns, key) => {
        const row = await get(SQL.kvGet, [p, ns, key]);
        return none(row) ? null : row.value;
      },
      has: async (ns, key) => !none(await get(SQL.kvGet, [p, ns, key])),
      list: async (ns) => names(await all(SQL.kvList, [p, ns]), 'key'),
      put: (ns, key, value) => run(SQL.kvPut, [p, ns, key, String(value)]),
      remove: (ns, key) => run(SQL.kvRemove, [p, ns, key]),
      // The exclusive create the lock prefers: the key read and made in one transaction.
      create: (ns, key, value) =>
        transaction(async (tx) => {
          if (!none(await tx.get(SQL.kvGet, [p, ns, key]))) throw eexist(`${ns}/${key}`);
          await tx.run(SQL.kvInsert, [p, ns, key, String(value)]);
        }),
    };

    const records = {
      get: async (id) => {
        const row = await get(SQL.recordGet, [p, id]);
        return none(row) ? null : parsed(id, row.text);
      },
      raw: async (id) => {
        const row = await get(SQL.recordGet, [p, id]);
        return none(row) ? null : row.text;
      },
      has: async (id) => !none(await get(SQL.recordGet, [p, id])),
      // One statement over the ids (json_each), the result in the order asked.
      getMany: async (ids) => {
        const rows = await all(SQL.recordMany, [p, JSON.stringify(ids)]);
        const texts = new Map();
        for (let i = 0; i < rows.length; i++) texts.set(rows[i].id, rows[i].text);
        const found = new Map();
        for (let i = 0; i < ids.length; i++) {
          const text = texts.get(ids[i]);
          if (text !== undefined) found.set(ids[i], parsed(ids[i], text));
        }
        return found;
      },
      ids: async ({ after = null, limit = Infinity } = {}) => {
        const rows = await all(SQL.recordIds, [p, after ?? '', limit === Infinity ? -1 : limit]);
        const ids = [];
        for (let i = 0; i < rows.length; i++) ids.push(rows[i].id);
        return ids;
      },
    };

    const pieces = {
      get: async (id, name) => {
        const row = await get(SQL.pieceGet, [p, id, name]);
        return none(row) ? null : row.text;
      },
      // Every piece of the record in one statement over the key's prefix, the ones named kept.
      getMany: async (id, names) => {
        const rows = await all(SQL.pieceAll, [p, id]);
        const wanted = new Set(names);
        const found = new Map();
        for (let i = 0; i < rows.length; i++) if (wanted.has(rows[i].name)) found.set(rows[i].name, rows[i].text);
        return found;
      },
      remove: (id, name) => run(SQL.pieceRemove, [p, id, name]),
    };

    const copies = {
      get: async (tag, id) => {
        const row = await get(SQL.copyGet, [p, tag, id]);
        return none(row) ? null : row.text;
      },
      has: async (tag, id) => !none(await get(SQL.copyGet, [p, tag, id])),
      ids: async (tag) => names(await all(SQL.copyIds, [p, tag]), 'id'),
      put: (tag, id, text) => run(SQL.copyPut, [p, tag, id, text]),
      remove: (tag, id) => run(SQL.copyRemove, [p, tag, id]),
      drop: (tag) => run(SQL.copyDrop, [p, tag]),
    };

    // Attachments' bytes by digest, a BLOB a row; the digest checked before the statement.
    const blobs = {
      get: async (digest) => {
        const row = await get(SQL.blobGet, [p, checkDigest(digest, 'blobs.get')]);
        return none(row) ? null : new Uint8Array(row.bytes);
      },
      has: async (digest) => !none(await get(SQL.blobHas, [p, checkDigest(digest, 'blobs.has')])),
      list: async () => names(await all(SQL.blobList, [p]), 'digest'),
      put: async (digest, bytes) =>
        run(SQL.blobPut, [p, checkDigest(digest, 'blobs.put'), checkBlobBytes(typed, bytes, 'blobs.put')]),
      remove: async (digest) => run(SQL.blobRemove, [p, checkDigest(digest, 'blobs.remove')]),
    };

    const meta = async (tx, key) => {
      const row = await tx.get(SQL.metaGet, [p, key]);
      if (none(row)) return null;
      try {
        return JSON.parse(row.value);
      } catch (error) {
        // A meta row that does not read is none: an index that is no index, no segments — said out loud.
        logger?.warn?.({ event: 'log.meta.unreadable', key, err: error });
        return null;
      }
    };

    // The op log's medium: a row per entry with the first seq of its group,
    // the index and the sealed segments in the meta table.
    const log = (() => {
      let groups = [];
      let segments = [];
      // Rows that did not read at open: counted, left out — the log holds less than it held.
      let corrupt = 0;
      let lost = false;
      const firstOf = new Map();
      const sealedTo = () => (segments.length > 0 ? segments[segments.length - 1].to : null);
      const saveSegments = (tx, list) => tx.run(SQL.metaPut, [p, 'segments', JSON.stringify(list)]);
      return {
        journaled: false,
        // A read outside a transaction: nothing else runs on the lane between its statements.
        load: () =>
          read(async (tx) => {
            const index = await meta(tx, 'index');
            const saved = await meta(tx, 'segments');
            segments = Array.isArray(saved) ? saved : [];
            const rows = await tx.all(SQL.logAll, [p]);
            const entries = [];
            const byFirst = new Map();
            for (let i = 0; i < rows.length; i++) {
              const { seq, first } = rows[i];
              let entry;
              try {
                entry = JSON.parse(rows[i].entry);
              } catch (error) {
                corrupt++;
                lost = true;
                logger?.warn?.({ event: 'log.row.unreadable', seq, err: error });
                continue;
              }
              entries.push(entry);
              firstOf.set(seq, first);
              let group = byFirst.get(first);
              if (group === undefined) byFirst.set(first, (group = { first, last: seq, seqs: [] }));
              if (seq > group.last) group.last = seq;
              group.seqs.push(seq);
            }
            const floor = index !== null ? index.floor : entries.length > 0 ? entries[0].seq : 1;
            const sealed = sealedTo() ?? floor - 1;
            groups = [];
            const open = [];
            for (const group of byFirst.values()) {
              if (group.last <= sealed) continue;
              groups.push({ first: group.first, last: group.last });
              const unsealed = [];
              for (let i = 0; i < group.seqs.length; i++) if (group.seqs[i] > sealed) unsealed.push(group.seqs[i]);
              open.push({ first: group.first, last: group.last, unsealed });
            }
            return { index, hasIndex: index !== null, entries, groups: open, floor, lost: false };
          }),
        get sealedTo() {
          return sealedTo();
        },
        get open() {
          return groups.length;
        },
        get segments() {
          return segments;
        },
        get corrupt() {
          return corrupt;
        },
        get health() {
          return { journaled: false, open: groups.length, torn: 0, lost };
        },
        async append(entries, _headers, { first, last, onFail }) {
          try {
            await transaction(async (tx) => {
              for (let i = 0; i < entries.length; i++) {
                await tx.run(SQL.logPut, [p, entries[i].seq, first, JSON.stringify(entries[i])]);
              }
            });
          } catch (error) {
            onFail(error);
            return false;
          }
          for (let i = 0; i < entries.length; i++) firstOf.set(entries[i].seq, first);
          groups.push({ first, last });
          return true;
        },
        // The list in memory moves once the medium has it: a seal or a drop that fails leaves it as it was.
        async seal(entries, from, to) {
          const next = segments.concat([{ from, to, count: entries.length }]);
          await transaction((tx) => saveSegments(tx, next));
          segments = next;
        },
        async sealed(to) {
          const kept = [];
          for (let i = 0; i < groups.length; i++) if (groups[i].last > to) kept.push(groups[i]);
          groups = kept;
        },
        async drop(segment) {
          if (segments[0] !== segment) throw new TypeError('drop(segment): the oldest segment goes first');
          const rest = segments.slice(1);
          await transaction(async (tx) => {
            await tx.run(SQL.logDrop, [p, segment.from, segment.to]);
            await saveSegments(tx, rest);
          });
          segments = rest;
          for (let seq = segment.from; seq <= segment.to; seq++) firstOf.delete(seq);
        },
        saveIndex: (index) => run(SQL.metaPut, [p, 'index', JSON.stringify(index)]),
        // The rows at `seqs` written again as the entries are now (a scrub stripped them).
        async scrub(seqs, { entriesBetween }) {
          if (seqs.length === 0) return;
          await transaction(async (tx) => {
            for (let i = 0; i < seqs.length; i++) {
              const held = entriesBetween(seqs[i], seqs[i]);
              if (held.length === 1) {
                await tx.run(SQL.logPut, [p, seqs[i], firstOf.get(seqs[i]) ?? seqs[i], JSON.stringify(held[0])]);
              }
            }
          });
        },
      };
    })();

    // One write set, one transaction: whole or not at all.
    const write = async (batch) => {
      if (
        batch.kv === undefined &&
        batch.records === undefined &&
        batch.remove === undefined &&
        batch.copies === undefined
      ) {
        return;
      }
      await transaction(async (tx) => {
        const puts = batch.kv?.put;
        if (puts !== undefined) {
          for (let i = 0; i < puts.length; i++) {
            await tx.run(SQL.kvPut, [p, puts[i][0], puts[i][1], String(puts[i][2])]);
          }
        }
        const rows = batch.records;
        if (rows !== undefined) {
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const made = row.pieces?.put;
            if (made !== undefined) {
              for (let k = 0; k < made.length; k++) await tx.run(SQL.piecePut, [p, row.id, made[k][0], made[k][1]]);
            }
            await tx.run(SQL.recordPut, [p, row.id, row.stored !== undefined ? JSON.stringify(row.stored) : row.text]);
            const dropped = row.pieces?.remove;
            if (dropped !== undefined) {
              for (let k = 0; k < dropped.length; k++) await tx.run(SQL.pieceRemove, [p, row.id, dropped[k]]);
            }
          }
        }
        const removed = batch.remove;
        if (removed !== undefined) {
          for (let i = 0; i < removed.length; i++) await tx.run(SQL.recordRemove, [p, removed[i]]);
        }
        const copied = batch.copies?.put;
        if (copied !== undefined) {
          for (let i = 0; i < copied.length; i++) {
            await tx.run(SQL.copyPut, [p, copied[i][0], copied[i][1], copied[i][2]]);
          }
        }
        const removals = batch.kv?.remove;
        if (removals !== undefined) {
          for (let i = 0; i < removals.length; i++) await tx.run(SQL.kvRemove, [p, removals[i][0], removals[i][1]]);
        }
      });
    };

    // The catalog's rows, a row of the catalog table each — a save writes the rows
    // that changed and the indexes and stamp into meta, so a catalog grows no
    // document and no text: nothing here is ever the whole catalog at once.
    const catalog = {
      load: () =>
        read(async (tx) => {
          const head = await meta(tx, 'catalog');
          if (head === null || typeof head !== 'object') return null;
          const rows = await tx.all(SQL.catalogAll, [p]);
          const out = [];
          for (let i = 0; i < rows.length; i++) {
            let row;
            try {
              row = JSON.parse(rows[i].row);
            } catch (error) {
              // A row that does not read: no catalog — the core rebuilds it from the records, and this save replaces every row.
              logger?.warn?.({ event: 'catalog.row.unreadable', id: rows[i].id, err: error });
              return null;
            }
            out.push([rows[i].id, row]);
          }
          return { indexes: head.indexes, stamp: head.stamp, rows: out };
        }),
      save: (indexes, stamp, { all, changed, whole }) =>
        transaction(async (tx) => {
          if (whole) {
            await tx.run(SQL.catalogDrop, [p]);
            const rows = all();
            for (let i = 0; i < rows.length; i++) {
              await tx.run(SQL.catalogPut, [p, rows[i][0], JSON.stringify(rows[i][1])]);
            }
          } else {
            for (const [id, row] of changed) {
              if (row === null) await tx.run(SQL.catalogRemove, [p, id]);
              else await tx.run(SQL.catalogPut, [p, id, JSON.stringify(row)]);
            }
          }
          await tx.run(SQL.metaPut, [p, 'catalog', JSON.stringify({ indexes, stamp })]);
        }),
    };

    // The room: what the file holds (`page_count × page_size` — the whole file, every database in it) and the free
    // space of the file's volume; a `:memory:` database, or a connection given, says nothing of the volume.
    const estimate = async () => {
      const pages = await get(SQL.pageCount, []);
      const size = await get(SQL.pageSize, []);
      const usage = none(pages) || none(size) ? null : Number(pages.page_count) * Number(size.page_size);
      let quota = null;
      if (file !== MEMORY && database === null) {
        try {
          const { statfs } = require('node:fs/promises');
          const { dirname } = require('node:path');
          const stats = await statfs(dirname(file));
          quota = Number(stats.bavail) * Number(stats.bsize);
        } catch {
          // No volume to ask (a driver over another platform): the usage alone.
        }
      }
      return { usage, quota };
    };

    return Object.freeze({
      path: p,
      capabilities,
      kv,
      records,
      pieces,
      copies,
      log,
      catalog,
      blobs,
      write,
      estimate,
      close: async () => {},
    });
  };

  return Object.freeze({
    name: 'sqlite',
    capabilities,
    /** The file every database opened through the engine lives in. */
    file,
    async open(path, { durable: wanted = false, logger = null } = {}) {
      // `durable: true` on any database makes every write of the connection wait for the disk.
      if (wanted && !full) {
        full = true;
        if (connection !== null) await serial(() => connection.exec('PRAGMA synchronous = FULL'));
      }
      return openDb(path, logger);
    },
    /** Every row of the database at `path`, in every table, in one transaction. */
    remove: (path) =>
      transaction(async (tx) => {
        for (let i = 0; i < TABLES.length; i++) await tx.run(`DELETE FROM ${TABLES[i]} WHERE p = ?`, [path]);
      }),
    /** Closes a connection the engine opened; the next call opens the file again. */
    close: () =>
      serial(async () => {
        const conn = connection;
        connection = null;
        statements = new Map();
        if (conn === null || conn === database) return;
        if (typeof conn.close === 'function') await conn.close();
      }),
    /** Closes, then deletes the file (and its WAL) — nothing for `:memory:` or a connection given. */
    async destroy() {
      await this.close();
      if (file === MEMORY || database !== null) return;
      const { rm } = require('node:fs/promises');
      const suffixes = ['', '-wal', '-shm', '-journal'];
      for (let i = 0; i < suffixes.length; i++) await rm(`${file}${suffixes[i]}`, { force: true });
    },
  });
};

module.exports = { sqliteEngine };
