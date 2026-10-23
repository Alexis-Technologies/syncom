'use strict';

/**
 * Fireproof 0.24: a ledger of documents; `put` inserts or replaces a
 * document by `_id`, an update is `get` then `put`, `bulk` writes a batch,
 * `get` reads. Every document is stored encrypted, content-addressed in CAR
 * files, as Fireproof always does. A document is replaced as a whole, so the
 * counter scenario leaves it out; sync goes through a cloud or a self-hosted
 * gateway (`toCloud`), which has no in-process form, so the sync scenario
 * does too.
 *
 * In memory: the `memory://` store and key bag. On disk: the `file://` store
 * and key bag, both inside the run's temporary directory (never ~/.fireproof).
 */

const path = require('node:path');
const { createRequire } = require('node:module');

const local = createRequire(require.resolve('../package.json'));

let names = 0;

const FIELDS = ['title', 'done', 'priority', 'owner', 'hits'];

const plain = (doc) => {
  if (!doc) return null;
  const out = {};
  for (const key of FIELDS) out[key] = doc[key];
  return out;
};

const line = (memory, variant) => ({
  variant,
  noSync: 'syncs through a cloud or self-hosted gateway only',
  open: async (dir) => {
    const { fireproof } = await import(local.resolve('@fireproof/core'));
    const base = memory ? `memory://bench-${process.pid}` : `file://${dir}`;
    const keyBag = memory ? `memory://keybag-${process.pid}` : `file://${path.join(dir, 'keybag')}`;
    const db = fireproof(`todos${++names}`, { storeUrls: { base }, keyBag: { url: keyBag } });
    let next = 0;
    return {
      insert: async (record) => {
        const id = `t${next++}`;
        await db.put({ _id: id, ...record });
        return id;
      },
      get: async (id) => plain(await db.get(id).catch(() => null)),
      update: async (id, patch) => {
        const doc = await db.get(id);
        await db.put({ ...doc, ...patch });
      },
      bulk: async (records) => {
        const docs = records.map((record) => ({ _id: `t${next++}`, ...record }));
        await db.bulk(docs);
        return docs.map((doc) => doc._id);
      },
      close: () => db.close(),
    };
  },
});

module.exports = {
  id: 'fireproof',
  name: 'Fireproof',
  package: '@fireproof/core',
  url: 'https://github.com/fireproof-storage/fireproof',
  lines: {
    memory: line(true, 'memory:// store'),
    disk: line(false, 'file:// store'),
  },
};
