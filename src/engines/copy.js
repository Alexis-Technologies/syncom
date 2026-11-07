'use strict';

// A database moved between engines (@alexify/syncom/engines `copyEngine`):
// every record with its pieces, every tag's copies, every kv text, the op
// log with its index — the node's identity, epoch, vector and heads — so the
// node opens on the new engine as itself and no peer bootstraps from it. Over
// CLOSED databases: both are held for the copy (the lock the database would
// take; a lease lost on the way fails it), and a target that holds anything
// is refused (TARGET_NOT_EMPTY). The identity — node.json, the keys — lands
// LAST, so a copy cut short is no node of that name, and a copy that fails
// takes what it wrote away again. The log's sealed entries go as one
// segment, `batch` entries a group; the open groups as they were. Requires
// engine.js, errors.js, lock.js and crypto/keys.js (the keys' file mode) only. A
// target without a blobs store while the source holds blobs is refused
// (BLOBS_UNSUPPORTED) before anything is written.

const { checkEngine, checkEngineDb, kvNamespace, KV_NAMESPACES } = require('../engine.js');
const { KEY_FILE_MODE } = require('../crypto/keys.js');
const { SyncomError } = require('../errors.js');
const { acquireLock, LOCK_FILE } = require('./../lock.js');

const NODE_FILE = 'node.json';
const KEYS = 'keys';
const TAGS_FILE = 'tags.json';
const PENDING = '.pending';

const empty = (path) =>
  new SyncomError('TARGET_NOT_EMPTY', `copyEngine(): the target holds a database at ${path}`, { path });
const noBlobs = (engine, blobs) =>
  new SyncomError(
    'BLOBS_UNSUPPORTED',
    `copyEngine(): the ${engine} engine has no blobs store, and the source holds ${blobs} blob(s)`,
    { engine, blobs },
  );
const lost = (path, cause) =>
  new SyncomError('LEASE_LOST', `copyEngine(): the lease on ${path} was lost during the copy`, { path, cause });

// The database held the way createDatabase() holds it: the engine's lease, or the lock key.
const hold = async (db, path, onLost) => {
  if (db.capabilities.lock === 'native' && typeof db.lock === 'function') return db.lock({ mode: 'fail', onLost });
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

// The kv texts of `ns`, as puts: the lock key is the holder's, the identity is kept for last.
const kvPuts = async (source, ns, { identity }) => {
  const puts = [];
  const keys = await source.kv.list(ns);
  for (let k = 0; k < keys.length; k++) {
    const key = keys[k];
    if (ns === '' && (key === LOCK_FILE || (key === NODE_FILE) !== identity)) continue;
    const value = await source.kv.get(ns, key);
    if (value === null) continue;
    puts.push([ns, key, value, ns === KEYS ? { mode: KEY_FILE_MODE } : undefined]);
  }
  return puts;
};

/**
 * `copyEngine(from, to, { path, targetPath, batch })` — the database at `path` copied
 * from one engine to another (at `targetPath` there, `path` by default), `batch` records (or log entries) per write set
 * (500). Answers what was copied: `{ records, pieces, copies, kv, entries, blobs }`.
 */
const copyEngine = async (from, to, { path, targetPath = path, batch = 500 } = {}) => {
  checkEngine(from, 'copyEngine(from)');
  checkEngine(to, 'copyEngine(to)');
  if (typeof path !== 'string' || path.length === 0) throw new TypeError('copyEngine(): path');
  if (typeof targetPath !== 'string' || targetPath.length === 0) throw new TypeError('copyEngine(): targetPath');
  if (from === to && targetPath === path) {
    throw new TypeError('copyEngine(): the target is the source — another engine, or targetPath');
  }
  if (!Number.isInteger(batch) || batch < 1) throw new TypeError('copyEngine(): batch must be a positive integer');
  const source = checkEngineDb(await from.open(path, {}), 'copyEngine(from)');
  const target = checkEngineDb(await to.open(targetPath, {}), 'copyEngine(to)');
  const held = [];
  const counts = { records: 0, pieces: 0, copies: 0, kv: 0, entries: 0, blobs: 0 };
  // A lease that goes while the copy runs: the next write set fails, nothing lands over another holder's.
  let gone = null;
  const onLost = (cause) => {
    gone ??= cause;
  };
  const check = () => {
    if (gone !== null) throw lost(path, gone);
  };
  const write = async (set) => {
    check();
    await target.write(set);
  };
  let written = false;
  try {
    held.push(await hold(source, path, onLost));
    held.push(await hold(target, targetPath, onLost));
    if ((await target.kv.has('', NODE_FILE)) || (await target.records.ids({ limit: 1 })).length > 0) {
      throw empty(targetPath);
    }
    // A target that cannot keep the attachments' bytes the source holds: refused before anything is written —
    // a copy that silently lost every blob would leave the registers naming bytes nowhere.
    if (source.blobs !== undefined && target.blobs === undefined) {
      const held = (await source.blobs.list()).length;
      if (held > 0) throw noBlobs(to.name, held);
    }
    written = true;
    // The kv texts, namespace by namespace — the identity (node.json, the keys) last of all.
    const tags = await tagNames(source);
    const namespaces = [];
    for (let i = 0; i < KV_NAMESPACES.length; i++) if (KV_NAMESPACES[i] !== KEYS) namespaces.push(KV_NAMESPACES[i]);
    for (let i = 0; i < tags.length; i++) namespaces.push(`tags/${tags[i]}/index`);
    for (let i = 0; i < namespaces.length; i++) {
      const puts = await kvPuts(source, namespaces[i], { identity: false });
      if (puts.length > 0) await write({ kv: { put: puts } });
      counts.kv += puts.length;
    }
    // The attachments' blobs, where both engines keep them: one by one, by digest.
    if (source.blobs !== undefined && target.blobs !== undefined) {
      const digests = await source.blobs.list();
      for (let i = 0; i < digests.length; i++) {
        check();
        const bytes = await source.blobs.get(digests[i]);
        if (bytes === null) continue;
        await target.blobs.put(digests[i], bytes);
        counts.blobs++;
      }
    }
    // The records with their pieces, `batch` per write set, in id order.
    let after = null;
    for (;;) {
      const ids = await source.records.ids({ after, limit: batch });
      if (ids.length === 0) break;
      // The page's records in one read; a record the medium holds that is no record (INTEGRITY) goes as its text, as
      // it is — a copy carries what it finds — read one by one then.
      let found = null;
      try {
        found = await source.records.getMany(ids);
      } catch (error) {
        if (error?.code !== 'INTEGRITY') throw error;
      }
      const rows = [];
      for (let i = 0; i < ids.length; i++) {
        let row;
        let stored = null;
        if (found !== null) {
          stored = found.get(ids[i]) ?? null;
          if (stored === null) continue;
          row = { id: ids[i], stored };
        } else {
          const text = await source.records.raw(ids[i]);
          if (text === null) continue;
          try {
            stored = JSON.parse(text);
          } catch {
            stored = null;
          }
          row = { id: ids[i], text };
        }
        const names = piecesOf(stored);
        if (names.length > 0) {
          const pieces = await source.pieces.getMany(ids[i], names);
          const made = [];
          for (let k = 0; k < names.length; k++) {
            const piece = pieces.get(names[k]);
            if (piece !== undefined) made.push([names[k], piece]);
          }
          row.pieces = { put: made };
          counts.pieces += made.length;
        }
        rows.push(row);
      }
      await write({ records: rows });
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
      if (copied.length > 0) await write({ copies: { put: copied } });
      counts.copies += copied.length;
    }
    // The log: the sealed entries as one segment (a group of `batch` at a time), the open groups as they were, the index last.
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
    const append = async (page, sealedBelow) => {
      check();
      const options = {
        first: page[0].seq,
        last: page[page.length - 1].seq,
        sealedTo: sealedBelow,
        onFail: fail,
        entriesBetween: () => [],
      };
      await target.log.append(page, null, options);
    };
    if (sealed.length > 0) {
      const first = sealed[0].seq;
      const last = sealed[sealed.length - 1].seq;
      for (let i = 0; i < sealed.length; i += batch) await append(sealed.slice(i, i + batch), first - 1);
      check();
      await target.log.seal(sealed, first, last);
      await target.log.sealed(last);
    }
    for (const group of open.values()) {
      if (group.entries.length > 0) await append(group.entries, sealedTo);
    }
    check();
    if (index !== null) await target.log.saveIndex(index);
    counts.entries = entries.length;
    // The identity last: the keys, then node.json — a node of that name only once it is whole.
    const keys = await kvPuts(source, KEYS, { identity: false });
    if (keys.length > 0) await write({ kv: { put: keys } });
    const identity = await kvPuts(source, '', { identity: true });
    if (identity.length > 0) await write({ kv: { put: identity } });
    counts.kv += keys.length + identity.length;
    written = false;
    return counts;
  } finally {
    for (let i = held.length - 1; i >= 0; i--) await held[i].release();
    await source.close();
    await target.close();
    // A copy that failed takes what it wrote away: the target was empty, and a retry finds it so.
    if (written) await to.remove(targetPath);
  }
};

module.exports = { copyEngine };
