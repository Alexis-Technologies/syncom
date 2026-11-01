'use strict';

// A database moved between engines (@alexify/syncom/engines `copyEngine`):
// every record with its pieces, every tag's copies, every kv text, the op
// log with its index — the node's identity, epoch, vector and heads — so the
// node opens on the new engine as itself and no peer bootstraps from it. Over
// CLOSED databases: both are held for the copy (the lock the database would
// take), and a target that holds anything is refused (TARGET_NOT_EMPTY). The
// log's sealed entries go as one segment; the open groups as they were.
// Requires engine.js, errors.js and lock.js only.

const { checkEngine, checkEngineDb, kvNamespace } = require('../engine.js');
const { SyncomError } = require('../errors.js');
const { acquireLock, LOCK_FILE } = require('./../lock.js');

// The kv namespaces a database writes besides a tag's (`tags/<name>/index`).
const NAMESPACES = ['', 'keys', 'blockchain', 'index', 'remote'];
const TAGS_FILE = 'tags.json';
const PENDING = '.pending';

const empty = (path) =>
  new SyncomError('TARGET_NOT_EMPTY', `copyEngine(): the target holds a database at ${path}`, { path });

// The database held the way createDatabase() holds it: the engine's lease, or the lock key.
const hold = async (db, path) => {
  if (db.capabilities.lock === 'native' && typeof db.lock === 'function') return db.lock({ mode: 'fail' });
  return acquireLock({ store: kvNamespace(db.kv, ''), path, mode: 'fail' });
};

// The tags a database holds, from tags.json (none when it does not read).
const tagNames = async (db) => {
  const text = await db.kv.get('', TAGS_FILE);
  if (text === null) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const names = [];
  const tags = parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.tags) ? parsed.tags : [];
  for (let i = 0; i < tags.length; i++) if (typeof tags[i]?.name === 'string') names.push(tags[i].name);
  return names;
};

// The pieces a stored record names: `meta.blocks[field].parts`, a name per slot (null for an inline run).
const piecesOf = (stored) => {
  const names = [];
  const blocks = stored?.meta?.blocks;
  if (blocks === null || typeof blocks !== 'object') return names;
  for (const field of Object.keys(blocks)) {
    const parts = blocks[field]?.parts;
    if (!Array.isArray(parts)) continue;
    for (let i = 0; i < parts.length; i++) if (typeof parts[i] === 'string') names.push(parts[i]);
  }
  return names;
};

/**
 * `copyEngine(from, to, { path, batch })` — the database at `path` copied
 * from one engine to another, `batch` records per write set (500). Answers
 * what was copied: `{ records, pieces, copies, kv, entries }`.
 */
const copyEngine = async (from, to, { path, batch = 500 } = {}) => {
  checkEngine(from, 'copyEngine(from)');
  checkEngine(to, 'copyEngine(to)');
  if (typeof path !== 'string' || path.length === 0) throw new TypeError('copyEngine(): path');
  if (!Number.isInteger(batch) || batch < 1) throw new TypeError('copyEngine(): batch must be a positive integer');
  const source = checkEngineDb(await from.open(path, {}), 'copyEngine(from)');
  const target = checkEngineDb(await to.open(path, {}), 'copyEngine(to)');
  const held = [];
  const counts = { records: 0, pieces: 0, copies: 0, kv: 0, entries: 0 };
  try {
    held.push(await hold(source, path));
    held.push(await hold(target, path));
    if ((await target.kv.has('', 'node.json')) || (await target.records.ids({ limit: 1 })).length > 0) {
      throw empty(path);
    }
    // The kv texts, namespace by namespace: the lock key is the holder's, not copied.
    const tags = await tagNames(source);
    const namespaces = NAMESPACES.slice();
    for (let i = 0; i < tags.length; i++) namespaces.push(`tags/${tags[i]}/index`);
    const puts = [];
    for (let i = 0; i < namespaces.length; i++) {
      const ns = namespaces[i];
      const keys = await source.kv.list(ns);
      for (let k = 0; k < keys.length; k++) {
        if (ns === '' && keys[k] === LOCK_FILE) continue;
        const value = await source.kv.get(ns, keys[k]);
        if (value !== null) puts.push([ns, keys[k], value, undefined]);
      }
    }
    if (puts.length > 0) await target.write({ kv: { put: puts } });
    counts.kv = puts.length;
    // The records with their pieces, `batch` per write set, in id order.
    let after = null;
    for (;;) {
      const ids = await source.records.ids({ after, limit: batch });
      if (ids.length === 0) break;
      const rows = [];
      for (let i = 0; i < ids.length; i++) {
        const text = await source.records.raw(ids[i]);
        if (text === null) continue;
        let stored = null;
        try {
          stored = JSON.parse(text);
        } catch {
          stored = null;
        }
        const row = { id: ids[i], text };
        const names = piecesOf(stored);
        if (names.length > 0) {
          const made = [];
          for (let k = 0; k < names.length; k++) {
            const piece = await source.pieces.get(ids[i], names[k]);
            if (piece !== null) made.push([names[k], piece]);
          }
          row.pieces = { put: made };
          counts.pieces += made.length;
        }
        rows.push(row);
      }
      await target.write({ records: rows });
      counts.records += rows.length;
      after = ids[ids.length - 1];
    }
    // A tag's copies, and the pending ones.
    const tagged = tags.slice();
    tagged.push(PENDING);
    for (let i = 0; i < tagged.length; i++) {
      const ids = await source.copies.ids(tagged[i]);
      const copied = [];
      for (let k = 0; k < ids.length; k++) {
        const text = await source.copies.get(tagged[i], ids[k]);
        if (text !== null) copied.push([tagged[i], ids[k], text]);
      }
      if (copied.length > 0) await target.write({ copies: { put: copied } });
      counts.copies += copied.length;
    }
    // The log: the sealed entries as one segment, the open groups as they were, the index last.
    const loaded = await source.log.load();
    const { index, entries, groups } = loaded;
    const sealedTo = source.log.sealedTo ?? loaded.floor - 1;
    const sealed = [];
    const open = new Map();
    for (let i = 0; i < groups.length; i++) open.set(groups[i].first, { ...groups[i], entries: [] });
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.seq <= sealedTo) sealed.push(entry);
      else {
        for (const group of open.values()) {
          if (entry.seq >= group.first && entry.seq <= group.last) group.entries.push(entry);
        }
      }
    }
    const fail = (error) => {
      throw error;
    };
    if (sealed.length > 0) {
      const first = sealed[0].seq;
      const last = sealed[sealed.length - 1].seq;
      await target.log.append(sealed, null, {
        first,
        last,
        sealedTo: first - 1,
        onFail: fail,
        entriesBetween: () => [],
      });
      await target.log.seal(sealed, first, last);
      await target.log.sealed(last);
    }
    for (const group of open.values()) {
      if (group.entries.length === 0) continue;
      const options = { first: group.first, last: group.last, sealedTo, onFail: fail, entriesBetween: () => [] };
      await target.log.append(group.entries, null, options);
    }
    if (index !== null) await target.log.saveIndex(index);
    counts.entries = entries.length;
    return counts;
  } finally {
    for (let i = held.length - 1; i >= 0; i--) await held[i].release();
    await source.close();
    await target.close();
  }
};

module.exports = { copyEngine };
