'use strict';

/**
 * syncom, from this checkout, in two builds — what an application opens:
 *
 * - `syncom`: the pure CRDT — the core with the `text` and `sync` plugins,
 *   no signatures and no chain, record files a frame behind the log
 *   (`defer: 16`, the default): what an editor that only merges documents
 *   opens;
 * - `syncom-secure`: `@alexify/syncom/all` — every op signed with the node's
 *   Ed25519 key, every write a block of the hash-linked chain: what a node of
 *   a signed, hosted mesh opens;
 * - `syncom-edit`: the pure build, its text typed through a handle
 *   (`openText()`, what the editor binding stands on): each keystroke made at
 *   once, the handle flushed — one transaction, keystrokes that continue each
 *   other one op — and awaited every 1 024 keystrokes, so the log's cost is in
 *   the rate.
 *
 * `insert` mints the id, `update` is a `set` op of the changed fields, `inc`
 * a counter op. A field is a register or a counter, and a counter is born
 * with its first `inc()` (docs/guide/storage.md), so the record goes in
 * without `hits` and reads back with `hits: 0` until the counter exists.
 * There is no batch write, so a batch is the inserts issued at once (the
 * mutation queue runs them in order). A text is a field of a record, typed
 * into with splice(); a list is a field of a record too, edited with push(),
 * splice(), setAt() and move(). A replica dials the source over
 * tests/utils/memory-link.js — the in-process link the engine tests run on:
 * JSON across the boundary, like a wrpc client, no socket — and catches up
 * from the source's op log.
 */

const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const src = (file) => require(path.join(ROOT, 'src', file));

// Loaded on first use, like every other adapter's library, so the cold start
// counts loading syncom.
const builds = {
  pure: () => {
    const { open } = require(path.join(ROOT, 'index.js'));
    const { text } = src('text/text.js');
    const { sync } = src('sync/sync.js');
    return (options) => open({ ...options, plugins: [text, sync] });
  },
  secure: () => src('all/all.js').open,
};
const memoryFsi = () => src('memory/memory.js').memory();
const memoryLink = (unit) => {
  const { MemoryLink } = require(path.join(ROOT, 'tests', 'utils', 'memory-link.js'));
  return new MemoryLink(unit);
};

// The scenario's counter field; everything else is a register.
const withoutCounter = ({ hits, ...rest }) => rest;
const withCounter = (data) => (data ? { ...data, hits: data.hits ?? 0 } : null);

const wrap = (storage) => ({
  storage,
  insert: (record) => storage.insert(withoutCounter(record)),
  get: async (id) => withCounter(await storage.get(id)),
  update: (id, patch) => storage.update(id, patch),
  inc: (id, key, by) => storage.inc(id, key, by),
  bulk: (records) => Promise.all(records.map((record) => storage.insert(withoutCounter(record)))),
  close: () => storage.close(),
});

// A text typed through a handle: a keystroke made at once, a flush awaited every FLUSH_EVERY.
const FLUSH_EVERY = 1024;
const handleText = async (storage) => {
  const id = await storage.insert({ kind: 'text' });
  const handle = await storage.openText(id, 'body');
  let made = 0;
  const flushed = () => (++made % FLUSH_EVERY === 0 ? handle.flush() : undefined);
  return {
    insert: (index, chars) => {
      handle.insert(index, chars);
      return flushed();
    },
    delete: (index, count) => {
      handle.delete(index, count);
      return flushed();
    },
    // What the storage reads once the handle is flushed: what was logged.
    read: async () => {
      await handle.flush();
      return (await storage.get(id)).body ?? '';
    },
  };
};

const variant = (build, memory, handle = false) => {
  const options = (dir) => ({
    path: dir,
    logger: false,
    lock: false,
    ...(memory ? { fsi: memoryFsi() } : {}),
  });
  const units = new WeakMap();
  return {
    open: async (dir) => wrap(await builds[build]()(options(dir))),
    // A text is a field of a record: one record, typed into with splice() — or through a handle.
    text: async (store) => {
      if (handle) return handleText(store.storage);
      const id = await store.storage.insert({ kind: 'text' });
      return {
        insert: (index, chars) => store.storage.splice(id, 'body', index, 0, chars),
        delete: (index, count) => store.storage.splice(id, 'body', index, count, ''),
        read: async () => (await store.storage.get(id)).body ?? '',
      };
    },
    // A list is a field of a record: one record, its elements pushed in one call.
    list: async (store, initial) => {
      const { storage } = store;
      const id = await storage.insert({ kind: 'list' });
      await storage.push(id, 'items', initial);
      return {
        push: (value) => storage.push(id, 'items', [value]),
        insert: (index, value) => storage.splice(id, 'items', index, 0, [value]),
        remove: (index) => storage.splice(id, 'items', index, 1, []),
        set: (index, value) => storage.setAt(id, 'items', index, value),
        move: (from, to) => storage.move(id, 'items', from, to),
        read: async () => (await storage.get(id)).items ?? [],
      };
    },
    openReplica: async (dir, source) => {
      if (!units.has(source)) units.set(source, source.storage.sync.unit({ access: 'public' }));
      const unit = units.get(source);
      const storage = await builds[build]()({
        ...options(dir),
        sync: { connect: () => memoryLink(unit), autoStart: false },
      });
      return wrap(storage);
    },
    replicate: async (source, replica) => {
      const want = (await source.storage.list()).length;
      const seen = new Set();
      const done = new Promise((resolve) => {
        const onChange = (op) => {
          seen.add(op.id);
          if (seen.size >= want) {
            replica.storage.off('change', onChange);
            resolve();
          }
        };
        replica.storage.on('change', onChange);
      });
      await replica.storage.sync.addNode({ url: 'mem://source' });
      await replica.storage.sync.start();
      await done;
    },
  };
};

const ownVersion = () => require(path.join(ROOT, 'package.json')).version;

const adapter = (id, build, label, handle = false) => ({
  id,
  name: 'syncom',
  package: '@alexify/syncom',
  version: ownVersion,
  url: 'https://github.com/Alexis-Technologies/syncom',
  lines: {
    memory: { ...variant(build, true, handle), variant: `${label}, memory()` },
    disk: { ...variant(build, false, handle), variant: `${label}, node:fs` },
  },
});

module.exports = {
  pure: adapter('syncom', 'pure', 'core + text + sync'),
  secure: adapter('syncom-secure', 'secure', '/all: signed, chained'),
  edit: adapter('syncom-edit', 'pure', 'core + text + sync, typed through openText()', true),
};
