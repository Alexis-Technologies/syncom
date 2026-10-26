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
 *   a signed, hosted mesh opens.
 *
 * `insert` mints the id, `update` is a `set` op of the changed fields, `inc`
 * a counter op. A field is a register or a counter, and a counter is born
 * with its first `inc()` (docs/guide/storage.md), so the record goes in
 * without `hits` and reads back with `hits: 0` until the counter exists.
 * There is no batch write, so a batch is the inserts issued at once (the
 * mutation queue runs them in order). A text is a field of a record, typed
 * into with splice(). A replica dials the source over
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

const variant = (build, memory) => {
  const options = (dir) => ({
    path: dir,
    logger: false,
    lock: false,
    ...(memory ? { fsi: memoryFsi() } : {}),
  });
  const units = new WeakMap();
  return {
    open: async (dir) => wrap(await builds[build]()(options(dir))),
    // A text is a field of a record: one record, typed into with splice().
    text: async (store) => {
      const id = await store.storage.insert({ kind: 'text' });
      return {
        insert: (index, chars) => store.storage.splice(id, 'body', index, 0, chars),
        delete: (index, count) => store.storage.splice(id, 'body', index, count, ''),
        read: async () => (await store.storage.get(id)).body ?? '',
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

const adapter = (id, build, label) => ({
  id,
  name: 'syncom',
  package: '@alexify/syncom',
  version: ownVersion,
  url: 'https://github.com/Alexis-Technologies/syncom',
  lines: {
    memory: { ...variant(build, true), variant: `${label}, memory()` },
    disk: { ...variant(build, false), variant: `${label}, node:fs` },
  },
});

module.exports = {
  pure: adapter('syncom', 'pure', 'core + text + sync'),
  secure: adapter('syncom-secure', 'secure', '/all: signed, chained'),
};
