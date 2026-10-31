'use strict';

/**
 * Automerge 3: one document, `todos` a map of records, every write an
 * `Automerge.change`. `hits` is an `Automerge.Counter`, the type whose
 * concurrent increments add up. A record reads back as a copy of its map,
 * the counter as its value.
 *
 * In memory: the bare document, and a replica syncs through the sync
 * protocol (`generateSyncMessage` / `receiveSyncMessage` until neither side
 * has anything to say) — what a network sync runs.
 *
 * On disk: automerge-repo, the official repository, over its NodeFS storage
 * adapter, every write followed by `repo.flush()` so the change is on disk
 * before the call returns. A replica is a second repository on a
 * MessageChannel to the first, the repo's own sync, flushed when every record
 * has arrived.
 *
 * A list is an Automerge list: push, splice and an assignment by index (an
 * element of its own); it has no move, so that scenario leaves it out.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');

const local = createRequire(require.resolve('../package.json'));

const readRecord = (record) => (record ? { ...record, hits: record.hits?.value ?? record.hits } : null);

const toRecord = (A, record) => ({ ...record, hits: new A.Counter(record.hits) });

// A store over a document `state` that `apply(fn)` changes and `persist()`
// makes durable.
const wrap = (A, state) => {
  let next = 0;
  return {
    state,
    insert: async (record) => {
      const id = `t${next++}`;
      await state.change((doc) => (doc.todos[id] = toRecord(A, record)));
      return id;
    },
    get: (id) => readRecord(state.doc().todos[id]),
    update: (id, patch) => state.change((doc) => Object.assign(doc.todos[id], patch)),
    inc: (id, key, by) => state.change((doc) => doc.todos[id][key].increment(by)),
    bulk: async (records) => {
      const ids = records.map(() => `t${next++}`);
      await state.change((doc) => {
        for (let i = 0; i < records.length; i++) doc.todos[ids[i]] = toRecord(A, records[i]);
      });
      return ids;
    },
    close: () => state.close(),
    list: async (initial, name = 'list') => {
      await state.change((doc) => {
        doc[name] = initial.slice();
      });
      return {
        push: (value) => state.change((doc) => doc[name].push(value)),
        insert: (index, value) => state.change((doc) => doc[name].splice(index, 0, value)),
        remove: (index) => state.change((doc) => doc[name].splice(index, 1)),
        set: (index, value) =>
          state.change((doc) => {
            doc[name][index] = value;
          }),
        read: () => state.doc()[name],
      };
    },
    text: async (name = 'text') => {
      await state.change((doc) => {
        doc[name] = '';
      });
      return {
        insert: (index, chars) => state.change((doc) => A.splice(doc, [name], index, 0, chars)),
        delete: (index, count) => state.change((doc) => A.splice(doc, [name], index, count)),
        read: () => state.doc()[name],
      };
    },
  };
};

const memoryState = (A, initial) => {
  let doc = initial ?? A.from({ todos: {} });
  return {
    doc: () => doc,
    set: (next) => (doc = next),
    change: (fn) => {
      doc = A.change(doc, fn);
    },
    close: async () => {},
  };
};

const memory = {
  variant: 'Automerge.change, Counter',
  open: async () => {
    const A = local('@automerge/automerge');
    return wrap(A, memoryState(A));
  },
  text: (store, name) => store.text(name),
  list: (store, initial) => store.list(initial),
  openReplica: async () => {
    const A = local('@automerge/automerge');
    return wrap(A, memoryState(A, A.init()));
  },
  replicate: async (source, replica) => {
    const A = local('@automerge/automerge');
    let fromSource = A.initSyncState();
    let fromReplica = A.initSyncState();
    let a = source.state.doc();
    let b = replica.state.doc();
    for (;;) {
      let message;
      let moved = false;
      [fromSource, message] = A.generateSyncMessage(a, fromSource);
      if (message) {
        [b, fromReplica] = A.receiveSyncMessage(b, fromReplica, message);
        moved = true;
      }
      [fromReplica, message] = A.generateSyncMessage(b, fromReplica);
      if (message) {
        [a, fromSource] = A.receiveSyncMessage(a, fromSource, message);
        moved = true;
      }
      if (!moved) break;
    }
    source.state.set(a);
    replica.state.set(b);
  },
};

// The document's URL is kept next to the repository, so a restart finds the
// same document (repo.create would start a new one).
const repoState = async (dir, { url, network } = {}) => {
  const { Repo } = await import(local.resolve('@automerge/automerge-repo'));
  const { NodeFSStorageAdapter } = await import(local.resolve('@automerge/automerge-repo-storage-nodefs'));
  const repo = new Repo({
    storage: new NodeFSStorageAdapter(dir),
    network: network ? [network] : [],
    sharePolicy: async () => true,
  });
  const file = path.join(dir, 'document-url');
  const known = url ?? (await fs.readFile(file, 'utf8').catch(() => null));
  const handle = known ? await repo.find(known) : repo.create({ todos: {} });
  if (!known) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, handle.url);
  }
  return {
    repo,
    handle,
    doc: () => handle.doc(),
    change: async (fn) => {
      handle.change(fn);
      await repo.flush();
    },
    close: () => repo.shutdown(),
  };
};

// automerge-repo is ESM and loads Automerge's ESM build, whose Counter is
// not the CommonJS build's: the counters it writes must come from the repo.
const repoAutomerge = async () => import(local.resolve('@automerge/automerge-repo'));

const disk = {
  variant: 'automerge-repo, NodeFS storage',
  text: (store, name) => store.text(name),
  list: (store, initial) => store.list(initial),
  open: async (dir) => wrap(await repoAutomerge(), await repoState(dir)),
  openReplica: async (dir, source) => {
    const { MessageChannelNetworkAdapter } = await import(
      local.resolve('@automerge/automerge-repo-network-messagechannel')
    );
    const { port1, port2 } = new MessageChannel();
    source.state.repo.networkSubsystem.addNetworkAdapter(new MessageChannelNetworkAdapter(port1));
    const replica = { dir, port: port2, url: source.state.handle.url };
    replica.close = async () => {
      await replica.store?.close();
      port1.close();
    };
    return replica;
  },
  replicate: async (source, replica) => {
    const { MessageChannelNetworkAdapter } = await import(
      local.resolve('@automerge/automerge-repo-network-messagechannel')
    );
    const want = Object.keys(source.state.doc().todos).length;
    const state = await repoState(replica.dir, {
      url: replica.url,
      network: new MessageChannelNetworkAdapter(replica.port),
    });
    while (Object.keys(state.doc().todos).length < want) {
      await new Promise((resolve) => state.handle.once('change', resolve));
    }
    await state.repo.flush();
    replica.store = wrap(await repoAutomerge(), state);
    replica.get = (id) => replica.store.get(id);
  },
};

module.exports = {
  id: 'automerge',
  name: 'Automerge',
  package: '@automerge/automerge',
  url: 'https://github.com/automerge/automerge',
  lines: { memory, disk },
};
