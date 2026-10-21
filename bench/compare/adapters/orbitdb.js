'use strict';

/**
 * OrbitDB 4: a `documents` database over Helia 6 and libp2p (the versions
 * OrbitDB 4 is built against); `put` writes a whole document by `_id`, an
 * update is `get` then `put`, `get` reads. There is no batch write, so a
 * batch is the puts issued at once; a document is replaced as a whole, so
 * the counter scenario leaves it out.
 *
 * Each store is its own libp2p node, listening on 127.0.0.1 only (TCP, noise,
 * yamux, gossipsub — no bootstrap list, no mDNS, nothing reaches past the
 * loopback). A replica is a second node that dials the first and opens the
 * database by its address — OrbitDB's replication over libp2p, which has no
 * in-process transport, so it runs over loopback TCP on both lines.
 *
 * In memory: Helia's default memory blockstore and memory heads and index.
 * On disk: a LevelDB blockstore and OrbitDB's default LevelDB storages.
 */

const path = require('node:path');

// ESM only, resolved from this directory: bench/compare/node_modules.
const load = (name) => import(name);

// A fixed `id` keeps the node's OrbitDB identity across restarts (it is
// otherwise the libp2p peer id, new every time), so the database it opens by
// name has the same address and the same writer after a restart.
const node = async (dir, memory, id = 'store') => {
  const { createLibp2p } = await load('libp2p');
  const { gossipsub } = await load('@libp2p/gossipsub');
  const { identify } = await load('@libp2p/identify');
  const { tcp } = await load('@libp2p/tcp');
  const { noise } = await load('@chainsafe/libp2p-noise');
  const { yamux } = await load('@chainsafe/libp2p-yamux');
  const { createHelia } = await load('helia');
  const { createOrbitDB } = await load('@orbitdb/core');
  const libp2p = await createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }), identify: identify() },
  });
  let blockstore;
  if (!memory) {
    const { LevelBlockstore } = await load('blockstore-level');
    blockstore = new LevelBlockstore(path.join(dir, 'blocks'));
  }
  const ipfs = await createHelia({ libp2p, ...(blockstore ? { blockstore } : {}) });
  const orbitdb = await createOrbitDB({ ipfs, id, directory: path.join(dir, 'orbitdb') });
  return { libp2p, ipfs, orbitdb };
};

const storages = async (memory) => {
  if (!memory) return {};
  const { MemoryStorage } = await load('@orbitdb/core');
  return { headsStorage: await MemoryStorage(), indexStorage: await MemoryStorage() };
};

const wrap = (peer, db) => {
  let next = 0;
  return {
    peer,
    db,
    insert: async (record) => {
      const id = `t${next++}`;
      await db.put({ _id: id, ...record });
      return id;
    },
    get: async (id) => (await db.get(id))?.value ?? null,
    update: async (id, patch) => {
      const doc = await db.get(id);
      await db.put({ ...doc.value, ...patch });
    },
    bulk: async (records) => {
      const docs = records.map((record) => ({ _id: `t${next++}`, ...record }));
      await Promise.all(docs.map((doc) => db.put(doc)));
      return docs.map((doc) => doc._id);
    },
    close: async () => {
      await db.close();
      await peer.orbitdb.stop();
      await peer.ipfs.stop();
    },
  };
};

const line = (memory, variant) => ({
  variant,
  open: async (dir) => {
    const peer = await node(dir, memory);
    const db = await peer.orbitdb.open('todos', { type: 'documents', ...(await storages(memory)) });
    return wrap(peer, db);
  },
  openReplica: async (dir) => ({ dir, close: async () => {} }),
  replicate: async (source, replica) => {
    const want = (await source.db.all()).length;
    const peer = await node(replica.dir, memory, 'replica');
    await peer.libp2p.dial(source.peer.libp2p.getMultiaddrs()[0]);
    const db = await peer.orbitdb.open(source.db.address, await storages(memory));
    await new Promise((resolve) => {
      const check = async () => {
        if ((await db.all()).length < want) return;
        db.events.off('update', check);
        resolve();
      };
      db.events.on('update', check);
      check();
    });
    Object.assign(replica, wrap(peer, db));
  },
});

module.exports = {
  id: 'orbitdb',
  name: 'OrbitDB',
  package: '@orbitdb/core',
  url: 'https://github.com/orbitdb/orbitdb',
  lines: {
    memory: line(true, 'documents, memory blockstore'),
    disk: line(false, 'documents, LevelDB'),
  },
};
