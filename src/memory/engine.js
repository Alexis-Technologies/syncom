'use strict';

// The engine in memory (@alexify/syncom/memory `memoryEngine()`): the engine
// contract of src/engine.js over Maps — a record as the object it was handed,
// never a JSON text; the op log as rows, no journal lines or segments to
// write and read back; the catalog's rows kept as they are. One engine object
// is shared by every database that opens through it — a mesh in one process
// — and a database at a path outlives its instance until `remove(path)`, so a
// reopen reads what the last instance wrote. Nothing survives the process.
// Requires engine.js and errors.js only.

const { capabilitiesOf, unreadableRecord, eexist } = require('../engine.js');
const { checkDigest, checkBlobBytes } = require('../blobs.js');
const { SyncomError, typed } = require('../errors.js');

const CAPABILITIES = capabilitiesOf({
  atomicBatch: true,
  exclusiveCreate: true,
  indexes: true,
  shared: true,
  changeStream: true,
  blobs: true,
});

// A record handed in as text that is no record: kept as the text, read as
// INTEGRITY — what a torn file reads as under the files engine.
class Torn {
  constructor(text) {
    this.text = text;
  }
}
const unreadable = (id) => unreadableRecord(SyncomError, id);
// A record given as text: the object it parses to, or the text kept aside.
const parsed = (text) => {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return new Torn(text);
  }
  return value === null || typeof value !== 'object' || Array.isArray(value) ? new Torn(text) : value;
};

const sorted = (keys) => {
  const names = [];
  for (const key of keys) names.push(key);
  return names.sort();
};

// A deep copy through JSON: what the index is saved as (the log's vector is
// a live object; the copy stands still).
const frozenCopy = (value) => JSON.parse(JSON.stringify(value));

// The op log's medium over arrays: `append` pushes the entries — the very
// objects the log holds, so a scrub that strips an op in memory has stripped
// it here too — `seal` records a range, `drop` takes a range away, the index
// is a copy. A reopen loads every entry back as it is.
const logStore = () => {
  let index = null;
  let entries = [];
  let groups = [];
  const segments = [];
  const sealedTo = () => (segments.length > 0 ? segments[segments.length - 1].to : null);
  return {
    journaled: false,
    async load() {
      const sealed = sealedTo() ?? (index !== null ? index.floor : (entries[0]?.seq ?? 1)) - 1;
      const open = [];
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        const unsealed = [];
        for (let seq = Math.max(group.first, sealed + 1); seq <= group.last; seq++) unsealed.push(seq);
        open.push({ first: group.first, last: group.last, unsealed });
      }
      const floor = index !== null ? index.floor : entries.length > 0 ? entries[0].seq : 1;
      return {
        index: index === null ? null : frozenCopy(index),
        hasIndex: index !== null,
        entries: entries.slice(),
        groups: open,
        floor,
        lost: false,
      };
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
    async append(batch, _headers, { first, last }) {
      for (let i = 0; i < batch.length; i++) entries.push(batch[i]);
      groups.push({ first, last });
      return true;
    },
    async seal(batch, from, to) {
      segments.push({ from, to, count: batch.length });
    },
    async sealed(to) {
      const kept = [];
      for (let i = 0; i < groups.length; i++) if (groups[i].last > to) kept.push(groups[i]);
      groups = kept;
    },
    async drop(segment) {
      if (segments[0] !== segment) throw new TypeError('drop(segment): the oldest segment goes first');
      segments.shift();
      let cut = 0;
      while (cut < entries.length && entries[cut].seq <= segment.to) cut++;
      if (cut > 0) entries = entries.slice(cut);
    },
    async saveIndex(next) {
      index = frozenCopy(next);
    },
    // The entries are the log's own objects, stripped by the scrub already —
    // unless a wrapper keeps copies (atRest seals them, a port clones them):
    // the entry at each seq is swapped for what it is now.
    async scrub(seqs, { entriesBetween }) {
      for (let i = 0; i < seqs.length; i++) {
        const held = entriesBetween(seqs[i], seqs[i]);
        if (held.length !== 1) continue;
        let low = 0;
        let high = entries.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if (entries[mid].seq < seqs[i]) low = mid + 1;
          else high = mid;
        }
        if (low < entries.length && entries[low].seq === seqs[i]) entries[low] = held[0];
      }
    },
  };
};

const openDb = (path) => {
  const spaces = new Map();
  const records = new Map();
  // The record ids sorted, until a write set changes them.
  let sortedIds = null;
  const pieces = new Map();
  const copies = new Map();
  let catalog = null;
  const space = (ns) => {
    let keys = spaces.get(ns);
    if (keys === undefined) spaces.set(ns, (keys = new Map()));
    return keys;
  };
  // Attachments' bytes by digest, copied in and out.
  const blobs = new Map();
  const blobStore = {
    async get(digest) {
      const bytes = blobs.get(checkDigest(digest, 'blobs.get'));
      return bytes === undefined ? null : bytes.slice();
    },
    async has(digest) {
      return blobs.has(checkDigest(digest, 'blobs.has'));
    },
    async list() {
      return sorted(blobs.keys());
    },
    async put(digest, bytes) {
      blobs.set(checkDigest(digest, 'blobs.put'), checkBlobBytes(typed, bytes, 'blobs.put').slice());
    },
    async remove(digest) {
      blobs.delete(checkDigest(digest, 'blobs.remove'));
    },
  };
  const kv = {
    async get(ns, key) {
      return spaces.get(ns)?.get(key) ?? null;
    },
    async has(ns, key) {
      return spaces.get(ns)?.has(key) ?? false;
    },
    async list(ns) {
      const keys = spaces.get(ns);
      return keys === undefined ? [] : sorted(keys.keys());
    },
    async put(ns, key, value) {
      space(ns).set(key, String(value));
    },
    async remove(ns, key) {
      spaces.get(ns)?.delete(key);
    },
    async create(ns, key, value) {
      const keys = space(ns);
      if (keys.has(key)) throw eexist(`${ns}/${key}`);
      keys.set(key, String(value));
    },
  };
  const recordStore = {
    async get(id) {
      const stored = records.get(id);
      if (stored === undefined) return null;
      if (stored instanceof Torn) throw unreadable(id);
      return stored;
    },
    async raw(id) {
      const stored = records.get(id);
      if (stored === undefined) return null;
      return stored instanceof Torn ? stored.text : JSON.stringify(stored);
    },
    async has(id) {
      return records.has(id);
    },
    async getMany(ids) {
      const found = new Map();
      for (let i = 0; i < ids.length; i++) {
        const stored = records.get(ids[i]);
        if (stored instanceof Torn) throw unreadable(ids[i]);
        if (stored !== undefined) found.set(ids[i], stored);
      }
      return found;
    },
    // The ids sorted once per change, not per page: a copy pages a large database by the last id.
    async ids({ after = null, limit = Infinity } = {}) {
      const all = (sortedIds ??= sorted(records.keys()));
      let low = 0;
      if (after !== null) {
        let high = all.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if (all[mid] <= after) low = mid + 1;
          else high = mid;
        }
      }
      const out = [];
      for (let i = low; i < all.length && out.length < limit; i++) out.push(all[i]);
      return out;
    },
  };
  const pieceStore = {
    async get(id, name) {
      return pieces.get(id)?.get(name) ?? null;
    },
    async getMany(id, names) {
      const held = pieces.get(id);
      const found = new Map();
      if (held === undefined) return found;
      for (let i = 0; i < names.length; i++) if (held.has(names[i])) found.set(names[i], held.get(names[i]));
      return found;
    },
    async remove(id, name) {
      const held = pieces.get(id);
      if (held === undefined) return;
      held.delete(name);
      if (held.size === 0) pieces.delete(id);
    },
  };
  const tag = (name) => {
    let held = copies.get(name);
    if (held === undefined) copies.set(name, (held = new Map()));
    return held;
  };
  const copyStore = {
    async get(name, id) {
      return copies.get(name)?.get(id) ?? null;
    },
    async has(name, id) {
      return copies.get(name)?.has(id) ?? false;
    },
    async ids(name) {
      const held = copies.get(name);
      return held === undefined ? [] : sorted(held.keys());
    },
    async put(name, id, text) {
      tag(name).set(id, text);
    },
    async remove(name, id) {
      copies.get(name)?.delete(id);
    },
    async drop(name) {
      copies.delete(name);
    },
  };
  // The catalog's rows, kept as they are: no text made, none parsed.
  const catalogStore = {
    async load() {
      return catalog;
    },
    async save(indexes, stamp, { all }) {
      catalog = { indexes, stamp, rows: all() };
    },
  };
  // One write set, applied with nothing awaited in between: whole, or — a
  // write set that throws before it is applied — nothing.
  // What a write set changed, told to the instances listening (`db.changes`: a follower over the same engine) on a
  // microtask — the writer's landing never runs a listener. Every instance hears every write: the writer never
  // listens (a follower alone subscribes), so there is nothing of its own to leave out.
  const listeners = new Set();
  const announce = (ids) => {
    if (ids.length === 0 || listeners.size === 0) return;
    queueMicrotask(() => {
      for (const listener of listeners) {
        try {
          listener({ records: ids });
        } catch {
          // A listener's failure is its own.
        }
      }
    });
  };
  const changes = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const write = async (batch) => {
    if (batch.records !== undefined || batch.remove !== undefined) sortedIds = null;
    const ids = [];
    const puts = batch.kv?.put;
    if (puts !== undefined) for (let i = 0; i < puts.length; i++) space(puts[i][0]).set(puts[i][1], String(puts[i][2]));
    const rows = batch.records;
    if (rows !== undefined) {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const made = row.pieces?.put;
        if (made !== undefined) {
          let held = pieces.get(row.id);
          if (held === undefined) pieces.set(row.id, (held = new Map()));
          for (let k = 0; k < made.length; k++) held.set(made[k][0], made[k][1]);
        }
        records.set(row.id, row.stored !== undefined ? row.stored : parsed(row.text));
        ids.push(row.id);
        const dropped = row.pieces?.remove;
        if (dropped !== undefined) for (let k = 0; k < dropped.length; k++) pieces.get(row.id)?.delete(dropped[k]);
      }
    }
    const removed = batch.remove;
    if (removed !== undefined) {
      for (let i = 0; i < removed.length; i++) {
        records.delete(removed[i]);
        ids.push(removed[i]);
      }
    }
    const copied = batch.copies?.put;
    if (copied !== undefined) for (let i = 0; i < copied.length; i++) tag(copied[i][0]).set(copied[i][1], copied[i][2]);
    const removals = batch.kv?.remove;
    if (removals !== undefined) {
      for (let i = 0; i < removals.length; i++) spaces.get(removals[i][0])?.delete(removals[i][1]);
    }
    announce(ids);
  };
  // What the database holds, as JSON would (the records are objects): an estimate, with nothing to say of a quota.
  const estimate = async () => {
    let usage = 0;
    for (const keys of spaces.values()) for (const text of keys.values()) usage += text.length;
    for (const stored of records.values()) usage += JSON.stringify(stored).length;
    for (const named of pieces.values()) for (const text of named.values()) usage += text.length;
    for (const tagged of copies.values()) for (const text of tagged.values()) usage += text.length;
    for (const bytes of blobs.values()) usage += bytes.length;
    return { usage, quota: null };
  };
  return Object.freeze({
    path,
    capabilities: CAPABILITIES,
    kv,
    records: recordStore,
    pieces: pieceStore,
    copies: copyStore,
    catalog: catalogStore,
    log: logStore(),
    blobs: blobStore,
    changes,
    write,
    estimate,
    close: async () => {},
    /** How many records the database holds, tombstones included. */
    get size() {
      return records.size;
    },
  });
};

/**
 * `memoryEngine()` — the engine in memory: `open(path)` answers the same
 * database for the same path until `remove(path)`; nothing touches the disk.
 */
const memoryEngine = () => {
  const databases = new Map();
  return Object.freeze({
    name: 'memory',
    capabilities: CAPABILITIES,
    async open(path) {
      let db = databases.get(path);
      if (db === undefined) databases.set(path, (db = openDb(path)));
      return db;
    },
    async remove(path) {
      databases.delete(path);
    },
    /** The paths open through this engine. */
    get paths() {
      return sorted(databases.keys());
    },
  });
};

module.exports = { memoryEngine };
