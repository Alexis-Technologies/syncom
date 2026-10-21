'use strict';

/**
 * syncom, from this checkout. `insert` mints the id, `update` is a `set` op
 * of the changed fields, `inc` a counter op. A field is a register or a
 * counter, and a counter is born with its first `inc()` (docs/guide/storage.md),
 * so the record goes in without `hits` and reads back with `hits: 0` until
 * the counter exists. There is no batch write, so a
 * batch is the inserts issued at once (the mutation queue runs them in
 * order). A replica dials the source over tests/utils/memory-link.js — the
 * in-process link the engine tests run on: JSON across the boundary, like a
 * wrpc client, no socket — and catches up from the source's op log.
 *
 * Two variants: the default (the hash-linked chain on) and `chain: false`,
 * what a node that only replicates can run.
 */

const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');

// Loaded on first use, like every other adapter's library, so the cold start
// counts loading syncom.
const engine = () => require(path.join(ROOT, 'index.js'));
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

const variant = (chain, memory) => {
  const options = (dir) => ({
    path: dir,
    chain,
    logger: false,
    lock: false,
    ...(memory ? { fsi: engine().createMemoryFsi() } : {}),
  });
  const units = new WeakMap();
  return {
    open: async (dir) => wrap(await engine().open(options(dir))),
    openReplica: async (dir, source) => {
      if (!units.has(source)) units.set(source, source.storage.sync.unit({ access: 'public' }));
      const unit = units.get(source);
      const storage = await engine().open({
        ...options(dir),
        sync: { connect: () => memoryLink(unit), autoStart: false },
      });
      return wrap(storage);
    },
    replicate: async (source, replica) => {
      const want = source.storage.list ? (await source.storage.list()).length : 0;
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

const adapter = (id, chain, label) => ({
  id,
  name: 'syncom',
  package: '@alexify/syncom',
  version: ownVersion,
  url: 'https://github.com/Alexis-Technologies/syncom',
  lines: {
    memory: { ...variant(chain, true), variant: `${label}, createMemoryFsi()` },
    disk: { ...variant(chain, false), variant: `${label}, node:fs` },
  },
});

module.exports = {
  chained: adapter('syncom', true, 'default'),
  unchained: adapter('syncom-nochain', false, 'chain: false'),
};
