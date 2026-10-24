'use strict';

/**
 * Loro 1: one `LoroDoc`, a `LoroMap` of records, each record a nested
 * `LoroMap` (per-field merge), `hits` a `LoroCounter`; every write ends in
 * `doc.commit()`. A record reads back with `toJSON()`. A replica imports the
 * update the source exports from the replica's version — Loro's sync.
 *
 * On disk: Loro ships no storage of its own; its documentation persists a
 * document as a snapshot plus the updates since, so every committed local
 * update (`subscribeLocalUpdates`) and every imported one is appended to a
 * file, length-prefixed, and the write waits for the append. Opening reads
 * the file back with `importBatch`.
 */

const fs = require('node:fs/promises');
const { createRequire } = require('node:module');

const local = createRequire(require.resolve('../package.json'));

const frame = (bytes) => {
  const out = Buffer.allocUnsafe(4 + bytes.length);
  out.writeUInt32BE(bytes.length, 0);
  out.set(bytes, 4);
  return out;
};

const frames = (buffer) => {
  const out = [];
  for (let at = 0; at < buffer.length;) {
    const length = buffer.readUInt32BE(at);
    out.push(buffer.subarray(at + 4, at + 4 + length));
    at += 4 + length;
  }
  return out;
};

// `file` is null in memory, else a FileHandle opened for appending.
const wrap = (L, doc, file) => {
  const todos = doc.getMap('todos');
  let next = 0;
  let pending = null;
  if (file) doc.subscribeLocalUpdates((bytes) => (pending = file.appendFile(frame(bytes))));
  const commit = () => {
    doc.commit();
    const wait = pending;
    pending = null;
    return wait;
  };
  const insertOne = (record) => {
    const id = `t${next++}`;
    const map = todos.setContainer(id, new L.LoroMap());
    for (const key of Object.keys(record)) {
      if (key === 'hits') map.setContainer('hits', new L.LoroCounter()).increment(record.hits);
      else map.set(key, record[key]);
    }
    return id;
  };
  return {
    doc,
    file,
    insert: (record) => {
      const id = insertOne(record);
      const wait = commit();
      return wait ? wait.then(() => id) : id;
    },
    get: (id) => todos.get(id)?.toJSON() ?? null,
    update: (id, patch) => {
      const map = todos.get(id);
      for (const key of Object.keys(patch)) map.set(key, patch[key]);
      return commit();
    },
    inc: (id, key, by) => {
      todos.get(id).get(key).increment(by);
      return commit();
    },
    bulk: async (records) => {
      const ids = records.map(insertOne);
      await commit();
      return ids;
    },
    close: async () => {
      if (file) await file.close();
    },
    text: () => {
      const text = doc.getText('text');
      return {
        insert: (index, chars) => {
          text.insert(index, chars);
          return commit();
        },
        read: () => text.toString(),
      };
    },
  };
};

const memory = {
  variant: 'LoroDoc, a LoroMap per record',
  open: async () => {
    const L = local('loro-crdt');
    return wrap(L, new L.LoroDoc(), null);
  },
  text: (store) => store.text(),
};

const disk = {
  variant: 'updates appended to a file',
  open: async (dir) => {
    const L = local('loro-crdt');
    await fs.mkdir(dir, { recursive: true });
    const name = `${dir}/doc.loro`;
    const doc = new L.LoroDoc();
    const stored = await fs.readFile(name).catch(() => null);
    if (stored?.length) doc.importBatch(frames(stored));
    return wrap(L, doc, await fs.open(name, 'a'));
  },
};

const replicate = async (source, replica) => {
  const update = source.doc.export({ mode: 'update', from: replica.doc.oplogVersion() });
  replica.doc.import(update);
  if (replica.file) await replica.file.appendFile(frame(update));
};

module.exports = {
  id: 'loro',
  name: 'Loro',
  package: 'loro-crdt',
  url: 'https://github.com/loro-dev/loro',
  lines: {
    memory: { ...memory, openReplica: (dir) => memory.open(dir), replicate },
    disk: { ...disk, openReplica: (dir) => disk.open(dir), replicate },
  },
};
