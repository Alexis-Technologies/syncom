'use strict';

// The IndexedDB engine (@alexify/syncom/idb `idbEngine()`): the engine
// contract of src/engine.js over object stores, not files. One IndexedDB
// database per engine `name`, every key prefixed by the database's path so
// several databases share it; a record is a structured clone of the object
// it was handed (no JSON text made or parsed), a write set is ONE readwrite
// transaction over the stores it touches, a group of the op log one
// transaction over the `log` store, and a listing or a range is one
// `getAll`/`getAllKeys` over a key range — where the file store
// (`createIdbFsi`) spent a transaction per file and the catalog a rewrite
// of one whole file. No requires beyond engine.js and errors.js: it ships
// to the browser on its own.
//
//   store     keyPath            holds
//   kv        [p, ns, key]       { value } — the small named texts (node.json, schema.json, the keys, the lock…)
//   records   [p, id]            { stored } the record as the engine was handed it, or { text } one that is no record
//   pieces    [p, id, name]      { text } the runs of a large block, by the name the record's meta holds
//   copies    [p, tag, id]       { text } a tag's copies of records
//   log       [p, seq]           { entry, first } an entry of the op log and the first seq of its group
//   meta      [p, key]           the log's index and sealed segments, the catalog's rows
//
// Another tab over the same database hears every write through a
// BroadcastChannel named after the engine (`db.changes`), where the platform
// has one. The lock stays the database's (Web Locks in a browser).

const { capabilitiesOf, unreadableRecord, eexist } = require('../engine.js');
const { SyncomError } = require('../errors.js');

const STORES = ['kv', 'records', 'pieces', 'copies', 'log', 'meta'];
const KEYS = {
  kv: ['p', 'ns', 'key'],
  records: ['p', 'id'],
  pieces: ['p', 'id', 'name'],
  copies: ['p', 'tag', 'id'],
  log: ['p', 'seq'],
  meta: ['p', 'key'],
};
const VERSION = 1;

const request = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const completion = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = (event) => reject(tx.error ?? event?.target?.error ?? new Error('transaction aborted'));
  });

const unreadable = (id) => unreadableRecord(SyncomError, id);

// A record given as text: the object it parses to, or the text kept aside (read as INTEGRITY).
const parsed = (text) => {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { text };
  }
  return value === null || typeof value !== 'object' || Array.isArray(value) ? { text } : { stored: value };
};

/**
 * `idbEngine({ name, indexedDB, IDBKeyRange, durability, channel })` — the engine over
 * IndexedDB: the database `name` is opened lazily and reopened after another
 * tab upgrades or deletes it; `durability` is the transactions' (`'default'`,
 * `'relaxed'`, `'strict'`); `close()` closes the connection.
 */
const idbEngine = ({
  name = 'syncom',
  indexedDB = globalThis.indexedDB,
  IDBKeyRange: KeyRange = globalThis.IDBKeyRange,
  durability = 'default',
  channel: Channel = globalThis.BroadcastChannel,
} = {}) => {
  if (!indexedDB || typeof indexedDB.open !== 'function') {
    throw new TypeError('idbEngine: no indexedDB — pass one, or use another engine');
  }
  if (!KeyRange || typeof KeyRange.bound !== 'function') throw new TypeError('idbEngine: no IDBKeyRange — pass one');
  const broadcasts = typeof Channel === 'function';
  const capabilities = capabilitiesOf({
    atomicBatch: true,
    exclusiveCreate: true,
    indexes: true,
    changeStream: broadcasts,
    shared: true,
  });
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let opening = null;
  let bus = null;

  const open = () => {
    opening ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(name, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (let i = 0; i < STORES.length; i++) {
          if (!db.objectStoreNames.contains(STORES[i])) db.createObjectStore(STORES[i], { keyPath: KEYS[STORES[i]] });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab upgrades or deletes the database: let go, and the next call opens it again.
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        opening = null;
        reject(req.error);
      };
    });
    return opening;
  };

  // One transaction; `fn(stores)` makes its requests on the stores named,
  // synchronously, and the promise it answers (if any) is awaited before
  // the completion.
  const transaction = async (names, mode, fn) => {
    const db = await open();
    const tx = db.transaction(names, mode, { durability });
    const completed = completion(tx);
    completed.catch(() => {});
    const stores = {};
    for (let i = 0; i < names.length; i++) stores[names[i]] = tx.objectStore(names[i]);
    let value;
    try {
      value = await fn(stores, tx);
    } catch (error) {
      // A request that threw (a value no structured clone takes): the requests queued before it go with it.
      try {
        tx.abort();
      } catch {
        // Aborted already by the request itself.
      }
      throw error;
    }
    if (mode === 'readwrite' && typeof tx.commit === 'function') tx.commit();
    await completed;
    return value;
  };

  // Every key of a store that begins with `prefix` (an array of components):
  // a shorter array sorts before any longer one it is a prefix of, and an
  // array component sorts after every string and number, so `[]` is the
  // ceiling.
  const under = (prefix, { after = null, exclusive = false } = {}) => {
    const lower = after === null ? prefix : [...prefix, after];
    return KeyRange.bound(lower, [...prefix, []], after !== null || exclusive, true);
  };

  const post = (message) => {
    if (!broadcasts) return;
    bus ??= new Channel(`syncom:${name}`);
    bus.postMessage({ ...message, token });
  };

  const openDb = (p) => {
    const kv = {
      get: (ns, key) =>
        transaction(['kv'], 'readonly', async ({ kv: s }) => (await request(s.get([p, ns, key])))?.value ?? null),
      has: (ns, key) =>
        transaction(['kv'], 'readonly', async ({ kv: s }) => (await request(s.getKey([p, ns, key]))) !== undefined),
      list: (ns) =>
        transaction(['kv'], 'readonly', async ({ kv: s }) => {
          const keys = await request(s.getAllKeys(under([p, ns])));
          const names = [];
          for (let i = 0; i < keys.length; i++) names.push(keys[i][2]);
          return names;
        }),
      put: (ns, key, value) =>
        transaction(['kv'], 'readwrite', ({ kv: s }) => void s.put({ p, ns, key, value: String(value) })),
      remove: (ns, key) => transaction(['kv'], 'readwrite', ({ kv: s }) => void s.delete([p, ns, key])),
      // `add` refuses a key that is there: the exclusive create the lock prefers.
      create: (ns, key, value) =>
        transaction(['kv'], 'readwrite', async ({ kv: s }) => {
          try {
            await request(s.add({ p, ns, key, value: String(value) }));
          } catch (error) {
            throw error?.name === 'ConstraintError' ? eexist(`${ns}/${key}`) : error;
          }
        }),
    };

    const rowOf = (id, row) => {
      if (row === undefined) return null;
      if (row.stored === undefined) throw unreadable(id);
      return row.stored;
    };
    const records = {
      get: (id) =>
        transaction(['records'], 'readonly', async ({ records: s }) => rowOf(id, await request(s.get([p, id])))),
      raw: (id) =>
        transaction(['records'], 'readonly', async ({ records: s }) => {
          const row = await request(s.get([p, id]));
          if (row === undefined) return null;
          return row.stored === undefined ? row.text : JSON.stringify(row.stored);
        }),
      has: (id) =>
        transaction(
          ['records'],
          'readonly',
          async ({ records: s }) => (await request(s.getKey([p, id]))) !== undefined,
        ),
      getMany: (ids) =>
        transaction(['records'], 'readonly', async ({ records: s }) => {
          const requests = [];
          for (let i = 0; i < ids.length; i++) requests.push(request(s.get([p, ids[i]])));
          const rows = await Promise.all(requests);
          const found = new Map();
          for (let i = 0; i < rows.length; i++) {
            const stored = rowOf(ids[i], rows[i]);
            if (stored !== null) found.set(ids[i], stored);
          }
          return found;
        }),
      ids: ({ after = null, limit = Infinity } = {}) =>
        transaction(['records'], 'readonly', async ({ records: s }) => {
          const keys = await request(s.getAllKeys(under([p], { after }), limit === Infinity ? undefined : limit));
          const ids = [];
          for (let i = 0; i < keys.length; i++) ids.push(keys[i][1]);
          return ids;
        }),
    };

    const pieces = {
      get: (id, name) =>
        transaction(
          ['pieces'],
          'readonly',
          async ({ pieces: s }) => (await request(s.get([p, id, name])))?.text ?? null,
        ),
      remove: (id, name) => transaction(['pieces'], 'readwrite', ({ pieces: s }) => void s.delete([p, id, name])),
    };

    const copies = {
      get: (tag, id) =>
        transaction(
          ['copies'],
          'readonly',
          async ({ copies: s }) => (await request(s.get([p, tag, id])))?.text ?? null,
        ),
      has: (tag, id) =>
        transaction(
          ['copies'],
          'readonly',
          async ({ copies: s }) => (await request(s.getKey([p, tag, id]))) !== undefined,
        ),
      ids: (tag) =>
        transaction(['copies'], 'readonly', async ({ copies: s }) => {
          const keys = await request(s.getAllKeys(under([p, tag])));
          const ids = [];
          for (let i = 0; i < keys.length; i++) ids.push(keys[i][2]);
          return ids;
        }),
      put: (tag, id, text) => transaction(['copies'], 'readwrite', ({ copies: s }) => void s.put({ p, tag, id, text })),
      remove: (tag, id) => transaction(['copies'], 'readwrite', ({ copies: s }) => void s.delete([p, tag, id])),
      drop: (tag) => transaction(['copies'], 'readwrite', ({ copies: s }) => void s.delete(under([p, tag]))),
    };

    // The catalog's rows, as one value of the meta store: a structured clone, no text.
    const catalog = {
      load: () =>
        transaction(['meta'], 'readonly', async ({ meta: s }) => (await request(s.get([p, 'catalog'])))?.value ?? null),
      save: (indexes, stamp, { all }) =>
        transaction(
          ['meta'],
          'readwrite',
          ({ meta: s }) => void s.put({ p, key: 'catalog', value: { indexes, stamp, rows: all() } }),
        ),
    };

    // The op log's medium: a row per entry, the group's first seq beside it,
    // the index and the sealed segments in the meta store.
    const log = (() => {
      let groups = [];
      let segments = [];
      const firstOf = new Map();
      const sealedTo = () => (segments.length > 0 ? segments[segments.length - 1].to : null);
      const saveSegments = (s, list) => s.put({ p, key: 'segments', value: list.slice() });
      return {
        journaled: false,
        async load() {
          return transaction(['log', 'meta'], 'readonly', async ({ log: l, meta: m }) => {
            const [index, saved, rows] = await Promise.all([
              request(m.get([p, 'index'])),
              request(m.get([p, 'segments'])),
              request(l.getAll(under([p]))),
            ]);
            segments = Array.isArray(saved?.value) ? saved.value : [];
            const entries = [];
            const byFirst = new Map();
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              entries.push(row.entry);
              firstOf.set(row.seq, row.first);
              let group = byFirst.get(row.first);
              if (group === undefined) byFirst.set(row.first, (group = { first: row.first, last: row.seq, seqs: [] }));
              if (row.seq > group.last) group.last = row.seq;
              group.seqs.push(row.seq);
            }
            const stored = index?.value ?? null;
            const floor = stored !== null ? stored.floor : entries.length > 0 ? entries[0].seq : 1;
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
            groups.sort((a, b) => a.first - b.first);
            open.sort((a, b) => a.first - b.first);
            return { index: stored, hasIndex: stored !== null, entries, groups: open, floor, lost: false };
          });
        },
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
          return 0;
        },
        get health() {
          return { journaled: false, open: groups.length, torn: 0, lost: false };
        },
        async append(entries, _headers, { first, last, onFail }) {
          try {
            await transaction(['log'], 'readwrite', ({ log: l }) => {
              for (let i = 0; i < entries.length; i++) l.put({ p, seq: entries[i].seq, entry: entries[i], first });
            });
          } catch (error) {
            onFail(error);
            return false;
          }
          for (let i = 0; i < entries.length; i++) firstOf.set(entries[i].seq, first);
          groups.push({ first, last });
          post({ p, log: [first, last] });
          return true;
        },
        // The list in memory moves once the medium has it: a seal or a drop that fails leaves it as it was.
        async seal(entries, from, to) {
          const next = segments.concat([{ from, to, count: entries.length }]);
          await transaction(['meta'], 'readwrite', ({ meta: m }) => void saveSegments(m, next));
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
          await transaction(['log', 'meta'], 'readwrite', ({ log: l, meta: m }) => {
            l.delete(KeyRange.bound([p, segment.from], [p, segment.to]));
            saveSegments(m, rest);
          });
          segments = rest;
          for (let seq = segment.from; seq <= segment.to; seq++) firstOf.delete(seq);
        },
        saveIndex: (index) =>
          transaction(['meta'], 'readwrite', ({ meta: m }) => void m.put({ p, key: 'index', value: index })),
        // The rows at `seqs` written again as the entries are now (a scrub stripped them).
        async scrub(seqs, { entriesBetween }) {
          if (seqs.length === 0) return;
          await transaction(['log'], 'readwrite', ({ log: l }) => {
            for (let i = 0; i < seqs.length; i++) {
              const held = entriesBetween(seqs[i], seqs[i]);
              if (held.length === 1) l.put({ p, seq: seqs[i], entry: held[0], first: firstOf.get(seqs[i]) ?? seqs[i] });
            }
          });
        },
      };
    })();

    // One write set, one transaction over the stores it touches: whole or not at all.
    const write = async (batch) => {
      const names = [];
      if (batch.kv !== undefined) names.push('kv');
      if (batch.records !== undefined || batch.remove !== undefined) names.push('records', 'pieces');
      if (batch.copies !== undefined) names.push('copies');
      if (names.length === 0) return;
      const ids = [];
      await transaction(names, 'readwrite', (s) => {
        const puts = batch.kv?.put;
        if (puts !== undefined) {
          for (let i = 0; i < puts.length; i++) {
            s.kv.put({ p, ns: puts[i][0], key: puts[i][1], value: String(puts[i][2]) });
          }
        }
        const rows = batch.records;
        if (rows !== undefined) {
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const made = row.pieces?.put;
            if (made !== undefined) {
              for (let k = 0; k < made.length; k++) s.pieces.put({ p, id: row.id, name: made[k][0], text: made[k][1] });
            }
            s.records.put({ p, id: row.id, ...(row.stored !== undefined ? { stored: row.stored } : parsed(row.text)) });
            const dropped = row.pieces?.remove;
            if (dropped !== undefined) {
              for (let k = 0; k < dropped.length; k++) s.pieces.delete([p, row.id, dropped[k]]);
            }
            ids.push(row.id);
          }
        }
        const removed = batch.remove;
        if (removed !== undefined) {
          for (let i = 0; i < removed.length; i++) {
            s.records.delete([p, removed[i]]);
            ids.push(removed[i]);
          }
        }
        const copied = batch.copies?.put;
        if (copied !== undefined) {
          for (let i = 0; i < copied.length; i++) {
            s.copies.put({ p, tag: copied[i][0], id: copied[i][1], text: copied[i][2] });
          }
        }
        const removals = batch.kv?.remove;
        if (removals !== undefined) {
          for (let i = 0; i < removals.length; i++) s.kv.delete([p, removals[i][0], removals[i][1]]);
        }
      });
      if (ids.length > 0) post({ p, records: ids });
    };

    // What another instance over the same database wrote: `{ records: ids }`
    // or `{ log: [first, last] }`, this instance's own writes left out.
    const changes = broadcasts
      ? {
          subscribe(listener) {
            const listening = new Channel(`syncom:${name}`);
            listening.onmessage = (event) => {
              const message = event.data;
              if (message === null || typeof message !== 'object' || message.p !== p || message.token === token) return;
              listener(message);
            };
            return () => listening.close();
          },
        }
      : undefined;

    const db = { path: p, capabilities, kv, records, pieces, copies, catalog, log, write, close: async () => {} };
    if (changes !== undefined) db.changes = changes;
    return Object.freeze(db);
  };

  return Object.freeze({
    name: 'idb',
    capabilities,
    open: async (path) => openDb(path),
    /** Every row of the database at `path`, in every store, in one transaction. */
    remove: (path) =>
      transaction(STORES, 'readwrite', (s) => {
        for (let i = 0; i < STORES.length; i++) s[STORES[i]].delete(under([path]));
      }),
    /** Closes the connection; the next call opens it again. */
    async close() {
      bus?.close();
      bus = null;
      if (opening === null) return;
      const db = await opening.catch(() => null);
      opening = null;
      db?.close();
    },
    /** Deletes the whole IndexedDB database — every path's stores. */
    async destroy() {
      await this.close();
      await request(indexedDB.deleteDatabase(name));
    },
  });
};

module.exports = { idbEngine };
